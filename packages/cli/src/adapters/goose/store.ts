import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { TranscriptFacts } from '../../transcript.ts';
import { gooseDbPath } from './paths.ts';

// Reading Goose's own store. Schema verified against
// crates/goose/src/session/session_manager.rs (CURRENT_SCHEMA_VERSION = 16):
//
//   sessions(id, name, description, user_set_name, session_type, working_dir,
//            created_at, updated_at, extension_data, total_tokens,
//            input_tokens, output_tokens, cache_read_tokens,
//            cache_write_tokens, accumulated_total_tokens,
//            accumulated_input_tokens, accumulated_output_tokens,
//            accumulated_cache_read_tokens, accumulated_cache_write_tokens,
//            accumulated_cost, schedule_id, recipe_json,
//            user_recipe_values_json, provider_name, model_config_json,
//            goose_mode, archived_at, project_id, parent_session_id)
//   messages(id, message_id, session_id, role, content_json,
//            created_timestamp, timestamp, tokens, metadata_json)
//   usage_ledger(id, session_id, created_timestamp, model, input_tokens,
//                output_tokens, total_tokens, cache_read_tokens,
//                cache_write_tokens, cost, cost_source, is_compaction)
//
// `usage_ledger` is one row per LLM call and is the best ledger any tool
// surveyed offers: model, token split, cost and cost provenance, per call.
// That is exactly what separates "Kimi on Groq" from "Kimi on Moonshot".
//
// The database is opened read-only, always. nerfd never writes to a host
// tool's store.

/** One conversational turn, as much of it as a store will admit to. */
export interface AdapterTurn {
  role: 'user' | 'assistant' | 'tool';
  ts: number;
  text?: string;
  tool?: string;
  path?: string;
  command?: string;
  ok?: boolean;
  interrupted?: boolean;
  thinking_tokens?: number;
  output_tokens?: number;
  model?: string;
  ends_with_question?: boolean;
}

export interface GooseFacts extends TranscriptFacts {
  /** What Goose itself thought the session cost. The handler re-prices anyway. */
  ledger_cost_usd: number | null;
  /** "provider_reported", "estimated" or "carried_forward". Provenance matters. */
  ledger_cost_source: string | null;
  provider_name: string | null;
  config_model: string | null;
}

// Exact strings Goose writes when a turn is cut short, from
// crates/goose-cli/src/session/mod.rs:1677-1680.
const INTERRUPT_MARK = 'Interrupted by the user to make a correction';
const TOOL_CRASH_MARK = 'An uncaught error happened during tool use';

const RATE_LIMIT_RE = /rate[ _-]?limit|429|overloaded|529|capacity|too many requests/i;
const TIMEOUT_RE = /timed? ?out|ETIMEDOUT|deadline exceeded/i;
const TOOL_ARG_ERROR_RE = /input.?validation|invalid (tool )?(input|argument|parameter|schema)|does not match the (required )?schema|failed to parse|unexpected token|is not valid json|required (property|parameter)|unrecognized (key|argument)|missing required/i;
const CONTEXT_LIMIT_RE = /context (window|length|limit)|prompt is too long|exceeds? the (maximum )?context|too many tokens/i;

type Row = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Goose binds `created_at`/`updated_at` as a chrono `DateTime<Utc>`, which
 * sqlx writes as `YYYY-MM-DD HH:MM:SS[.ffffff][+00:00]`, and older rows fall
 * back to SQLite's own `CURRENT_TIMESTAMP` with no zone at all. Both mean UTC.
 */
