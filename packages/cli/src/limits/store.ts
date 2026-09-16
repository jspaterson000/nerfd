import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from '../paths.ts';

// Where the Claude Code status-line wrapper leaves its readings.
//
// One file per session, one JSON object per line, holding a timestamp, an
// allowlisted scope, a percentage and a reset time. Nothing else from the
// status JSON is ever written here: see statusline.ts, which is the only
// writer. The ledger reads the file at session end and `nerfd check` deletes
// files older than 30 days.

export const LIMITS_DIR = join(HOME, 'limits');

/** How long a sample file is worth keeping. */
export const SAMPLE_TTL_DAYS = 30;

export type SampleScope = 'five_hour' | 'seven_day' | 'spend';

export interface LimitSample {
  ts: number;                  // epoch ms, when the reading was taken
  scope: SampleScope;
  used_pct: number;
  resets_at: number | null;    // epoch seconds, as the tool reported it
}

/** A wall hit, noted by the hook handler rather than by the wrapper. */
export interface WallMark {
  ts: number;
  wall_hit: true;
}

/**
 * A session id becomes a file name, so it is held to the shape both tools
 * actually use. Anything else is refused rather than escaped: there is no
 * legitimate session id with a slash in it.
 */
export function safeSessionId(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..') ? id : null;
}

export function samplePath(sessionId: string, dir = LIMITS_DIR): string {
  return join(dir, `${sessionId}.jsonl`);
}

/** 0700 on the directory, 0600 on the file: this is window state, not news. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Append one line. Never throws: a sampler that fails is a sampler that is quiet. */
export function appendLine(sessionId: string, row: LimitSample | WallMark, dir = LIMITS_DIR): boolean {
  try {
    const id = safeSessionId(sessionId);
    if (!id) return false;
    ensureDir(dir);
    appendFileSync(samplePath(id, dir), JSON.stringify(row) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Record that this session hit the wall, for the ledger to read later. */
export function noteWallHit(sessionId: string, dir = LIMITS_DIR): void {
  appendLine(sessionId, { ts: Date.now(), wall_hit: true }, dir);
}

export interface StoredSamples {
  samples: LimitSample[];
  wall_hit: boolean;
}

const SCOPES: readonly SampleScope[] = ['five_hour', 'seven_day', 'spend'];

/** Read one session's readings back. Bad lines are skipped, never fatal. */
export function readSamples(sessionId: string, dir = LIMITS_DIR): StoredSamples {
  const out: StoredSamples = { samples: [], wall_hit: false };
  const id = safeSessionId(sessionId);
  if (!id) return out;
  let text: string;
  try { text = readFileSync(samplePath(id, dir), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r.wall_hit === true) { out.wall_hit = true; continue; }
    if (typeof r.ts !== 'number' || typeof r.used_pct !== 'number') continue;
    if (!SCOPES.includes(r.scope as SampleScope)) continue;
    out.samples.push({
      ts: r.ts,
      scope: r.scope as SampleScope,
      used_pct: r.used_pct,
      resets_at: typeof r.resets_at === 'number' ? r.resets_at : null,
    });
  }
  out.samples.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Delete sample files nothing will read again. The ledger consumes them at
 * session end; after 30 days a leftover is a stale file in $HOME, so
 * `nerfd check` sweeps them the same way it expires line hashes.
 */
export function pruneSamples(now = Date.now(), ttlDays = SAMPLE_TTL_DAYS, dir = LIMITS_DIR): number {
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue;
    const p = join(dir, e);
    try {
      if (now - statSync(p).mtimeMs <= ttlDays * 86400_000) continue;
      rmSync(p);
      removed++;
    } catch { /* a file that will not stat is a file we leave alone */ }
  }
  return removed;
}

/** How many sample files are on disk, for `nerfd privacy` and `nerfd doctor`. */
export function countSampleFiles(dir = LIMITS_DIR): number {
  try { return readdirSync(dir).filter((e) => e.endsWith('.jsonl')).length; } catch { return 0; }
}
