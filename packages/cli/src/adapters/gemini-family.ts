import { execFileSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Turn } from '@nerfd/core';
import { CONTEXT_LIMIT_RE, TOOL_ARG_ERROR_RE, type TranscriptFile } from '../transcript.ts';
import { emptyLedger, type LedgerFacts } from './types.ts';

/**
 * Gemini CLI and Qwen Code share one lineage, so they share one reader.
 *
 * They have drifted since the fork, and the drift is in the record shape, not
 * the idea: Gemini writes `{type:'user'|'gemini', content, tokens, toolCalls}`
 * and Qwen writes Claude-shaped `{type:'user'|'assistant'|'tool_result',
 * message:{parts}, usageMetadata, toolCallResult}`. Both are JSONL, both
 * re-append a whole message every time any part of it changes, and both are
 * append-only logs somebody else owns.
 *
 * Three rules this file does not bend:
 *  - Every file is opened read-only. Qwen Code fences its transcripts with a
 *    writer lease; a second writer corrupts a live session.
 *  - Nothing derived from prompt, output, tool arguments or tool results is
 *    kept unless the caller explicitly asks for detail, and even then it is
 *    returned, never stored.
 *  - Error text is matched against a regex and reduced to a count. It is never
 *    logged, because an error message quotes its input.
 */

export type GeminiFlavour = 'gemini' | 'qwen';

/**
 * One thing that happened, in order. This is core's `Turn`: text, paths and
 * commands live on it for the length of one `computeSignals` call and are
 * never stored. The alias exists so this file reads on its own terms.
 */
export type AdapterTurn = Turn;

/** LedgerFacts plus the auth flavour, which plan detection will want later. */
export interface FamilyLedger extends LedgerFacts {
  auth_type: string | null;
}

export interface FamilyChat {
  session_id: string | null;
  facts: LedgerFacts;
  turns: AdapterTurn[];
}

export interface ParseOptions {
  /** Return prompt text, file paths and commands on the turns. Off by default. */
  detail?: boolean;
}

// transcript.ts exports the two regexes that carry the open-weight metrics;
// these two are private to it, so they are restated rather than widened.
const QUOTA_RE = /rate[ _-]?limit|429|too many requests|usage limit|hit your limit|(?<!context (window |length )?)limit reached|resource[ _-]?exhausted|quota/i;
const OVERLOADED_RE = /overloaded|529|capacity|at capacity/i;
const TIMEOUT_RE = /timed? ?out|ETIMEDOUT|deadline exceeded/i;
// Gemini CLI writes `{"type":"info","content":"Request cancelled."}` when the
// user hits escape. Qwen writes a cancelled tool status.
const CANCEL_RE = /request cancelled|cancelled by user|user cancelled|operation was aborted|aborted by user/i;

const MAX_LATENCY_MS = 30 * 60 * 1000;
// Enough to decide "did this error mention a schema"; short enough that a
// giant tool result never sits in memory.
const ERROR_TEXT_CAP = 4000;

// ---- reading -------------------------------------------------------------

/**
 * Stream a JSONL transcript line by line. These files reach hundreds of
 * megabytes (every re-append rewrites the whole message), so the whole file is
 * never held as one string.
 */
function eachRecord(path: string, fn: (rec: Record<string, unknown>) => void): void {
  if (!existsSync(path)) return;
  if (path.endsWith('.json')) {
    // Gemini CLI's older checkpoint format: one object with a messages array.
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      fn({ sessionId: doc.sessionId, startTime: doc.startTime, lastUpdated: doc.lastUpdated });
      for (const m of (doc.messages as Array<Record<string, unknown>>) ?? []) fn(m);
    } catch { /* a half-written or foreign file is not an error */ }
    return;
  }

  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return; } // read-only, always
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (;;) {
      let n = 0;
      try { n = readSync(fd, buf, 0, buf.length, null); } catch { break; }
      if (n <= 0) break;
      const chunk = rest + decoder.write(buf.subarray(0, n));
      const lines = chunk.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) emit(line, fn);
    }
    emit(rest + decoder.end(), fn);
  } finally {
    closeSync(fd);
  }
}

function emit(line: string, fn: (rec: Record<string, unknown>) => void): void {
  if (!line.trim()) return;
  try { fn(JSON.parse(line) as Record<string, unknown>); } catch { /* partial or truncated line */ }
}

// ---- one message, reduced ------------------------------------------------

interface Flags { rate: boolean; overloaded: boolean; timeout: boolean; argError: boolean; context: boolean }

