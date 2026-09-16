// The only code in nerfd that opens a file belonging to another tool.
//
// Everything a detector learns comes through one of these functions, and each
// one is built so that the WORST case is "returns null". None of them can
// return a token, a key, an email, an account id or an org name, because every
// value crosses two gates before it is handed back:
//
//   * shape gate  - ENUM_SHAPE: 1..32 chars, letters/digits/space/_/-/., and
//                   no '@', '/', '+', ':' or '='. Every OAuth token, API key,
//                   JWT and email in existence fails this.
//   * member gate - the caller passes the exact set of values it expects. A
//                   value outside that set is discarded, not returned.
//
// The parsed object exists only inside the call and is never returned, stored,
// logged or written. Nothing here throws.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type { DetectOpts, ResolvedOpts } from './types.ts';

/** A config file worth reading is never this big. A cap also bounds the blast radius. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * A plan/tier value is a short enum token. Secrets are long, or contain
 * '@', '/', '+', ':' or '=' (base64, JWTs, emails, URLs, UUID-ish ids).
 */
const ENUM_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/;

export function resolveOpts(opts?: DetectOpts): ResolvedOpts {
  return {
    home: opts?.home ?? process.env.HOME ?? homedir(),
    env: opts?.env ?? process.env,
  };
}

/**
 * A path for the `evidence` string. Collapses the home directory to `~` so the
 * OS username never ends up in a stored detection record, and normalises the
 * separator so evidence reads the same on every machine.
 */
export function displayPath(home: string, abs: string): string {
  const h = home.replace(/[/\\]+$/, '');
  const shown = h && abs.startsWith(h + sep) ? '~' + abs.slice(h.length) : abs;
  return shown.split(sep).join('/');
}

/** Join under `home`, unless the caller already gave an absolute path. */
export function underHome(home: string, ...parts: string[]): string {
  const first = parts[0] ?? '';
  return isAbsolute(first) ? join(...parts) : join(home, ...parts);
}

/** "file field.path" - the single line that tells the user what was opened. */
export function evidenceOf(home: string, file: string, field: string): string {
  return `${displayPath(home, file)} ${field}`;
}

/** true if the path is a readable regular file of a sane size. Never throws. */
export function readableFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0 && st.size <= MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Parse a JSON file and hand the parsed value to `pick`, which must return a
 * short enum string or null. The parsed object never escapes this function:
 * `pick` is expected to reach for exactly one field, and whatever it returns is
 * put through the shape gate before being handed back.
 *
 * Returns null on a missing file, unreadable file, bad JSON, a missing field,
 * or a value that does not look like an enum token.
 */
export function withJson<T = unknown>(path: string, pick: (json: T) => unknown): string | null {
  if (!readableFile(path)) return null;
  try {
    // Scoped to this call. Not returned, not logged, not written anywhere.
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as T;
    const raw = pick(parsed);
    return gate(raw);
  } catch {
    return null;
  }
}

/**
 * Read one named field, identified by a dotted path, and return it only if it
 * is a short enum token AND appears in `allow`. This is the function nearly
 * every detector uses; `allow` is what makes a wrong field path harmless.
 */
export function pluckEnum(path: string, field: string[], allow: readonly string[]): string | null {
  const v = withJson<Record<string, unknown>>(path, (json) => dig(json, field));
  return v != null && allow.includes(v.toLowerCase()) ? v.toLowerCase() : null;
}

/**
 * Presence test only. Answers "is there a non-empty string at this path", and
 * returns a boolean - never the value. Used for "an API key is configured",
 * where the fact of the key matters and the key itself must never be touched.
 */
