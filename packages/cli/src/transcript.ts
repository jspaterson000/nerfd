import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { percentile, type LimitWindow, type Turn } from '@nerfd/core';
import { CodexLimits } from './limits/codex.ts';

// Transcript formats are internal to each tool and can change without
// notice. Everything here is best-effort: any failure yields nulls, never a
// crash, and the hook-provided counters remain the source of truth.

export interface TranscriptFacts {
  model: string | null;
  tool_version: string | null;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  latencies_ms: number[];
  api_errors: number;
  rate_limit_hits: number;   // the subscription wall
  overloaded: number;        // the provider's fleet was busy: 529 / "overloaded" / "at capacity"
  timeouts: number;
  interrupts: number;
  tool_call_errors: number;   // the model emitted a tool call that would not parse or validate
  context_limit_hits: number; // the conversation was compacted, or the context window errored
  first_ts: string | null;
  last_ts: string | null;
  rate_limit_used_pct: number | null; // codex reports this directly
  rate_limit_window_min: number | null;
  // How much of each subscription window the session consumed. Empty for
  // every tool that does not write window state to disk. See docs/LIMITS.md.
  limit_windows: LimitWindow[];
  // Where the session came from, where the tool records it: Codex writes a
  // `source` on its rollout's `session_meta` line. A short enum token only -
  // never a path, a name or a command - and null for every tool that writes
  // nothing. Used to tell an auto-review from a thread a person typed in.
  meta_source?: string | null;
}

function empty(): TranscriptFacts {
  return {
    model: null, tool_version: null, turns: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0,
    latencies_ms: [], api_errors: 0, rate_limit_hits: 0, overloaded: 0, timeouts: 0, interrupts: 0,
    tool_call_errors: 0, context_limit_hits: 0, first_ts: null, last_ts: null,
    rate_limit_used_pct: null, rate_limit_window_min: null, limit_windows: [], meta_source: null,
  };
}

// Two different failures that used to share one counter. A quota error means
// the subscription window is spent and only time fixes it; an overload means
// the provider's fleet is busy and the next retry may work. Only the first is
// a wall, so only the first may reach `rate_limit_hits`. The lookbehind on
// "limit reached" keeps "context window limit reached" out of the quota
// counter: that is the context wall, and CONTEXT_LIMIT_RE already has it.
export const QUOTA_RE = /rate[ _-]?limit|429|too many requests|usage limit|hit your limit|(?<!context (window |length )?)limit reached|quota/i;
export const OVERLOADED_RE = /overloaded|529|capacity|at capacity/i;
const TIMEOUT_RE = /timed? ?out|ETIMEDOUT|deadline exceeded/i;
// The model's own output was malformed, as opposed to the tool failing. This
// is the number that differs most between hosts serving the same weights.
export const TOOL_ARG_ERROR_RE = /input.?validation|invalid (tool )?(input|argument|parameter|schema)|does not match the (required )?schema|failed to parse|unexpected token|is not valid json|required (property|parameter)|unrecognized (key|argument)|missing required/i;
export const CONTEXT_LIMIT_RE = /context (window|length|limit)|prompt is too long|exceeds? the (maximum )?context|too many tokens|max_tokens.*exceed|compact(ing|ed)? (the )?conversation/i;

/** Parsed JSONL, skipping any line that is not whole JSON. */
export function readJsonLines(path: string): unknown[] {
  return readLines(path);
}

function readLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