interface ToolRec {
  name: string;
  ok: boolean;
  cancelled: boolean;
  flags: Flags;
  path: string | null;
  command: string | null;
  ts: string | null;
  /** Ties a call to its later result, where the format splits the two. */
  key: string | null;
  /** True for a call whose outcome has not been written yet. */
  pending: boolean;
}

interface Msg {
  ts: string | null;
  role: 'user' | 'assistant' | 'tool' | 'other';
  model: string | null;
  version: string | null;
  tokens: { in: number; out: number; cache: number; thoughts: number } | null;
  text: string | null;
  endsWithQuestion: boolean;
  compress: boolean;
  cancel: boolean;
  apiError: boolean;
  flags: Flags;
  tools: ToolRec[];
}

const noFlags = (): Flags => ({ rate: false, overloaded: false, timeout: false, argError: false, context: false });

function flagsFor(text: string): Flags {
  const t = text.length > ERROR_TEXT_CAP ? text.slice(0, ERROR_TEXT_CAP) : text;
  return {
    rate: QUOTA_RE.test(t),
    overloaded: OVERLOADED_RE.test(t),
    timeout: TIMEOUT_RE.test(t),
    argError: TOOL_ARG_ERROR_RE.test(t),
    context: CONTEXT_LIMIT_RE.test(t),
  };
}

function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The first of these argument names a tool uses to name a file. */
const PATH_KEYS = ['absolute_path', 'file_path', 'path', 'filePath', 'notebook_path', 'file'];

function argPath(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  for (const k of PATH_KEYS) { const v = str(args[k]); if (v) return v; }
  return null;
}

function argCommand(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  return str(args.command) ?? str(args.cmd) ?? null;
}

// ---- flavour readers -----------------------------------------------------

/** Gemini CLI: `{id, timestamp, type:'user'|'gemini'|'info'|'error', content, tokens, model, toolCalls}`. */
function readGemini(rec: Record<string, unknown>, detail: boolean): Msg | null {
  const type = str(rec.type);
  if (!type) return null;
  const ts = str(rec.timestamp);
  const content = typeof rec.content === 'string' ? rec.content : '';

  const msg: Msg = {
    ts,
    role: type === 'user' ? 'user' : type === 'gemini' ? 'assistant' : 'other',
    model: str(rec.model),
    version: null,
    tokens: null,
    text: detail && content ? content : null,
    endsWithQuestion: /\?\s*$/.test(content),
    compress: false,
    cancel: (type === 'info' || type === 'error') && CANCEL_RE.test(content),
    apiError: type === 'error',
    flags: type === 'error' || type === 'info' ? flagsFor(content) : noFlags(),
    tools: [],
  };

  const tk = rec.tokens as Record<string, unknown> | undefined;
  if (tk && typeof tk === 'object') {
    // promptTokenCount already contains the cached prefix, so the cached part
    // is subtracted out rather than billed twice. Thinking tokens bill as
    // output. This mapping is checked against `total` in the tests.
    const input = num(tk.input);
    const cached = num(tk.cached);
    msg.tokens = {
      in: Math.max(0, input - cached),
      out: num(tk.output) + num(tk.thoughts),
      cache: cached,
      thoughts: num(tk.thoughts),
    };
  }

  for (const raw of (rec.toolCalls as Array<Record<string, unknown>>) ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const status = (str(raw.status) ?? '').toLowerCase();
    const failed = status === 'error' || status === 'failed';
    const cancelled = status === 'cancelled' || status === 'canceled';
    const args = (raw.args as Record<string, unknown>) ?? null;
    msg.tools.push({
      name: str(raw.name) ?? 'unknown',
      ok: !failed && !cancelled,
      cancelled,
      // Only a failed call's output is inspected. A successful grep can
      // contain the words "failed to parse" because the user's code does.
      flags: failed ? flagsFor(text(raw.resultDisplay) + ' ' + text(raw.error) + ' ' + text(raw.result)) : noFlags(),
      path: detail ? argPath(args) : null,
      command: detail ? argCommand(args) : null,
      ts: str(raw.timestamp) ?? ts,
      // Gemini keeps the call and its outcome in one record, so there is
      // nothing to tie together later.
      key: null,
      pending: false,
    });
  }
  return msg;
}

