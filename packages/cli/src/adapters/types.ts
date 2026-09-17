import { SIGNAL_VERSION, activeSeconds, classifyTexts, computeSignals, isAutomatedSession, type Session, type Tool, type Turn } from '@nerfd/core';
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
    // The kind of work, from the person's side of the conversation. A
    // backfilled session has no hook prompt to classify, and a live one was
    // classified on its first prompt alone; the turns are the better
    // evidence and they exist only here. One enum value comes out. A
    // category the person set with `nerfd rate` is theirs and stays.
    if (s.category_source !== 'user') {
      const inferred = classifyTexts(turns.filter((t) => t.role === 'user').map((t) => t.text));
      if (inferred !== 'other') s.category = inferred;
    }
    // Turns are the only place active time can come from, and this is the one
    // call that has them. `duration_s` stays the wall-clock span.
    s.metrics.active_s = activeSeconds(turns);
    // `pushback` deliberately conflates "stop" with an interrupted turn, so
    // it is not an interrupt count. The interrupted turns are, and they are
    // the same event the hook counts, so take the larger rather than the sum.
    const interrupted = turns.filter((t) => t.role === 'assistant' && t.interrupted === true).length;
    s.metrics.interrupts = Math.max(s.metrics.interrupts, interrupted);
    // The user turns are the only evidence a backfilled session has about
    // whether a person was in it, and they exist only now. A session whose
    // turns could not be reconstructed at all is left alone rather than
    // called automated: no evidence is not evidence of a robot. Never
    // downgraded either - an adapter that already knows the run was
    // unattended has said so before this call.
    if (!s.automated) s.automated = isAutomatedSession(s);
  } catch (e) {
    onError?.((e as Error).name);
  }
}

/**
 * A `session_meta.source` that names something other than a person's thread.
 * Codex is the only tool that writes one today (`codex exec` in CI, the
 * auto-review that fires on its own), and absent means "this build writes
 * none", which is not evidence either way.
 *
 * `vscode` is a person: the Codex desktop app, the Codex view inside the
 * ChatGPT app and the VS Code extension all drive Codex through the same
 * app-server, and every one of them stamps its threads with that source.
 */
const USER_THREAD_SOURCES = /^(user|thread|user[_-]thread|interactive|cli|vscode)$/i;

export function isUnattendedSource(metaSource: string | null | undefined): boolean {
  return metaSource != null && !USER_THREAD_SOURCES.test(metaSource);
}

export function emptyLedger(): LedgerFacts {
  return {
    model: null, tool_version: null, turns: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0,
    latencies_ms: [], api_errors: 0, rate_limit_hits: 0, overloaded: 0, timeouts: 0, interrupts: 0,
    tool_call_errors: 0, context_limit_hits: 0, first_ts: null, last_ts: null,
    rate_limit_used_pct: null, rate_limit_window_min: null, limit_windows: [], meta_source: null,
    raw_model: null, raw_provider: null, base_url: null, declared_name: null,
  };
}