/** Claude Code: ~/.claude/projects/<proj>/<session>.jsonl */
export function parseClaudeTranscript(path: string): TranscriptFacts {
  const f = empty();
  const lines = readLines(path) as Array<Record<string, any>>;
  let waitingSince: number | null = null; // ts of last user/tool_result line

  for (const l of lines) {
    const ts = typeof l.timestamp === 'string' ? l.timestamp : null;
    if (ts) { f.first_ts ??= ts; f.last_ts = ts; }
    if (l.isSidechain) continue;
    if (typeof l.version === 'string') f.tool_version = l.version;
    // Claude Code writes a compact boundary when it runs out of room.
    if (l.isCompactSummary === true || l.compactMetadata != null || l.subtype === 'compact_boundary') f.context_limit_hits++;

    if (l.type === 'user' && ts) {
      waitingSince = Date.parse(ts);
      const content = l.message?.content;
      if (typeof content === 'string' && content.includes('[Request interrupted by user')) f.interrupts++;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'text' && typeof c.text === 'string' && c.text.includes('[Request interrupted by user')) f.interrupts++;
          if (c?.type === 'tool_result' && c.is_error) {
            // A failed tool result is the tool's own output: a compiler, a
            // grep, a shell command. It quotes source code, so scanning it for
            // "429" or "quota" counts the file under edit as a subscription
            // wall - which is exactly how a plan with no usage-limit error in
            // any transcript came to report a 71% wall-hit share. The
            // provider's own failures arrive on an `isApiErrorMessage` line
            // below, and only those may reach the wall counters.
            const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
            if (TIMEOUT_RE.test(text)) f.timeouts++;
            if (TOOL_ARG_ERROR_RE.test(text)) f.tool_call_errors++;
            if (CONTEXT_LIMIT_RE.test(text)) f.context_limit_hits++;
          }
        }
      }
      continue;
    }

    if (l.type === 'assistant') {
      const m = l.message ?? {};
      if (typeof m.model === 'string') f.model = m.model;
      if (l.isApiErrorMessage) {
        f.api_errors++;
        const text = JSON.stringify(m.content ?? '');
        if (QUOTA_RE.test(text)) f.rate_limit_hits++;
        if (OVERLOADED_RE.test(text)) f.overloaded++;
        if (TIMEOUT_RE.test(text)) f.timeouts++;
        if (CONTEXT_LIMIT_RE.test(text)) f.context_limit_hits++;
      }
      // Usage and turn counts are recomputed in dedupeClaudeUsage, because a
      // single API response is split across several lines sharing a requestId.
      if (waitingSince != null && ts) {
        const dt = Date.parse(ts) - waitingSince;
        if (dt > 0 && dt < 30 * 60 * 1000) f.latencies_ms.push(dt);
        waitingSince = null;
      }
    }
  }
  return dedupeClaudeUsage(lines, f);
}

// Usage lines repeat per content block; recount properly by requestId.
function dedupeClaudeUsage(lines: Array<Record<string, any>>, f: TranscriptFacts): TranscriptFacts {
  const seen = new Set<string>();
  let turns = 0, tin = 0, tout = 0, tcache = 0;
  for (const l of lines) {
    if (l.type !== 'assistant' || l.isSidechain) continue;
    const key = String(l.requestId ?? l.message?.id ?? l.uuid ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const u = l.message?.usage;
    if (!u) continue;
    turns++;
    tin += Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
    tout += Number(u.output_tokens ?? 0);
    tcache += Number(u.cache_read_input_tokens ?? 0);
  }
  return { ...f, turns, tokens_in: tin, tokens_out: tout, tokens_cache_read: tcache };
}

/** Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl */
export function findCodexRollout(sessionId: string): string | null {
  const base = join(homedir(), '.codex', 'sessions');
  if (!existsSync(base)) return null;
  const candidates: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.endsWith('.jsonl') && e.includes(sessionId)) candidates.push(p);
    }
  };
  walk(base, 0);
  return candidates.sort().at(-1) ?? null;
}

/**
 * The `source` a Codex rollout records for itself: a string on newer builds,
 * `{ type }` on others, and `{ subagent: ... }` for a thread the agent spawned
 * for itself. Kept only if it is a short enum token, because the point is to
 * tell "user thread" from "auto review" and nothing longer than that is an
 * answer to that question. A subagent object collapses to `subagent`: what
 * kind is irrelevant, no person typed into it.
 */
function metaSource(p: Record<string, any>): string | null {
  const raw = typeof p.source === 'string' ? p.source
    : (p.source && typeof p.source === 'object'
      ? (typeof p.source.type === 'string' ? p.source.type : ('subagent' in p.source ? 'subagent' : null))
      : null);
  return raw && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(raw) ? raw.toLowerCase() : null;
}