/** Qwen Code: Claude-shaped records with `message.parts`, `usageMetadata`, `toolCallResult`. */
function readQwen(rec: Record<string, unknown>, detail: boolean): Msg | null {
  const type = str(rec.type);
  if (!type) return null;
  const ts = str(rec.timestamp);
  const message = (rec.message as Record<string, unknown>) ?? null;
  const parts = (message?.parts as Array<Record<string, unknown>>) ?? [];
  const body = parts.filter((p) => typeof p?.text === 'string' && p.thought !== true).map((p) => p.text as string).join('');

  const msg: Msg = {
    ts,
    role: type === 'user' ? 'user' : type === 'assistant' ? 'assistant' : type === 'tool_result' ? 'tool' : 'other',
    model: str(rec.model),
    version: str(rec.version),
    tokens: null,
    text: detail && body ? body : null,
    endsWithQuestion: /\?\s*$/.test(body),
    compress: type === 'system' && str(rec.subtype) === 'chat_compression',
    cancel: CANCEL_RE.test(body),
    apiError: false,
    flags: noFlags(),
    tools: [],
  };

  const um = rec.usageMetadata as Record<string, unknown> | undefined;
  if (um && typeof um === 'object') {
    const input = num(um.promptTokenCount);
    const cached = num(um.cachedContentTokenCount);
    msg.tokens = {
      in: Math.max(0, input - cached),
      out: num(um.candidatesTokenCount) + num(um.thoughtsTokenCount),
      cache: cached,
      thoughts: num(um.thoughtsTokenCount),
    };
  }

  // A tool call is announced in the assistant record and answered in a
  // tool_result record; the result is the one that knows whether it worked.
  const result = (rec.toolCallResult as Record<string, unknown>) ?? null;
  if (result || type === 'tool_result') {
    const fnResponse = parts.map((p) => p?.functionResponse as Record<string, unknown> | undefined).find(Boolean);
    const status = (str(result?.status) ?? '').toLowerCase();
    const failed = status === 'error' || !!result?.error || !!result?.errorType;
    const cancelled = status === 'cancelled' || status === 'canceled';
    const args = (fnResponse?.args as Record<string, unknown>) ?? (result?.args as Record<string, unknown>) ?? null;
    msg.role = 'tool';
    msg.tools.push({
      name: str(result?.name) ?? str(fnResponse?.name) ?? 'unknown',
      ok: !failed && !cancelled,
      cancelled,
      flags: failed ? flagsFor(text(result?.error) + ' ' + text(result?.errorType) + ' ' + text(result?.resultDisplay)) : noFlags(),
      path: detail ? argPath(args) : null,
      command: detail ? argCommand(args) : null,
      ts,
      key: str(result?.callId) ?? str(fnResponse?.id) ?? str(rec.toolUseId) ?? null,
      pending: false,
    });
  } else {
    // An assistant record can carry functionCall parts with the arguments the
    // model produced; the outcome arrives later.
    for (const p of parts) {
      const fc = p?.functionCall as Record<string, unknown> | undefined;
      if (!fc) continue;
      const args = (fc.args as Record<string, unknown>) ?? null;
      // The call itself is not an outcome: it is the only record that carries
      // the arguments, and the tool_result that follows decides whether it
      // worked. The two are joined on the call id.
      msg.tools.push({
        name: str(fc.name) ?? 'unknown',
        ok: true,
        cancelled: false,
        flags: noFlags(),
        path: detail ? argPath(args) : null,
        command: detail ? argCommand(args) : null,
        ts,
        key: str(fc.id) ?? null,
        pending: true,
      });
    }
  }
  return msg;
}

// ---- the parser ----------------------------------------------------------

/**
 * Read one chat file into ledger facts and an ordered list of turns.
 *
 * Both tools append the *entire* message again whenever any part of it changes
 * (a tool call finishing, tokens arriving), so records are deduplicated by id
 * with the last write winning. Without that, a session's tokens and tool calls
 * are counted several times over: the file inspected on this machine had 37
 * id-bearing lines for 23 messages.
 */
export function parseGeminiFamilyChat(path: string, flavour: GeminiFlavour, opts: ParseOptions = {}): FamilyChat {
  const detail = opts.detail === true;
  const byId = new Map<string, Msg>();
  const loose: Msg[] = [];
  let sessionId: string | null = null;
  let headStart: string | null = null;
  let headEnd: string | null = null;

  eachRecord(path, (rec) => {
    const set = rec.$set as Record<string, unknown> | undefined;
    if (set) {
      const u = str(set.lastUpdated);
      if (u) headEnd = u;
      return;
    }
    if (rec.sessionId != null && rec.type == null) { // the header line
      sessionId ??= str(rec.sessionId);
      headStart ??= str(rec.startTime);
      const u = str(rec.lastUpdated);
      if (u) headEnd = u;
      return;
    }
    sessionId ??= str(rec.sessionId);
    const msg = flavour === 'qwen' ? readQwen(rec, detail) : readGemini(rec, detail);
    if (!msg) return;
    const id = str(rec.id) ?? str(rec.uuid);
    if (id) byId.set(id, msg); // Map keeps the first insertion's position
    else loose.push(msg);
  });

  const messages = [...byId.values(), ...loose].sort(sortByTs);
  return { session_id: sessionId, ...aggregate(messages, headStart, headEnd, detail) };
}

