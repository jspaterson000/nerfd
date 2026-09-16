import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

// The vendored models.dev snapshot: 217 providers, ~7,600 models, dated.
// Sessions are priced and identified against the snapshot that shipped with
// the client, never a live table, so a price change never silently rewrites
// history. `scripts/snapshot-prices.ts` regenerates it.

export interface CatalogCost { input?: number; output?: number; cache_read?: number; cache_write?: number }
export interface CatalogLimit { context?: number; output?: number }

export interface CatalogModel {
  id: string;
  name?: string;
  family?: string;
  cost?: CatalogCost;
  limit?: CatalogLimit;
  open_weights?: boolean;
  release_date?: string;
  tool_call?: boolean;
  reasoning?: boolean;
}

export interface CatalogProvider { id: string; name: string; npm: string | null; models: Record<string, CatalogModel> }
export interface Catalog { fetched_at: string; source?: string; providers: Record<string, CatalogProvider> }

export interface CatalogHit {
  provider_id: string;
  model_id: string;
  model: CatalogModel;
  how: 'exact' | 'basename' | 'prefix';
}

const EMPTY: Catalog = { fetched_at: '', providers: {} };

let loaded: Catalog | null = null;

export function registerCatalog(snapshot: Catalog): void { loaded = snapshot; }

/** Lazy and cached: a hook that never prices anything never pays for the parse. */
export function catalog(): Catalog {
  if (loaded) return loaded;
  try {
    loaded = JSON.parse(readFileSync(new URL('../data/models.dev.json', import.meta.url), 'utf8')) as Catalog;
  } catch {
    // A missing snapshot degrades pricing to the hand table; it never throws.
    loaded = EMPTY;
  }
  return loaded;
}

/** Date of the snapshot in force, YYYY-MM-DD. Stored on every session. */
export function priceSnapshotDate(): string | null {
  const at = catalog().fetched_at;
  return at ? at.slice(0, 10) : null;
}

// Providers the tools name differently from models.dev.
const PROVIDER_ALIASES: Record<string, string> = {
  'kimi-code': 'kimi-for-coding',
  'kimi': 'kimi-for-coding',
  'kimi-cli': 'kimi-for-coding',
  'moonshot': 'moonshotai',
  'moonshot-ai': 'moonshotai',
  'zai': 'zai-coding-plan',
  'z-ai': 'zai-coding-plan',
  'zhipu': 'zhipuai',
  'claude-code': 'anthropic',
  'claude': 'anthropic',
  'codex': 'openai',
  'openai-chat-completions': 'openai',
  'gemini': 'google',
  'gemini-cli': 'google',
  'google-gla': 'google',
  'google-vertex': 'vertex',
  'qwen': 'alibaba',
  'qwen-code': 'alibaba',
  'dashscope': 'alibaba',
  'bedrock': 'amazon-bedrock',
};

/** models.dev's id for a provider a tool named its own way, or the input. */
export function canonicalProviderId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase();
  if (!id) return null;
  if (catalog().providers[id]) return id;
  const alias = PROVIDER_ALIASES[id];
  if (alias && catalog().providers[alias]) return alias;
  return alias ?? id;
}

export function provider(id: string | null | undefined): CatalogProvider | null {
  const cid = canonicalProviderId(id);
  return cid ? (catalog().providers[cid] ?? null) : null;
}

// A provider whose whole catalogue costs nothing per token is selling a
// subscription, not tokens: that is the signal INTEGRATIONS.md calls plan
// mode. The named ones are listed because some of them (opencode-go) mix
// plan models with priced ones.
const PLAN_PROVIDERS = new Set([
  'kimi-for-coding', 'zai-coding-plan', 'minimax-coding-plan', 'alibaba-coding-plan', 'opencode-go',
  'minimax-cn-coding-plan', 'alibaba-token-plan', 'alibaba-token-plan-cn', 'synthetic',
]);

/** Local runtimes. They appear in the catalogue but nobody is billed by them. */
export const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llama.cpp', 'llamacpp', 'vllm', 'local', 'local-openai-compatible', 'self-hosted']);