export function parseCodexRollout(path: string): TranscriptFacts {
  const f = empty();
  const lines = readLines(path) as Array<Record<string, any>>;
  let waitingSince: number | null = null;
  let lastTotal: Record<string, number> | null = null;
  const limits = new CodexLimits();

  for (const l of lines) {
    const ts = typeof l.timestamp === 'string' ? l.timestamp : null;
    if (ts) { f.first_ts ??= ts; f.last_ts = ts; }
    const p = l.payload ?? {};

    if (l.type === 'session_meta') {
      if (typeof p.cli_version === 'string') f.tool_version = p.cli_version;
      f.meta_source = metaSource(p) ?? f.meta_source ?? null;
      continue;
    }
    if (l.type === 'turn_context') {
      if (typeof p.model === 'string') f.model = p.model;
      continue;
    }
    if (l.type === 'event_msg') {
      if (p.type === 'token_count') {
        const t = p.info?.total_token_usage;
        if (t) lastTotal = t;
        limits.add(p, ts);
        const used = p.rate_limits?.primary?.used_percent;
        if (typeof used === 'number') f.rate_limit_used_pct = Math.max(f.rate_limit_used_pct ?? 0, used);
        const win = p.rate_limits?.primary?.window_minutes;
        if (typeof win === 'number') f.rate_limit_window_min = win;
      } else if (p.type === 'turn_aborted') {
        f.api_errors++;
      } else if (typeof p.type === 'string' && /error/i.test(p.type)) {
        f.api_errors++;
        const text = JSON.stringify(p);
        if (QUOTA_RE.test(text)) f.rate_limit_hits++;
        if (OVERLOADED_RE.test(text)) f.overloaded++;
        if (TIMEOUT_RE.test(text)) f.timeouts++;
        if (TOOL_ARG_ERROR_RE.test(text)) f.tool_call_errors++;
        if (CONTEXT_LIMIT_RE.test(text)) f.context_limit_hits++;
      }
      continue;
    }
    if (l.type === 'response_item') {
      if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.output != null) {
        const text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
        if (TOOL_ARG_ERROR_RE.test(text)) f.tool_call_errors++;
        if (CONTEXT_LIMIT_RE.test(text)) f.context_limit_hits++;
      }
      if (p.type === 'message' && p.role === 'user' && ts) { waitingSince = Date.parse(ts); continue; }
      if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && ts) { waitingSince = Date.parse(ts); continue; }
      if (p.type === 'message' && p.role === 'assistant') {
        f.turns++;
        if (waitingSince != null && ts) {
          const dt = Date.parse(ts) - waitingSince;
          if (dt > 0 && dt < 30 * 60 * 1000) f.latencies_ms.push(dt);
          waitingSince = null;
        }
      }
    }
  }
  if (lastTotal) {
    f.tokens_in = Number(lastTotal.input_tokens ?? 0);
    f.tokens_out = Number(lastTotal.output_tokens ?? 0);
    f.tokens_cache_read = Number(lastTotal.cached_input_tokens ?? 0);
  }
  f.limit_windows = limits.windows();
  // The wall is reported by the limit payload itself, which is more reliable
  // than matching error text, so it counts even when nothing errored.
  if (limits.wall) f.rate_limit_hits = Math.max(f.rate_limit_hits, 1);
  return f;
}

export function latencyPercentiles(l: number[]): { p50: number | null; p95: number | null } {
  return { p50: percentile(l, 50), p95: percentile(l, 95) };
}

/** Files under a directory tree, newest first, filtered by extension and mtime. */
function walk(dir: string, ext: string, sinceMs: number, depth = 0, out: Array<{ path: string; mtime: number }> = []): Array<{ path: string; mtime: number }> {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth < 5) walk(p, ext, sinceMs, depth + 1, out); continue; }
    if (e.endsWith(ext) && st.mtimeMs >= sinceMs) out.push({ path: p, mtime: st.mtimeMs });
  }
  return out;
}

export interface TranscriptFile { path: string; session_id: string; mtime: number }

/** Claude Code keeps one JSONL per session under ~/.claude/projects/<proj>/. */
export function listClaudeTranscripts(sinceIso: string): TranscriptFile[] {
  const base = join(homedir(), '.claude', 'projects');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return walk(base, '.jsonl', Date.parse(sinceIso) || 0)
    .map((f) => ({ path: f.path, session_id: f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.jsonl$/, ''), mtime: f.mtime }))
    // Subagent transcripts are part of their parent session, not sessions.
    .filter((f) => UUID.test(f.session_id) && !f.path.includes('/subagents/'))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session>.jsonl */