function sortByTs(a: Msg, b: Msg): number {
  const x = a.ts ? Date.parse(a.ts) : 0;
  const y = b.ts ? Date.parse(b.ts) : 0;
  return (Number.isNaN(x) ? 0 : x) - (Number.isNaN(y) ? 0 : y);
}

function aggregate(messages: Msg[], headStart: string | null, headEnd: string | null, detail: boolean): { facts: LedgerFacts; turns: AdapterTurn[] } {
  const f = emptyLedger();
  const turns: AdapterTurn[] = [];
  let waitingSince: number | null = null;
  let lastAssistant: AdapterTurn | null = null;
  const pending = new Map<string, AdapterTurn>(); // tool calls awaiting a result

  const seen = (ts: string | null) => {
    if (!ts || Number.isNaN(Date.parse(ts))) return;
    if (!f.first_ts || ts < f.first_ts) f.first_ts = ts;
    if (!f.last_ts || ts > f.last_ts) f.last_ts = ts;
  };
  seen(headStart);
  seen(headEnd);

  for (const m of messages) {
    seen(m.ts);
    if (m.version) f.tool_version = m.version;
    if (m.model) f.model = m.model;
    if (m.compress) f.context_limit_hits++;
    if (m.cancel) {
      f.interrupts++;
      if (lastAssistant) lastAssistant.interrupted = true;
    }
    if (m.apiError) f.api_errors++;
    applyFlags(f, m.flags);

    const at = m.ts ? Date.parse(m.ts) : NaN;

    if (m.role === 'user') {
      if (!Number.isNaN(at)) waitingSince = at;
      turns.push(detail && m.text ? { role: 'user', ts: at || 0, text: m.text } : { role: 'user', ts: at || 0 });
    } else if (m.role === 'assistant') {
      f.turns++;
      if (m.tokens) {
        f.tokens_in += m.tokens.in;
        f.tokens_out += m.tokens.out;
        f.tokens_cache_read += m.tokens.cache;
      }
      if (waitingSince != null && !Number.isNaN(at)) {
        const dt = at - waitingSince;
        if (dt > 0 && dt < MAX_LATENCY_MS) f.latencies_ms.push(dt);
        waitingSince = null;
      }
      const turn: AdapterTurn = { role: 'assistant', ts: at || 0, ends_with_question: m.endsWithQuestion };
      if (m.model) turn.model = m.model;
      if (m.tokens) { turn.output_tokens = m.tokens.out; turn.thinking_tokens = m.tokens.thoughts; }
      if (detail && m.text) turn.text = m.text;
      turns.push(turn);
      lastAssistant = turn;
    }

    for (const t of m.tools) {
      const tsRaw = t.ts ? Date.parse(t.ts) : at;
      const tts = Number.isNaN(tsRaw) ? 0 : tsRaw;

      if (t.pending) {
        // A call with no outcome yet: the turn exists, `ok` does not.
        const turn: AdapterTurn = { role: 'tool', ts: tts, tool: t.name };
        if (t.path) turn.path = t.path;
        if (t.command) turn.command = t.command;
        turns.push(turn);
        if (t.key) pending.set(t.key, turn);
        continue;
      }

      if (!t.ok && !t.cancelled) f.api_errors++;
      applyFlags(f, t.flags);
      const prior = t.key ? pending.get(t.key) : undefined;
      const turn = prior ?? { role: 'tool', ts: tts, tool: t.name } as AdapterTurn;
      if (!prior) turns.push(turn);
      if (t.key) pending.delete(t.key);
      turn.ok = t.ok;
      if (t.cancelled) turn.interrupted = true;
      if (t.path && !turn.path) turn.path = t.path;
      if (t.command && !turn.command) turn.command = t.command;
      // A tool result is the next thing the model is waiting on, exactly like
      // a prompt: it starts the clock for the reply that follows.
      if (tts && m.role !== 'assistant') waitingSince = tts;
    }
  }

  return { facts: f, turns };
}

