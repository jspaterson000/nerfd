import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// OpenCode's config is the only place a custom provider's identity is written
// down: the endpoint it points at and the human-readable name the user gave
// the model. For a local or self-hosted model that name is the sole evidence
// of quantisation ("Qwen 3.8 27B Abliterated AWQ INT4"), so the model resolver
// depends on reading it. Nothing else in the file is of any interest, and
// credentials are removed before anything downstream can see them.

export function opencodeConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode');
}

export function opencodeDataDir(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode');
}

export function opencodeDbPath(): string {
  return join(opencodeDataDir(), 'opencode.db');
}

/**
 * JSONC without a dependency: drop `//` and block comments that are not
 * inside a string, then drop trailing commas. A config we cannot parse is a
 * config we do not have; it is never a reason to fail a session.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let inStr = false, esc = false, line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!, n = text[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const SECRET_RE = /key|token|secret|password/i;

/**
 * Credentials are removed on the way in, so no later code path can read one.
 * Only leaf values are dropped: a model id like `donkey-v2` is a map key, not
 * a credential, and removing it would lose the declared name we came for.
 */
export function stripSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const isBranch = val !== null && typeof val === 'object';
      if (!isBranch && SECRET_RE.test(k)) continue;
      out[k] = stripSecrets(val);
    }
    return out;
  }
  return v;
}

/** OpenCode interpolates `{env:VAR}` into config strings. `{file:...}` is not followed. */
function expand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v.trim());
  if (m) return process.env[m[1]!] ?? null;
  return v.startsWith('{') ? null : v;
}

export type OpencodeConfig = Record<string, unknown>;

export function readOpencodeConfig(path: string): OpencodeConfig | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return stripSecrets(parsed) as OpencodeConfig;
  } catch {
    return null;
  }
}

/** Global config, then $OPENCODE_CONFIG, then the project's own. Last wins. */
export function loadOpencodeConfigs(directory?: string | null): OpencodeConfig[] {
  const dir = opencodeConfigDir();
  const paths = [join(dir, 'opencode.json'), join(dir, 'opencode.jsonc'), process.env.OPENCODE_CONFIG ?? ''];
  if (directory) {
    paths.push(join(directory, '.opencode', 'opencode.json'));
    paths.push(join(directory, '.opencode', 'opencode.jsonc'));
  }
  const out: OpencodeConfig[] = [];
  for (const p of paths) {
    if (!p) continue;
    const c = readOpencodeConfig(p);
    if (c) out.push(c);
  }
  return out;
}

export interface ProviderInfo {
  base_url: string | null;
  declared_name: string | null;   // the model's human name: the only quant evidence for a custom provider
  provider_name: string | null;
  npm: string | null;             // '@ai-sdk/openai-compatible' etc: the provider *type*
}

export function emptyProviderInfo(): ProviderInfo {
  return { base_url: null, declared_name: null, provider_name: null, npm: null };
}

export function lookupProvider(configs: OpencodeConfig[], providerID: string | null, modelID: string | null): ProviderInfo {
  const info = emptyProviderInfo();
  if (!providerID) return info;
  for (const cfg of configs) {
    const providers = cfg.provider;
    if (!providers || typeof providers !== 'object') continue;
    const p = (providers as Record<string, unknown>)[providerID];
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec.name === 'string') info.provider_name = rec.name;
    if (typeof rec.npm === 'string') info.npm = rec.npm;
    const opts = rec.options as Record<string, unknown> | undefined;
    const url = opts ? expand(opts.baseURL ?? opts.baseUrl) : null;
    if (url) info.base_url = url;
    const models = rec.models as Record<string, unknown> | undefined;
    const m = modelID && models ? models[modelID] : null;
    if (m && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string') {
      info.declared_name = (m as { name: string }).name;
    }
  }
  return info;
}