export function listCodexRollouts(sinceIso: string): TranscriptFile[] {
  const base = join(homedir(), '.codex', 'sessions');
  return walk(base, '.jsonl', Date.parse(sinceIso) || 0)
    .map((f) => {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
      const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(name)?.[1] ?? name;
      return { path: f.path, session_id: id, mtime: f.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------
// Turns: the input to the behavioural signals
// ---------------------------------------------------------------------------
//
// PRIVACY. The two functions below are the only place in the CLI that reads
// prompt and assistant text in bulk. They read a file that is already on this
// machine, build an array of `Turn`s in memory, and that array is handed
// straight to `computeSignals`, which returns counts. The text is never
// written to the database, the log, a report, a file or the network: what is
// stored is `Session.signals`, and `Signals` has no string field. Nothing
// here writes anything anywhere. See docs/SIGNALS.md and docs/PRIVACY.md.

/** Last non-empty line ends in a question mark: "it asked instead of acting". */
function endsWithQuestion(text: string): boolean {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    return line.endsWith('?');
  }
  return false;
}

/** Mark the most recent assistant turn as interrupted, if there is one. */
function markInterrupted(turns: Turn[]): void {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'assistant') { turns[i]!.interrupted = true; return; }
    if (turns[i]!.role === 'user') return;
  }
}

interface ToolCall { name: string; path?: string; command?: string }

/** What a tool call touched, from whatever the tool calls its arguments. */
function toolCallOf(name: string, input: unknown): ToolCall {
  const c: ToolCall = { name };
  if (!input || typeof input !== 'object') {
    // Some tools take a freeform string; treat it as the command text.
    if (typeof input === 'string' && input) c.command = input;
    return c;
  }
  const i = input as Record<string, unknown>;
  const path = i.file_path ?? i.notebook_path ?? i.path;
  if (typeof path === 'string' && path) c.path = path;
  const cmd = i.command ?? i.cmd ?? i.script;
  if (typeof cmd === 'string' && cmd) c.command = cmd;
  // Codex's shell tool sends argv, e.g. ["bash","-lc","pnpm test"].
  else if (Array.isArray(cmd)) {
    const joined = cmd.filter((x): x is string => typeof x === 'string').join(' ');
    if (joined) c.command = joined;
  }
  return c;
}

const CLAUDE_INTERRUPT = /\[Request interrupted by user[^\]]*\]?/g;

/**
 * Claude Code JSONL -> turns.
 *
 * One API response is written as several lines sharing a `requestId` (the
 * thinking block, each tool_use, the text), so assistant lines are grouped by
 * it: otherwise one answer would count as four assistant turns and its
 * thinking tokens four times over. A user line carrying only tool_result
 * blocks is the harness replying to itself, so it becomes `tool` turns and no
 * user turn.
 */
export function claudeTurns(path: string): Turn[] {
  const out: Turn[] = [];
  const lines = readLines(path) as Array<Record<string, any>>;
  const tools = new Map<string, ToolCall>();   // tool_use id -> what it was
  let pending: { req: string; ts: number; texts: string[]; thinking?: number; output?: number; model?: string } | null = null;

  const flush = () => {
    if (!pending) return;
    const text = pending.texts.join('\n');
    const t: Turn = { role: 'assistant', ts: pending.ts, text, ends_with_question: endsWithQuestion(text) };
    if (pending.thinking != null) t.thinking_tokens = pending.thinking;
    if (pending.output != null) t.output_tokens = pending.output;
    if (pending.model) t.model = pending.model;
    out.push(t);
    pending = null;
  };

  for (const l of lines) {
    if (l.isSidechain) continue;                 // a subagent's transcript, not this session
    const ts = Date.parse(typeof l.timestamp === 'string' ? l.timestamp : '');

    if (l.type === 'assistant') {
      const m = l.message ?? {};
      const req = String(l.requestId ?? m.id ?? l.uuid ?? out.length);
      if (pending && pending.req !== req) flush();
      pending ??= { req, ts, texts: [] };
      if (typeof m.model === 'string') pending.model = m.model;
      const u = m.usage;
      if (u) {
        // Usage repeats identically on every line of one response.
        if (typeof u.output_tokens === 'number') pending.output = u.output_tokens;
        const think = u.output_tokens_details?.thinking_tokens;
        if (typeof think === 'number') pending.thinking = think;
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'text' && typeof c.text === 'string') pending.texts.push(c.text);
        else if (c?.type === 'tool_use' && typeof c.id === 'string') tools.set(c.id, toolCallOf(String(c.name ?? 'tool'), c.input));
      }
      continue;
    }

    if (l.type !== 'user' || l.isMeta === true) continue;

    const content = l.message?.content;
    const texts: string[] = [];
    const results: Array<{ id: string; is_error: boolean }> = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
        else if (c?.type === 'tool_result') results.push({ id: String(c.tool_use_id ?? ''), is_error: c.is_error === true });
      }
    }
    let text = texts.join('\n');
    const interrupted = /\[Request interrupted by user/.test(text);
    if (interrupted) text = text.replace(CLAUDE_INTERRUPT, '').trim();
    // Slash-command plumbing is written as a user message; the person did not
    // type it, and its stdout can be enormous.
    if (/^<(?:command-name|command-message|local-command-stdout|user-prompt-submit-hook)/.test(text.trim())) text = '';

    flush();                                     // the response this line answers is over
    if (interrupted) markInterrupted(out);
    for (const r of results) {
      const call = tools.get(r.id);
      const t: Turn = { role: 'tool', ts, tool: call?.name ?? 'tool', ok: !r.is_error };
      if (call?.path) t.path = call.path;
      if (call?.command) t.command = call.command;
      out.push(t);
    }
    if (text) out.push({ role: 'user', ts, text });
  }
  flush();
  return out;
}

