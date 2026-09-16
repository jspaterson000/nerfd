import { SIGNAL_VERSION, activeSeconds, computeSignals, type Session, type Tool, type Turn } from '@nerfd/core';
import type { TranscriptFacts } from '../transcript.ts';

// Every tool is different, but they all split the same way. Live events
// (hooks or a plugin) give session boundaries, tool calls, errors and
// interrupts, keyed on a session id, and never carry token counts. Tokens,
// cost and the model actually used live in the tool's transcript or its
// SQLite store. An adapter covers both paths.

/** The one event vocabulary the state machine understands. */
export const CANONICAL_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
  'PostModelSwitch', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd',
] as const;
export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

export function isCanonicalEvent(x: unknown): x is CanonicalEvent {
  return typeof x === 'string' && (CANONICAL_EVENTS as readonly string[]).includes(x);
}

/**
 * Every tool surveyed delivers JSON on stdin with at least an event name and
 * a session id. Everything else is optional and treated as such.
 */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  model?: string;
  provider?: string;
  base_url?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  duration_ms?: number;
  from_model?: string;
  to_model?: string;
  reason?: string;
  error?: unknown;
  [k: string]: unknown;
}

export interface NormalisedEvent extends HookInput {
  hook_event_name: CanonicalEvent;
}

/**
 * What a tool's own ledger knows once the session is over: the transcript
 * facts, plus everything the model resolver needs to say which model this
 * actually was, plus the two open-weight metrics.
 */
export interface LedgerFacts extends TranscriptFacts {
  raw_model: string | null;
  raw_provider: string | null;
  base_url: string | null;
  declared_name: string | null;
}

export interface Adapter {
  id: Tool;
  label: string;
  /** Is this tool installed on this machine? */
  detect(): boolean;
  /** Install (or with remove=true, uninstall) hooks. Returns the paths written. */
  install(remove?: boolean): string[];
  hookEvents?: string[];
  /** Map the tool's own event payload onto the canonical vocabulary. */
  normalise(input: unknown): NormalisedEvent | null;
  /** Read the tool's transcript or store for one finished session. */
  ledger(session: Session): LedgerFacts | null;
  /**
   * The session as a list of normalised turns, for the behavioural signals.
   * Optional: a tool whose store cannot reconstruct a conversation simply
   * does not implement it, and those sessions carry no signals.
   *
   * The turns carry prompt text, tool paths and shell commands. They exist in
   * memory for the length of one `computeSignals` call and are never stored;
   * see `attachSignals` below and docs/SIGNALS.md.
   */
  turns?(session: Session): Turn[];
  /** Create sessions for history that predates the install. */
  backfill?(sinceIso: string): Session[];
}

/**
 * Compute the behavioural signals for a session and keep the counts.
 *
 * This is the boundary the privacy promise rests on: turns go in, integers
 * come out, and the array is unreachable afterwards. Failure is never fatal -
 * a transcript in an unexpected shape costs the signals, not the session - so
 * only the error's name is logged, never its message, which could quote the
 * file.
 */
export function attachSignals(s: Session, turns: Turn[], onError?: (name: string) => void): void {
  try {
    if (!turns.length) return;
    s.signals = computeSignals(turns);
    s.signal_version = SIGNAL_VERSION;
    // Turns are the only place active time can come from, and this is the one
    // call that has them. `duration_s` stays the wall-clock span.
    s.metrics.active_s = activeSeconds(turns);
    // `pushback` deliberately conflates "stop" with an interrupted turn, so
    // it is not an interrupt count. The interrupted turns are, and they are
    // the same event the hook counts, so take the larger rather than the sum.
    const interrupted = turns.filter((t) => t.role === 'assistant' && t.interrupted === true).length;
    s.metrics.interrupts = Math.max(s.metrics.interrupts, interrupted);
  } catch (e) {
    onError?.((e as Error).name);
  }
}

export function emptyLedger(): LedgerFacts {
  return {
    model: null, tool_version: null, turns: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0,
    latencies_ms: [], api_errors: 0, rate_limit_hits: 0, timeouts: 0, interrupts: 0,
    tool_call_errors: 0, context_limit_hits: 0, first_ts: null, last_ts: null,
    rate_limit_used_pct: null, rate_limit_window_min: null,
    raw_model: null, raw_provider: null, base_url: null, declared_name: null,
  };
}
