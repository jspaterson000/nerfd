import { existsSync } from 'node:fs';
import { emptyLimitTokens, type LimitScope, type LimitTokens, type LimitWindow } from '@nerfd/core';
import { readJsonLines } from '../transcript.ts';
import { LIMITS_DIR, readSamples, type LimitSample, type SampleScope } from './store.ts';

// Claude Code window capture, ledger side.
//
// The samples come from the status-line wrapper (statusline.ts); the tokens
// come from the transcript, because the status JSON does not carry usage and
// the transcript does not carry window state. Joining them on time is the
// whole trick: the tokens attributed to a window are the ones the transcript
// recorded between its first and last reading.

/** The window each scope measures, per Anthropic's published structure. */
const WINDOW_MIN: Record<SampleScope, number | null> = {
  five_hour: 300,
  seven_day: 7 * 24 * 60,
  spend: null,          // a spend cap is a dollar figure, not a window
};

/** `resets_at` moves a little between readings; past this it has reset. */
const RESET_JITTER_S = 15 * 60;

/**
 * Tokens the transcript recorded in a time range, deduped by request the same
 * way the ledger does it: one API response is written as several lines
 * sharing a `requestId`, each repeating the same usage block.
 */
export function usageBetween(path: string, fromMs: number, toMs: number): LimitTokens {
  const t = emptyLimitTokens();
  if (!path || !existsSync(path)) return t;
  const seen = new Set<string>();
  for (const line of readJsonLines(path) as Array<Record<string, any>>) {
    if (line.type !== 'assistant' || line.isSidechain) continue;
    const at = Date.parse(typeof line.timestamp === 'string' ? line.timestamp : '');
    if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
    const key = String(line.requestId ?? line.message?.id ?? line.uuid ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const u = line.message?.usage;
    if (!u) continue;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
    // Cache writes are billed as input and were not read from cache, so they
    // count as uncached input, which is how the ledger counts them too.
    t.uncached_in += n(u.input_tokens) + n(u.cache_creation_input_tokens);
    t.cached_in += n(u.cache_read_input_tokens);
    t.out += n(u.output_tokens);
  }
  t.total = t.uncached_in + t.cached_in + t.out;
  return t;
}

/** Split one scope's readings where the reset time jumped. */
function splitOnReset(samples: LimitSample[]): LimitSample[][] {
  const runs: LimitSample[][] = [];
  let current: LimitSample[] = [];
  let anchor: number | null = null;
  for (const s of samples) {
    if (current.length && s.resets_at != null && anchor != null && Math.abs(s.resets_at - anchor) > RESET_JITTER_S) {
      runs.push(current);
      current = [];
    }
    if (s.resets_at != null) anchor = s.resets_at;
    current.push(s);
  }
  if (current.length) runs.push(current);
  return runs;
}

/**
 * The limit windows for one finished Claude Code session: the status-line
 * samples on file for it, joined with the transcript's usage.
 *
 * `wallHit` is what the hook handler already counted - a `StopFailure` whose
 * error was a rate limit - plus any wall mark left in the sample file itself.
 * Never throws: no samples is the normal case on a machine without the
 * wrapper, and the answer there is an empty list.
 */
export function claudeLimitWindows(sessionId: string, transcriptPath: string | null, wallHit = false, dir = LIMITS_DIR): LimitWindow[] {
  try {
    const stored = readSamples(sessionId, dir);
    if (stored.samples.length === 0) return [];
    const wall = wallHit || stored.wall_hit;
    const byScope = new Map<SampleScope, LimitSample[]>();
    for (const s of stored.samples) {
      const list = byScope.get(s.scope) ?? [];
      list.push(s);
      byScope.set(s.scope, list);
    }

    const out: LimitWindow[] = [];
    for (const [scope, samples] of byScope) {
      for (const run of splitOnReset(samples)) {
        const first = run[0]!;
        const last = run[run.length - 1]!;
        out.push({
          scope: scope as LimitScope,
          window_min: WINDOW_MIN[scope],
          used_pct_start: first.used_pct,
          used_pct_end: last.used_pct,
          samples: run.length,
          resets_in_min_end: last.resets_at != null
            ? Math.max(0, Math.round((last.resets_at - Math.round(last.ts / 1000)) / 60))
            : null,
          reset_bucket: last.resets_at != null ? Math.floor(last.resets_at / 3600) : null,
          wall_hit: wall,
          tokens: transcriptPath ? usageBetween(transcriptPath, first.ts, last.ts) : emptyLimitTokens(),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