// A tool result with no exit code: fall back to what the text says. Heuristic,
// and biased towards "it worked", because a false failure would invent
// retries and abandonment that did not happen.
const OUTPUT_ERROR_RE = /\b(?:error|failed|failure|exception|traceback|no such file|not found|permission denied|command not found|aborted|cancelled|canceled|timed out)\b|\bexit (?:code|status)[: ]+[1-9]/i;
const EXIT_OK_RE = /"exit_code"\s*:\s*0\b/;
const EXIT_FAIL_RE = /"exit_code"\s*:\s*[1-9]/;

/** Codex wraps message and output text in {type,text} parts, or sends a string. */
function codexText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

// Codex replays its own preamble as `user` messages. They are configuration,
// not something a person typed, and they are long enough to swamp the
// steering ratio if counted.
const CODEX_PREAMBLE_RE = /^\s*<(?:environment_context|user_instructions|INSTRUCTIONS|system)/i;

/**
 * Codex rollout JSONL -> turns. Tool turns are emitted at the *output*,
 * because that is where success is known; ordering against the user and
 * assistant messages is unchanged.
 */
export function codexTurns(path: string): Turn[] {
  const out: Turn[] = [];
  const calls = new Map<string, ToolCall>();     // call_id -> what it was
  for (const l of readLines(path) as Array<Record<string, any>>) {
    const ts = Date.parse(typeof l.timestamp === 'string' ? l.timestamp : '');
    const p = l.payload ?? {};

    // Codex names the escape key "turn_aborted"; it lands after the assistant
    // message it cut short.
    if (l.type === 'event_msg' && p.type === 'turn_aborted') { markInterrupted(out); continue; }
    if (l.type !== 'response_item') continue;

    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = codexText(p.content).trim();
      if (!text) continue;
      if (p.role === 'user') {
        if (CODEX_PREAMBLE_RE.test(text)) continue;
        out.push({ role: 'user', ts, text });
      } else {
        out.push({ role: 'assistant', ts, text, ends_with_question: endsWithQuestion(text) });
      }
      continue;
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let args: unknown = p.arguments ?? p.input;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* freeform tool input */ } }
      calls.set(String(p.call_id ?? p.id ?? ''), toolCallOf(String(p.name ?? 'tool'), args));
      continue;
    }

    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const call = calls.get(String(p.call_id ?? ''));
      const text = codexText(p.output);
      const t: Turn = {
        role: 'tool', ts, tool: call?.name ?? 'tool',
        ok: EXIT_FAIL_RE.test(text) ? false : EXIT_OK_RE.test(text) ? true : !OUTPUT_ERROR_RE.test(text),
      };
      if (call?.path) t.path = call.path;
      if (call?.command) t.command = call.command;
      out.push(t);
    }
  }
  return out;
}
