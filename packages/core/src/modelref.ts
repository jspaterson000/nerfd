import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { canonicalProviderId, isPlanProvider, LOCAL_PROVIDERS, lookupModel, provider as catalogProvider } from './catalog.ts';

/**
 * "Which model" is not one string. Kimi K2.7-code on OpenRouter is served at
 * fp4 by one host and int4 by another; a local Qwen at q4_K_M is not the Qwen
 * on Cerebras. Averaging those together produces a number about nothing. So
 * every session carries a ModelRef: weights, size, quantisation, who served
 * it, how it was paid for, and whether the weights were modified.
 */
export interface ModelRef {
  raw_id: string | null;       // exactly what the tool reported
  raw_provider: string | null; // the tool's own provider id, local-only for custom providers
  family: string | null;       // normalised weights family: qwen3-coder, kimi, claude-opus
  version: string | null;      // release or date tag: 2507, k2.7-code, 5
  size: string | null;         // parameter count where public: 480B-A35B, 27B
  quant: string;               // fp8, int4, q4_K_M, awq-int4, or 'unknown'. never null
  provider: string | null;     // who served it
  // 'router' is a fourth answer to "what model was this": nobody knows. An
  // auto-routing id picks a different model per request, so it carries no
  // family and never lands in a family row.
  serving_mode: 'hosted' | 'plan' | 'local' | 'router';
  variant: string | null;      // router variant: nitro, floor
  modified: boolean;           // abliterated, uncensored, merged, fine-tuned
}

export const SERVING_MODES = ['hosted', 'plan', 'local', 'router'] as const;

export function emptyModelRef(): ModelRef {
  return {
    raw_id: null, raw_provider: null, family: null, version: null, size: null,
    quant: 'unknown', provider: null, serving_mode: 'hosted', variant: null, modified: false,
  };
}

export interface ResolveContext {
  baseUrl?: string;          // the endpoint the tool was pointed at, if it says
  declaredName?: string;     // the human-readable name from the user's own config
  toolProviderType?: string; // the tool's provider *type* (openai-compatible, ollama, anthropic)
}

// ---- user declarations --------------------------------------------------
// `nerfd model-info <raw_id> --family ... --quant ...` for anything the
// catalogue, the family table and the name parser cannot resolve. The CLI
// loads ~/.nerfd/models.json and registers it here; core never reads $HOME.

let declarations: Record<string, Partial<ModelRef>> = {};

export function registerModelDeclarations(d: Record<string, Partial<ModelRef>> | null | undefined): void {
  declarations = d ?? {};
}

export function modelDeclarations(): Record<string, Partial<ModelRef>> {
  return declarations;
}

// ---- family table -------------------------------------------------------

export interface FamilyVersion { version: string; patterns: string[]; sizes?: string[]; released?: string }
export interface FamilyDef {
  family: string;
  vendor?: string;
  display?: string;
  open_weights?: boolean;
  patterns: string[];
  versions?: FamilyVersion[];
  aliases?: Record<string, Partial<ModelRef>>;
  size_patterns?: Record<string, string>; // pattern -> canonical size, e.g. "-flash": "30B-A3B"
}

let families: FamilyDef[] | null = null;

export function registerFamilyTable(snapshot: FamilyDef[]): void { families = snapshot; }

export function familyTable(): FamilyDef[] {
  if (families) return families;
  try {
    const raw = JSON.parse(readFileSync(new URL('../data/model-families.json', import.meta.url), 'utf8')) as { families?: FamilyDef[] };
    families = (raw.families ?? []).filter((f) => f && typeof f.family === 'string' && Array.isArray(f.patterns));
  } catch {
    families = [];
  }
  return families;
}

const reCache = new Map<string, RegExp | null>();

function re(pattern: string): RegExp | null {
  if (reCache.has(pattern)) return reCache.get(pattern)!;
  let r: RegExp | null = null;
  try { r = new RegExp(pattern, 'i'); } catch { r = null; } // a bad pattern in the data file must not break capture
  reCache.set(pattern, r);
  return r;
}