export function gooseTimeToIso(v: unknown): string | null {
  if (typeof v === 'number' || typeof v === 'bigint') {
    const ms = Number(v) * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const s = str(v);
  if (!s) return null;
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const normalised = Date.parse(s.replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isNaN(normalised) ? null : new Date(normalised).toISOString();
}

/** Epoch seconds, as `messages.created_timestamp` and `usage_ledger.created_timestamp` store them. */
function epochIso(v: unknown): string | null {
  const n = num(v);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

/**
 * Open Goose's store read-only, run `fn`, close. Returns null when there is no
 * store, when it cannot be opened, or when anything at all goes wrong: a hook
 * must never fail its host tool, and the error text could quote a path.
 */
export function withGooseDb<T>(fn: (db: DatabaseSync) => T, path: string | null = gooseDbPath()): T | null {
  if (!path || !existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

function emptyFacts(): GooseFacts {
  return {
    model: null, tool_version: null, turns: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0,
    latencies_ms: [], api_errors: 0, rate_limit_hits: 0, timeouts: 0, interrupts: 0,
    tool_call_errors: 0, context_limit_hits: 0, first_ts: null, last_ts: null,
    rate_limit_used_pct: null, rate_limit_window_min: null,
    ledger_cost_usd: null, ledger_cost_source: null, provider_name: null, config_model: null,
  };
}

function parseContent(json: unknown): Row[] {
  if (typeof json !== 'string') return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as Row[]).filter((b) => b && typeof b === 'object') : [];
  } catch {
    return [];
  }
}

/** The error string inside a `tool_result` / `tool_call`, if it failed. */
function resultError(block: Row, key: 'tool_result' | 'tool_call'): string | null {
  const r = block[key] as Row | undefined;
  if (!r || typeof r !== 'object') return null;
  if (r.status === 'error') return typeof r.error === 'string' ? r.error : '';
  // A success can still carry `isError: true` on the CallToolResult.
  const value = r.value as Row | undefined;
  if (value && typeof value === 'object' && (value.isError === true || value.is_error === true)) {
    return contentText(value.content);
  }
  return null;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as Row).text === 'string' ? (c as Row).text as string : ''))
    .join(' ');
}

function toolCallOf(block: Row): { name: string | null; args: Row } {
  const call = block.tool_call as Row | undefined;
  const value = call?.value as Row | undefined;
  const name = value && typeof value === 'object' ? str(value.name) : null;
  const args = value && typeof value.arguments === 'object' && value.arguments ? value.arguments as Row : {};
  return { name, args };
}

/** Rows of `usage_ledger` for one session, oldest first. */
function ledgerRows(db: DatabaseSync, id: string): Row[] {
  return db.prepare(
    `SELECT created_timestamp, model, input_tokens, output_tokens, total_tokens,
            cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction
     FROM usage_ledger WHERE session_id = ? ORDER BY created_timestamp, id`,
  ).all(id) as Row[];
}

function messageRows(db: DatabaseSync, id: string): Row[] {
  // Same ordering Goose reads with (session_manager.rs:1877): seconds-resolution
  // timestamps tie constantly, so the autoincrement id breaks the tie.
  return db.prepare(
    'SELECT role, content_json, created_timestamp FROM messages WHERE session_id = ? ORDER BY created_timestamp, id',
  ).all(id) as Row[];
}