function applyFlags(f: LedgerFacts, fl: Flags): void {
  if (fl.rate) f.rate_limit_hits++;
  if (fl.overloaded) f.overloaded++;
  if (fl.timeout) f.timeouts++;
  if (fl.argError) f.tool_call_errors++;
  if (fl.context) f.context_limit_hits++;
}

// ---- finding the files ---------------------------------------------------

function walk(dir: string, sinceMs: number, depth: number, out: Array<{ path: string; mtime: number }>): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth < 6) walk(p, sinceMs, depth + 1, out); continue; }
    if (!/\.jsonl?$/.test(e)) continue;
    if (st.mtimeMs < sinceMs) continue;
    out.push({ path: p, mtime: st.mtimeMs });
  }
}

/** Session id from the file name: `session-2026-05-07T05-25-23c804c2` or `<uuid>`. */
export function chatSessionId(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.jsonl?$/, '');
}

/** Every chat file under the given roots, newest first. */
export function listFamilyChats(roots: string[], sinceIso: string): TranscriptFile[] {
  const since = Date.parse(sinceIso) || 0;
  const found: Array<{ path: string; mtime: number }> = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, since, 0, found);
  }
  return found
    .filter((f) => f.path.includes('/chats/'))
    .map((f) => ({ path: f.path, session_id: chatSessionId(f.path), mtime: f.mtime }))
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * The session id recorded inside the file, read from its first record only.
 * These files reach hundreds of megabytes; searching them by parsing them is
 * not an option.
 */
export function chatHeaderSessionId(path: string): string | null {
  if (path.endsWith('.json')) {
    try { return str((JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).sessionId); }
    catch { return null; }
  }
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(16 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, Math.max(0, n));
    const line = head.slice(0, head.indexOf('\n') === -1 ? head.length : head.indexOf('\n'));
    return str((JSON.parse(line) as Record<string, unknown>).sessionId);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The chat file for one session id. Gemini CLI names the file after the clock,
 * not the session, so a name miss falls back to the header line — which is
 * authoritative and costs one 16 KB read per candidate.
 */
export function findFamilyChat(roots: string[], sessionId: string): string | null {
  if (!sessionId) return null;
  const files = listFamilyChats(roots, new Date(0).toISOString());
  const byName = files.find((f) => f.session_id === sessionId || f.session_id.includes(sessionId));
  if (byName) return byName.path;
  return files.find((f) => chatHeaderSessionId(f.path) === sessionId)?.path ?? null;
}

// ---- settings ------------------------------------------------------------
// Gemini CLI and Qwen Code both take Claude-shaped hook blocks in
// settings.json: `hooks: { <Event>: [ { matcher?, hooks: [ {...} ] } ] }`.
// Entries are tagged so uninstall removes exactly ours and nothing else.

export const HOOK_TAG = 'nerfd';

export interface HookEntry { matcher?: string; hooks: Array<Record<string, unknown>> }
export type HooksMap = Record<string, HookEntry[]>;

export function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch { throw new Error(`could not parse ${path}; fix it or move it aside`); }
}

export function writeJsonWithBackup(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${HOOK_TAG}-${Date.now()}`);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function isOurs(e: HookEntry): boolean {
  return Array.isArray(e?.hooks) && e.hooks.some((h) => h[HOOK_TAG] === true || (typeof h.name === 'string' && h.name.startsWith(HOOK_TAG)));
}

export function mergeHooks(hooks: HooksMap, events: string[], entry: (event: string) => HookEntry, remove: boolean): HooksMap {
  const out: HooksMap = { ...hooks };
  for (const ev of events) {
    const existing = (out[ev] ?? []).filter((e) => !isOurs(e));
    out[ev] = remove ? existing : [...existing, entry(ev)];
    if (out[ev]!.length === 0) delete out[ev];
  }
  return out;
}

export function hasOurHooks(hooks: HooksMap | undefined): boolean {
  return !!hooks && Object.values(hooks).some((entries) => Array.isArray(entries) && entries.some(isOurs));
}

/** Both tools run the hook through a shell, so the two paths are quoted. */
export function shellCommand(parts: string[]): string {
  return parts.map((p) => (/^[A-Za-z0-9_./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
}

// ---- version gate --------------------------------------------------------

/** `x.y.z` from `<bin> --version`, or null if the binary is absent or odd. */
export function binaryVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function atLeast(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Is `name` an executable on PATH? Cheaper than spawning it to find out. */
export function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    try { if (statSync(join(dir, name)).isFile()) return true; } catch { /* next */ }
  }
  return false;
}