const matches = (patterns: string[] | undefined, hay: string) =>
  (patterns ?? []).some((p) => { const r = re(p); return r ? r.test(hay) : false; });

// ---- name parsing -------------------------------------------------------

// Ordered longest-first so mxfp4 is not read as fp4.
const PRECISION_RE = /(?<![a-z0-9])(mxfp4|nf4|bf16|fp16|fp8|fp4|int8|int4|uint8|w8a8|w4a16|[48][-_ ]?bit)(?![a-z0-9])/i;
const GGUF_RE = /(?<![a-z0-9])(i?q\d(?:[_-][0-9a-z]+)+)(?![a-z0-9])/i;
const METHOD_RE = /(?<![a-z0-9])(awq|gptq|aqlm|exl2|hqq)(?![a-z0-9])/i;
const MODIFIED_RE = /(?<![a-z0-9])(abliterated|uncensored|heretic|decensored|merged?|finetuned?|fine[-_]tuned?|qlora|lora|sft|dpo)(?![a-z0-9])/i;
// 30B-A3B and 480B-A35B are MoE: total parameters and active parameters.
const MOE_SIZE_RE = /(?<![a-z0-9.])(\d{1,4}(?:\.\d+)?)\s?b[-_ ]?a(\d{1,3}(?:\.\d+)?)\s?b(?![a-z0-9])/i;
const SIZE_RE = /(?<![a-z0-9.])(\d{1,4}(?:\.\d+)?)\s?b(?![a-z0-9])/i;

/** GGUF tags are conventionally q<bits>_<K|0|S|M|L>: q4_K_M, q8_0, iq4_XS. */
function normaliseGguf(tag: string): string {
  const parts = tag.replace(/-/g, '_').split('_');
  return [parts[0]!.toLowerCase(), ...parts.slice(1).map((p) => p.toUpperCase())].join('_');
}

function normalisePrecision(tok: string): string {
  const t = tok.toLowerCase().replace(/[-_ ]/g, '');
  if (t === '4bit') return 'int4';
  if (t === '8bit') return 'int8';
  return t;
}

/** fp8, int4, q4_K_M, awq-int4, or 'unknown'. Method and precision combine. */
export function parseQuant(text: string): string {
  const method = METHOD_RE.exec(text)?.[1]?.toLowerCase() ?? null;
  const gguf = GGUF_RE.exec(text)?.[1] ?? null;
  const precision = gguf ? normaliseGguf(gguf) : (PRECISION_RE.exec(text)?.[1] ? normalisePrecision(PRECISION_RE.exec(text)![1]!) : null);
  const parts = [method, precision].filter((x): x is string => x != null);
  return parts.length ? parts.join('-') : 'unknown';
}

/** 480B-A35B, 30B-A3B, 27B, or null. */
export function parseSize(text: string): string | null {
  const moe = MOE_SIZE_RE.exec(text);
  if (moe) return `${moe[1]!.toUpperCase()}B-A${moe[2]!.toUpperCase()}B`;
  const one = SIZE_RE.exec(text);
  return one ? `${one[1]!.toUpperCase()}B` : null;
}

/** Abliterated, uncensored, merged or fine-tuned weights are not the family. */
export function parseModified(text: string): boolean {
  return MODIFIED_RE.test(text);
}

// Auto-routing ids: openrouter/auto, azure model-router, Gemini CLI's "auto".
// The router picks a different model per request, so the id names a service,
// not a model.
const ROUTER_FAMILIES = new Set(['openrouter-auto']);
const ROUTER_RE = /(?:^|\/)(auto|auto-beta|auto-model|fusion|pareto-code|model-router|bodybuilder)$/i;

export function isRouterId(id: string | null | undefined, family: string | null = null): boolean {
  if (family && ROUTER_FAMILIES.has(family)) return true;
  return id != null && ROUTER_RE.test(id.trim());
}

// ---- provider inference -------------------------------------------------

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

export function isLocalBaseUrl(baseUrl: string | null | undefined): boolean {
  const u = parseUrl(baseUrl);
  return u ? PRIVATE_HOST_RE.test(u.hostname) : false;
}