export function hasNonEmptyString(path: string, field: string[]): boolean {
  if (!readableFile(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const v = dig(parsed, field);
    return typeof v === 'string' && v.trim().length > 0;
  } catch {
    return false;
  }
}

/** Presence test for a key, whatever its type. Returns a boolean, never a value. */
export function hasKey(path: string, field: string[]): boolean {
  if (!readableFile(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return dig(parsed, field) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Presence test for a non-empty OBJECT at a path. Returns a boolean. Nothing
 * inside the object is named, read or counted - this answers only "did a login
 * of this kind happen", for cases where the tier itself is somewhere we refuse
 * to look (the macOS keychain).
 */
export function hasObject(path: string, field: string[]): boolean {
  if (!readableFile(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const v = dig(parsed, field);
    return v != null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * Read one claim out of the PAYLOAD of a JWT held at `field` in a JSON file.
 *
 * Only the middle segment is base64url-decoded. The token string itself is
 * never returned, never logged and never written; the signature is not touched
 * and no verification is attempted, because nothing here trusts the value for
 * anything beyond picking a price to display. The same two gates apply, so the
 * access token sitting next to the claim cannot come back out of this function.
 */
export function pluckJwtClaim(
  path: string,
  tokenField: string[],
  claim: string[],
  allow: readonly string[],
): string | null {
  if (!readableFile(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const token = dig(parsed, tokenField);
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const v = gate(dig(payload, claim));
    return v != null && allow.includes(v.toLowerCase()) ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Return the KEYS of an object in a JSON file, keeping only those in `allow`.
 *
 * Used where the useful signal is a provider name that appears as a key rather
 * than a value - opencode's auth.json is keyed by provider id. The values under
 * those keys are credentials and are never touched. Filtering against `allow`
 * means an unexpected key (a user-named custom provider, which could be an
 * employer name) is not returned either.
 */
export function objectKeys(path: string, field: string[], allow: readonly string[]): string[] {
  if (!readableFile(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const at = field.length ? dig(parsed, field) : parsed;
    if (at == null || typeof at !== 'object') return [];
    return Object.keys(at as Record<string, unknown>).filter((k) => allow.includes(k.toLowerCase()));
  } catch {
    return [];
  }
}

/**
 * true if any string anywhere under `field` names a loopback or private-range
 * host. Returns a boolean, never a URL: a base URL can contain a hostname that
 * identifies an employer, so the answer is only ever "yes, this is local".
 */
export function pointsAtLocalhost(path: string, field: string[]): boolean {
  if (!readableFile(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return scanLocal(dig(parsed, field), 0);
  } catch {
    return false;
  }
}

const LOCAL_HOST_RE = /^(?:https?:\/\/)?(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/|$)/i;

function scanLocal(v: unknown, depth: number): boolean {
  if (depth > 6) return false;
  if (typeof v === 'string') return LOCAL_HOST_RE.test(v.trim());
  if (Array.isArray(v)) return v.some((x) => scanLocal(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some((x) => scanLocal(x, depth + 1));
  return false;
}

/**
 * Read one top-level scalar out of a simple YAML file (goose's config.yaml).
 * A line-anchored match for one named key, gated the same way as JSON: the rest
 * of the file is never parsed, returned or retained.
 */
export function pluckYamlScalar(path: string, key: string, allow: readonly string[]): string | null {
  if (!readableFile(path)) return null;
  try {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*["']?([A-Za-z0-9_.-]{1,32})["']?\\s*$`, 'mi');
    const m = re.exec(readFileSync(path, 'utf8'));
    const v = gate(m?.[1]);
    return v != null && allow.includes(v.toLowerCase()) ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * true if any of these environment variables is set to a non-empty value.
 * Presence only - the value is a key and is never read, compared or copied.
 */
export function anyEnvSet(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  for (const n of names) {
    const v = env[n];
    if (typeof v === 'string' && v.trim().length > 0 && v.trim() !== '0' && v.trim().toLowerCase() !== 'false') return n;
  }
  return null;
}

/** Walk a dotted path. Returns undefined rather than throwing on any miss. */
function dig(obj: unknown, field: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of field) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** The shape gate. Anything that is not a short enum token becomes null. */
function gate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!ENUM_SHAPE.test(v)) return null;
  if (/[@/+:=]/.test(v)) return null;
  return v;
}

/** Exported for the test that proves the gate rejects secrets. */
export const __gate = gate;