/** Everything nerfd needs about one finished Goose session. */
export function gooseSessionFacts(db: DatabaseSync, id: string): GooseFacts | null {
  const session = db.prepare(
    `SELECT id, provider_name, model_config_json, created_at, updated_at,
            accumulated_cost, accumulated_input_tokens, accumulated_output_tokens,
            accumulated_cache_read_tokens, accumulated_cache_write_tokens
     FROM sessions WHERE id = ?`,
  ).get(id) as Row | undefined;
  if (!session) return null;

  const f = emptyFacts();
  f.provider_name = str(session.provider_name);

  // `model_config_json` is a serialised ModelConfig
  // (crates/goose-provider-types/src/model.rs): `{ model_name, temperature, ... }`.
  try {
    const mc = session.model_config_json ? JSON.parse(String(session.model_config_json)) as Row : null;
    f.config_model = mc ? str(mc.model_name) : null;
  } catch { f.config_model = null; }

  // --- usage_ledger: tokens, cost, the model that actually served each call ---
  const ledger = ledgerRows(db, id);
  let cost = 0;
  let sawCost = false;
  for (const r of ledger) {
    const compaction = num(r.is_compaction) === 1;
    // Cache writes are billed as input and are input for every purpose we have.
    f.tokens_in += num(r.input_tokens) + num(r.cache_write_tokens);
    f.tokens_out += num(r.output_tokens);
    f.tokens_cache_read += num(r.cache_read_tokens);
    if (typeof r.cost === 'number' && Number.isFinite(r.cost)) { cost += r.cost; sawCost = true; }
    if (r.cost_source != null) f.ledger_cost_source = str(r.cost_source);
    if (compaction) {
      // Auto-compaction means the conversation outgrew the window. That is the
      // context-limit signal, reported rather than inferred from an error string.
      f.context_limit_hits++;
    } else if (str(r.model)) {
      // The last real call wins: a session that switched models is scored as
      // the model it finished on, the same rule every other adapter uses.
      f.model = str(r.model);
    }
  }
  f.ledger_cost_usd = sawCost ? cost : null;

  // A session written before the ledger existed still has the accumulated columns.
  if (ledger.length === 0) {
    f.tokens_in = num(session.accumulated_input_tokens) + num(session.accumulated_cache_write_tokens);
    f.tokens_out = num(session.accumulated_output_tokens);
    f.tokens_cache_read = num(session.accumulated_cache_read_tokens);
    if (typeof session.accumulated_cost === 'number') f.ledger_cost_usd = session.accumulated_cost;
  }
  if (!f.model) f.model = f.config_model;

  // --- messages: turns, latency, interrupts, tool failures ---
  const messages = messageRows(db, id);
  let pendingUserTs: number | null = null;
  for (const m of messages) {
    const ts = num(m.created_timestamp);
    const role = str(m.role);
    const blocks = parseContent(m.content_json);

    if (role === 'assistant') {
      f.turns++;
      if (pendingUserTs != null && ts >= pendingUserTs) {
        f.latencies_ms.push((ts - pendingUserTs) * 1000);
        pendingUserTs = null;
      }
    } else if (role === 'user') {
      // Only a real prompt starts a latency clock. A tool result is Goose
      // talking to itself with the user role, and timing that would measure
      // the tool, not the model.
      const isToolTraffic = blocks.some((b) => b.type === 'toolResponse');
      if (!isToolTraffic) pendingUserTs = ts;
    }

    for (const b of blocks) {
      if (b.type === 'toolRequest') {
        // A tool call the provider could not even produce as valid JSON. This
        // is the number that differs most between hosts serving one model.
        const err = resultError(b, 'tool_call');
        if (err != null) f.tool_call_errors++;
        continue;
      }
      if (b.type === 'error') {
        f.api_errors++;
        classify(f, typeof b.error === 'string' ? b.error : contentText(b.content));
        continue;
      }
      if (b.type !== 'toolResponse') continue;
      const err = resultError(b, 'tool_result');
      if (err == null) continue;
      if (err.includes(INTERRUPT_MARK)) { f.interrupts++; continue; }
      if (err.includes(TOOL_CRASH_MARK)) { f.api_errors++; continue; }
      classify(f, err);
      if (TOOL_ARG_ERROR_RE.test(err)) f.tool_call_errors++;
    }
  }

  const firstMsg = messages.length ? epochIso(messages[0]!.created_timestamp) : null;
  const lastMsg = messages.length ? epochIso(messages[messages.length - 1]!.created_timestamp) : null;
  f.first_ts = firstMsg ?? gooseTimeToIso(session.created_at);
  f.last_ts = lastMsg ?? gooseTimeToIso(session.updated_at);
  // The ledger can outlive the last message when the final call is still settling.
  const lastLedger = ledger.length ? epochIso(ledger[ledger.length - 1]!.created_timestamp) : null;
  if (lastLedger && (!f.last_ts || lastLedger > f.last_ts)) f.last_ts = lastLedger;

  // Goose stores no client version anywhere in the session row; `--version` at
  // hook time is the only honest source, and the handler already does that.
  f.tool_version = null;
  return f;
}