function parseUrl(baseUrl: string | null | undefined): URL | null {
  if (!baseUrl) return null;
  try { return new URL(/^[a-z]+:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`); } catch { return null; }
}

/** Port heuristics for a local OpenAI-compatible endpoint. */
export function localProviderFromUrl(baseUrl: string | null | undefined): string {
  const u = parseUrl(baseUrl);
  const port = u?.port ?? '';
  if (port === '11434') return 'ollama';
  if (port === '1234') return 'lmstudio';
  if (port === '8080') return 'llama.cpp';
  if (port === '8000') return 'vllm';
  return 'local-openai-compatible';
}

/** An Ollama tag (`:30b-a3b-q4_K_M`, `:latest`) rather than a router variant (`:nitro`). */
function looksLikeOllamaTag(tag: string): boolean {
  if (/^latest$/i.test(tag)) return true;
  return GGUF_RE.test(tag) || PRECISION_RE.test(tag) || SIZE_RE.test(tag) || MOE_SIZE_RE.test(tag) || /^(instruct|base|chat|text|thinking)$/i.test(tag);
}

// ---- resolution ---------------------------------------------------------

/**
 * Best evidence first: the catalogue, then our family table, then the name,
 * then what the endpoint implies. A user declaration beats all of them,
 * because the person running the model knows what it is.
 */
export function resolveModelRef(rawId: string | null | undefined, rawProvider: string | null | undefined, ctx: ResolveContext = {}): ModelRef {
  const raw = (rawId ?? '').trim();
  const ref = emptyModelRef();
  ref.raw_id = raw || null;
  ref.raw_provider = (rawProvider ?? '').trim() || null;
  if (!raw) return applyDeclarations(ref);

  // Context-window suffixes ride along on the id: claude-fable-5-1[1m]. They
  // are not part of the model name, but they are part of what was bought, so
  // they stay in raw_id and in the text the family table sees.
  let id = raw.replace(/\s*\[[^\]]{1,16}\]\s*$/, '');
  let hint = ref.raw_provider ? ref.raw_provider.toLowerCase() : null;
  let tag: string | null = null;

  // A trailing `:x` is either an Ollama tag (size and quant) or a router variant.
  const colon = id.lastIndexOf(':');
  if (colon > 0) {
    const t = id.slice(colon + 1);
    const head = id.slice(0, colon);
    if (hint === 'ollama' || ctx.toolProviderType === 'ollama' || looksLikeOllamaTag(t)) { tag = t; id = head; }
    else { ref.variant = t.toLowerCase(); id = head; }
  }

  // Only OpenRouter sells routing variants, so a variant names the router.
  if (ref.variant && !hint) hint = 'openrouter';

  // `openrouter/org/model` or `deepseek/deepseek-v4-pro` — the tool prefixed
  // its own provider id onto the model id.
  const slash = /^([a-z0-9][a-z0-9._-]*)\/(.+)$/i.exec(id);
  if (slash && /^openrouter$/i.test(slash[1]!)) {
    hint = 'openrouter';
    id = slash[2]!;
  } else if (slash && !hint && catalogProvider(slash[1]!) && lookupModel(slash[1]!, slash[2]!)) {
    hint = slash[1]!.toLowerCase();
    id = slash[2]!;
  }

  // --- who served it, and how it was paid for
  const canonical = canonicalProviderId(hint);
  const localHint = canonical != null && LOCAL_PROVIDERS.has(canonical);
  const localType = ctx.toolProviderType != null && LOCAL_PROVIDERS.has(ctx.toolProviderType.toLowerCase());
  if (tag != null && !canonical) {
    ref.provider = 'ollama';
    ref.serving_mode = 'local';
  } else if (localHint || localType) {
    const named = canonical ?? ctx.toolProviderType!.toLowerCase();
    // 'local' says nothing about which runtime; the port does.
    ref.provider = named === 'local' || named === 'local-openai-compatible' ? localProviderFromUrl(ctx.baseUrl) : named;
    ref.serving_mode = 'local';
  } else if (isLocalBaseUrl(ctx.baseUrl)) {
    ref.provider = localProviderFromUrl(ctx.baseUrl);
    ref.serving_mode = 'local';
  } else if (canonical && catalogProvider(canonical)) {
    ref.provider = canonical;
    ref.serving_mode = isPlanProvider(canonical) ? 'plan' : 'hosted';
  } else if (ctx.baseUrl) {
    // A base URL the user configured that is not a catalogue provider is the
    // user serving their own weights: billed by the hour, not the token.
    ref.provider = 'self-hosted';
    ref.serving_mode = 'local';
  } else if (canonical) {
    ref.provider = canonical;
  }

  // --- (a) catalogue
  const hit = lookupModel(ref.provider ?? hint, id);
  if (hit) {
    if (hit.model.family) ref.family = hit.model.family;
    if (!ref.provider) {
      ref.provider = hit.provider_id;
      ref.serving_mode = isPlanProvider(hit.provider_id) ? 'plan' : 'hosted';
    } else if (ref.serving_mode === 'hosted' && ref.provider === hit.provider_id && isPlanProvider(hit.provider_id)) {
      ref.serving_mode = 'plan';
    }
  }

  // --- (b) family table. models.dev's family is coarse ('qwen'); ours is the
  // one the board groups by, so it refines the catalogue rather than filling in.
  // Patterns are written against both shapes: some anchor on ^, some on the
  // provider prefix, so both the full id and the stripped id are offered.
  const hay = [raw, id, tag ?? '', ctx.declaredName ?? ''].join(' ');
  const def = familyTable().find((f) => matches(f.patterns, hay));
  if (def) {
    ref.family = def.family;
    const alias = def.aliases?.[id.toLowerCase()] ?? def.aliases?.[id.slice(id.lastIndexOf('/') + 1).toLowerCase()];
    const version = pickVersion(def, hay);
    ref.version = alias?.version ?? version?.version ?? null;
    // Most specific evidence first. An alias size is the default for a bare
    // id ("qwen3-coder" means the 480B), so a size written in the id or the
    // tag has to beat it: `qwen3-coder:30b-a3b` is not the 480B. For closed
    // models `size` is a product tier ('pro', 'flash', '1m-context'), not a
    // parameter count, and is never formatted as one.
    ref.size =
      sizeFromPatterns(def, hay)
      ?? parseSize(hay)
      ?? (version?.sizes ?? []).find((sz) => hay.toLowerCase().includes(sz.toLowerCase()))
      ?? alias?.size
      ?? null;
    if (alias) for (const [k, v] of Object.entries(alias)) {
      if (v != null && k !== 'version' && k !== 'size') (ref as unknown as Record<string, unknown>)[k] = v;
    }
  }

  // A router id has no model identity: family null, so it can never dilute a
  // family row on the board.
  if (isRouterId(raw, ref.family) || isRouterId(id, ref.family)) {
    ref.family = null;
    ref.version = null;
    ref.size = null;
    ref.serving_mode = 'router';
    return applyDeclarations(ref);
  }

  // --- (c) the name itself: quant, size, modification markers
  ref.quant = parseQuant(hay);
  ref.size = ref.size ?? parseSize(hay);
  ref.modified = parseModified(hay);
  ref.version = ref.version ?? versionFrom(id, ref.family, ref.size);
  return applyDeclarations(ref);
}

const VERSION_NOISE_RE = /(?<![a-z0-9])(instruct|instruction|chat|base|it|gguf|mlx|awq|gptq|abliterated|uncensored|heretic|merged?|finetuned?|lora|q\d[_-][0-9a-z_-]+|fp\d+|int\d|bf16|nf4)(?![a-z0-9])/gi;

/**
 * Several version patterns can match one id (`m2` also matches `m2.7`). The
 * release date decides, not the order of the list or the length of the
 * string, so a newer release always wins.
 */
function pickVersion(def: FamilyDef, hay: string): FamilyVersion | null {
  const hits = (def.versions ?? []).filter((v) => matches(v.patterns, hay));
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => ((b.released ?? '') > (a.released ?? '') ? b : a));
}

function sizeFromPatterns(def: FamilyDef, hay: string): string | null {
  for (const [pattern, size] of Object.entries(def.size_patterns ?? {})) {
    const r = re(pattern);
    if (r && r.test(hay)) return size;
  }
  return null;
}

/** What is left of the id once the family name is taken off the front. */
function versionFrom(id: string, family: string | null, size: string | null): string | null {
  const base = id.slice(id.lastIndexOf('/') + 1).toLowerCase();
  if (!family) return null;
  const strip = (prefix: string): string | null | undefined => {
    if (!prefix || !base.startsWith(prefix)) return undefined;
    const rest = base.slice(prefix.length).replace(/^[-_. ]+/, '');
    return rest || null; // the id *is* the family: there is no version
  };
  const f = family.toLowerCase();
  let rest = strip(f);
  if (rest === undefined) rest = strip(f.split(/[-_.]/)[0]!);
  if (rest === undefined || rest === null) return rest ?? null;
  // The size is its own field; leaving it in the version double-counts it.
  if (size) rest = rest.replace(new RegExp(`[-_.]?${size.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '');
  // Packaging and modification words are their own fields, not the version.
  rest = rest.replace(VERSION_NOISE_RE, '');
  return rest.replace(/^[-_. ]+|[-_. ]+$/g, '').replace(/[-_.]{2,}/g, '-') || null;
}

function applyDeclarations(ref: ModelRef): ModelRef {
  const d = ref.raw_id ? (declarations[ref.raw_id] ?? declarations[ref.raw_id.toLowerCase()]) : null;
  if (!d) return ref;
  const out = { ...ref };
  for (const [k, v] of Object.entries(d)) {
    if (v == null || k === 'raw_id' || k === 'raw_provider') continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** A short label for a row: what a person would call this thing. */
export function modelRefLabel(r: ModelRef): string {
  const name = r.raw_id ?? r.family ?? 'unknown';
  const bits = [r.provider ?? '?', r.quant !== 'unknown' ? r.quant : null, r.modified ? 'modified' : null].filter(Boolean);
  return `${name} (${bits.join(', ')})`;
}

// ---- local runtime probe ------------------------------------------------

export interface LocalProbe {
  base_url: string;
  provider: string;
  models: string[];
  quant: string | null;
  size: string | null;
}

/**
 * Ask the runtime what it is actually serving. vLLM and llama.cpp answer
 * /v1/models with the served model path; Ollama's /api/tags carries the quant
 * suffix and /api/show the exact parameter count. Never throws, never blocks
 * a hook for more than a moment.
 */
export async function probeLocalModel(baseUrl: string): Promise<LocalProbe | null> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const provider = localProviderFromUrl(baseUrl);
  const models: string[] = [];
  let details = '';

  const get = async (path: string, init?: RequestInit): Promise<unknown> => {
    try {
      const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null; // a probe is a nicety; a dead endpoint must not fail a session
    }
  };

  const v1 = (await get('/v1/models')) as { data?: Array<{ id?: string; root?: string }> } | null;
  for (const m of v1?.data ?? []) {
    if (typeof m?.id === 'string') models.push(m.id);
    if (typeof m?.root === 'string') details += ' ' + m.root;
  }

  const tags = (await get('/api/tags')) as { models?: Array<{ name?: string; model?: string; details?: Record<string, unknown> }> } | null;
  for (const m of tags?.models ?? []) {
    const name = m?.name ?? m?.model;
    if (typeof name === 'string' && !models.includes(name)) models.push(name);
    if (m?.details) details += ' ' + JSON.stringify(m.details);
  }

  const first = models[0];
  if (first) {
    const show = (await get('/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: first, name: first }),
    })) as { details?: Record<string, unknown>; model_info?: Record<string, unknown> } | null;
    if (show?.details) details += ' ' + JSON.stringify(show.details);
    if (show?.model_info) details += ' ' + JSON.stringify(show.model_info);
  }

  if (models.length === 0) return null;
  const hay = models.join(' ') + details;
  const quant = parseQuant(hay);
  return { base_url: base, provider, models, quant: quant === 'unknown' ? null : quant, size: parseSize(hay) };
}