export function isPlanProvider(id: string | null | undefined): boolean {
  const cid = canonicalProviderId(id);
  if (!cid || LOCAL_PROVIDERS.has(cid)) return false;
  if (PLAN_PROVIDERS.has(cid)) return true;
  if (!/(coding|token)[-_]plan/.test(cid)) return false;
  const models = Object.values(catalog().providers[cid]?.models ?? {});
  return models.length > 0 && models.every((m) => m.cost?.input === 0 && m.cost?.output === 0);
}

const basename = (id: string) => id.slice(id.lastIndexOf('/') + 1);

// id (full and basename, lowercased) -> every provider that serves it.
let index: Map<string, CatalogHit[]> | null = null;

function idIndex(): Map<string, CatalogHit[]> {
  if (index) return index;
  const m = new Map<string, CatalogHit[]>();
  const add = (key: string, hit: CatalogHit) => {
    const list = m.get(key);
    if (list) list.push(hit);
    else m.set(key, [hit]);
  };
  for (const [pid, p] of Object.entries(catalog().providers)) {
    for (const [mid, model] of Object.entries(p.models)) {
      const lower = mid.toLowerCase();
      add(lower, { provider_id: pid, model_id: mid, model, how: 'exact' });
      const base = basename(lower);
      if (base !== lower) add(base, { provider_id: pid, model_id: mid, model, how: 'basename' });
    }
  }
  index = m;
  return m;
}

// First-party and major hosts first, so "who serves gpt-oss-120b" has a
// stable, unsurprising answer instead of whichever reseller sorted first.
const PROVIDER_RANK = [
  'anthropic', 'openai', 'google', 'moonshotai', 'deepseek', 'alibaba', 'zhipuai', 'minimax', 'xai', 'mistral',
  'meta', 'groq', 'cerebras', 'fireworks', 'together', 'deepinfra', 'openrouter', 'vertex', 'amazon-bedrock', 'azure',
];

function rank(hit: CatalogHit, wantProvider: string | null): number {
  if (wantProvider && hit.provider_id === wantProvider) return -100;
  const r = PROVIDER_RANK.indexOf(hit.provider_id);
  return (hit.how === 'exact' ? 0 : hit.how === 'basename' ? 1 : 2) * 100 + (r < 0 ? 50 : r);
}

/**
 * Exact, then basename, then prefix. Prefix matching requires a separator and
 * at least four characters on the shorter side, so a two-letter model name
 * cannot claim half the catalogue.
 */
export function lookupModel(providerId: string | null | undefined, modelId: string | null | undefined): CatalogHit | null {
  return lookupModels(providerId, modelId)[0] ?? null;
}

export function lookupModels(providerId: string | null | undefined, modelId: string | null | undefined): CatalogHit[] {
  if (!modelId) return [];
  const want = canonicalProviderId(providerId);
  const id = modelId.trim().toLowerCase();
  if (!id) return [];
  const idx = idIndex();
  const hits = [...(idx.get(id) ?? []), ...(id.includes('/') ? (idx.get(basename(id)) ?? []) : [])];
  if (hits.length === 0 && id.length >= 4) {
    for (const [key, list] of idx) {
      if (key.length < 4) continue;
      const long = key.length > id.length ? key : id;
      const short = key.length > id.length ? id : key;
      if (long.length === short.length || !long.startsWith(short) || !/[-_.:/]/.test(long[short.length]!)) continue;
      for (const h of list) hits.push({ ...h, how: 'prefix' });
    }
  }
  const seen = new Set<string>();
  return hits
    .filter((h) => { const k = h.provider_id + '/' + h.model_id; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => rank(a, want) - rank(b, want));
}

/** Every model in the catalogue, flattened. Used by the family price fallback. */
export function allModels(): CatalogHit[] {
  const out: CatalogHit[] = [];
  for (const [pid, p] of Object.entries(catalog().providers)) {
    for (const [mid, model] of Object.entries(p.models)) out.push({ provider_id: pid, model_id: mid, model, how: 'exact' });
  }
  return out;
}