function classify(f: GooseFacts, text: string): void {
  if (RATE_LIMIT_RE.test(text)) f.rate_limit_hits++;
  if (TIMEOUT_RE.test(text)) f.timeouts++;
  if (CONTEXT_LIMIT_RE.test(text)) f.context_limit_hits++;
}

/**
 * The turn-by-turn shape, for anything that wants more than counts. Text is
 * returned to the caller in memory and is never persisted by this module.
 */
export function gooseSessionTurns(db: DatabaseSync, id: string): AdapterTurn[] {
  const out: AdapterTurn[] = [];
  const ledger = ledgerRows(db, id).filter((r) => num(r.is_compaction) !== 1);
  let nth = 0;

  for (const m of messageRows(db, id)) {
    const ts = num(m.created_timestamp) * 1000;
    const role = str(m.role);
    const blocks = parseContent(m.content_json);
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
    const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => String(b.thinking ?? '')).join('\n');

    if (role === 'assistant') {
      const usage = ledger[nth++];
      const turn: AdapterTurn = { role: 'assistant', ts };
      if (text) { turn.text = text; turn.ends_with_question = /\?\s*$/.test(text); }
      if (thinking) turn.thinking_tokens = Math.ceil(thinking.length / 4);
      if (usage) {
        turn.output_tokens = num(usage.output_tokens);
        const model = str(usage.model);
        if (model) turn.model = model;
      }
      out.push(turn);
      for (const b of blocks) {
        if (b.type !== 'toolRequest') continue;
        const { name, args } = toolCallOf(b);
        const turnTool: AdapterTurn = { role: 'tool', ts, ok: resultError(b, 'tool_call') == null };
        if (name) turnTool.tool = name;
        const path = str(args.path) ?? str(args.file_path) ?? str(args.file);
        if (path) turnTool.path = path;
        const command = str(args.command) ?? str(args.cmd);
        if (command) turnTool.command = command;
        out.push(turnTool);
      }
      continue;
    }

    const responses = blocks.filter((b) => b.type === 'toolResponse');
    if (responses.length) {
      for (const b of responses) {
        const err = resultError(b, 'tool_result');
        const t: AdapterTurn = { role: 'tool', ts, ok: err == null };
        if (err != null && err.includes(INTERRUPT_MARK)) {
          t.interrupted = true;
          // Goose records the interruption on the tool result it had to
          // synthesise, but the turn that was cut short is the assistant turn
          // that asked for the tool. That is the one the signals count.
          const lastAssistant = out.findLast((x) => x.role === 'assistant');
          if (lastAssistant) lastAssistant.interrupted = true;
        }
        out.push(t);
      }
      continue;
    }
    const turn: AdapterTurn = { role: 'user', ts };
    if (text) { turn.text = text; turn.ends_with_question = /\?\s*$/.test(text); }
    out.push(turn);
  }
  return out;
}

/**
 * Sessions a human actually ran, ended on or after `sinceIso`. Subagent,
 * scheduled and forked child sessions are excluded: they are the same work
 * counted twice, and counting them twice would skew every rate on the board.
 */
export function listGooseSessions(db: DatabaseSync, sinceIso: string): Array<{ id: string; ended: string }> {
  const since = Date.parse(sinceIso);
  const rows = db.prepare(
    `SELECT id, updated_at FROM sessions
     WHERE session_type = 'user' AND parent_session_id IS NULL
     ORDER BY updated_at DESC`,
  ).all() as Row[];
  const out: Array<{ id: string; ended: string }> = [];
  for (const r of rows) {
    const id = str(r.id);
    const ended = gooseTimeToIso(r.updated_at);
    if (!id || !ended) continue;
    if (Number.isFinite(since) && Date.parse(ended) < since) continue;
    out.push({ id, ended });
  }
  return out;
}
