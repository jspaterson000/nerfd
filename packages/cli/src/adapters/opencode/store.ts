import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// OpenCode keeps everything in one SQLite database with WAL on. It is the
// tool's own store and nerfd only ever opens it read-only: a coding agent
// that loses its session history because a metrics tool held a write lock
// would deserve to be uninstalled.
//
// Shapes below are OpenCode 1.18's and are treated as untrusted: every field
// is probed, nothing is assumed, and a parse failure yields a null fact
// rather than an exception.

export interface OcSessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  version: string | null;
  model: string | null;              // JSON: { id, providerID, variant }
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  time_created: number | null;
  time_updated: number | null;
  time_compacting: number | null;
}

export interface OcMessage {
  id: string;
  time_created: number;
  role: string;
  modelID: string | null;
  providerID: string | null;
  tokens: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number };
  created: number | null;
  completed: number | null;
  error: { name: string; text: string } | null;
}

export interface OcPart {
  message_id: string;
  time_created: number;
  type: string;
  text: string | null;
  tool: string | null;
  status: string | null;
  error: string | null;
  interrupted: boolean;
  file_path: string | null;
  command: string | null;
  start: number | null;
  end: number | null;
}

export interface OcSession {
  row: OcSessionRow;
  messages: OcMessage[];
  parts: Map<string, OcPart[]>;
}

/** Read-only, WAL and all. Returns null rather than throwing on a missing or busy file. */
export function openStore(path: string): DatabaseSync | null {
  try {
    if (!existsSync(path)) return null;
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

function json(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const numOr = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strOr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export interface ModelId { id: string | null; providerID: string | null; variant: string | null }

/** The session row stores the model as JSON: `{ id, providerID, variant }`. */
export function parseModelColumn(raw: string | null): ModelId {
  const o = json(raw);
  if (!o) return { id: null, providerID: null, variant: null };
  return {
    id: strOr(o.id) ?? strOr(o.modelID),
    providerID: strOr(o.providerID) ?? strOr(o.provider),
    variant: strOr(o.variant),
  };
}

function errorOf(o: Record<string, unknown> | null): { name: string; text: string } | null {
  const e = o?.error;
  if (!e || typeof e !== 'object') return null;
  const rec = e as Record<string, unknown>;
  const name = strOr(rec.name) ?? 'UnknownError';
  const data = rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : null;
  const msg = strOr(data?.message) ?? '';
  const code = data && typeof data.statusCode === 'number' ? String(data.statusCode) : '';
  return { name, text: `${name} ${code} ${msg}`.trim() };
}

function messageFrom(id: string, timeCreated: number, data: unknown): OcMessage {
  const o = json(data);
  const t = (o?.tokens && typeof o.tokens === 'object' ? o.tokens : {}) as Record<string, unknown>;
  const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>;
  const time = (o?.time && typeof o.time === 'object' ? o.time : {}) as Record<string, unknown>;
  return {
    id,
    time_created: timeCreated,
    role: strOr(o?.role) ?? 'unknown',
    modelID: strOr(o?.modelID),
    providerID: strOr(o?.providerID),
    tokens: {
      input: numOr(t.input), output: numOr(t.output), reasoning: numOr(t.reasoning),
      cache_read: numOr(cache.read), cache_write: numOr(cache.write),
    },
    created: typeof time.created === 'number' ? time.created : null,
    completed: typeof time.completed === 'number' ? time.completed : null,
    error: errorOf(o),
  };
}

function partFrom(messageId: string, timeCreated: number, data: unknown): OcPart {
  const o = json(data);
  const state = (o?.state && typeof o.state === 'object' ? o.state : {}) as Record<string, unknown>;
  const input = (state.input && typeof state.input === 'object' ? state.input : {}) as Record<string, unknown>;
  const meta = (state.metadata && typeof state.metadata === 'object' ? state.metadata : {}) as Record<string, unknown>;
  const time = (state.time && typeof state.time === 'object' ? state.time : {}) as Record<string, unknown>;
  return {
    message_id: messageId,
    time_created: timeCreated,
    type: strOr(o?.type) ?? 'unknown',
    text: strOr(o?.text),
    tool: strOr(o?.tool),
    status: strOr(state.status),
    error: strOr(state.error),
    interrupted: meta.interrupted === true,
    file_path: strOr(input.filePath) ?? strOr(input.file_path) ?? strOr(input.path),
    command: strOr(input.command),
    start: typeof time.start === 'number' ? time.start : null,
    end: typeof time.end === 'number' ? time.end : null,
  };
}

const SESSION_COLUMNS = `id, parent_id, directory, version, model, summary_additions, summary_deletions,
  summary_files, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
  tokens_cache_write, time_created, time_updated, time_compacting`;

export function readSessionRow(db: DatabaseSync, id: string): OcSessionRow | null {
  try {
    const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`).get(id);
    return row ? (row as unknown as OcSessionRow) : null;
  } catch {
    return null;
  }
}

/** Root sessions only: a child session is a sub-agent inside one of them. */
export function listRootSessions(db: DatabaseSync, sinceMs: number): OcSessionRow[] {
  try {
    const rows = db.prepare(
      `SELECT ${SESSION_COLUMNS} FROM session WHERE parent_id IS NULL AND time_created >= ? ORDER BY time_created ASC`,
    ).all(sinceMs);
    return rows as unknown as OcSessionRow[];
  } catch {
    return [];
  }
}

export function readSession(db: DatabaseSync, id: string): OcSession | null {
  const row = readSessionRow(db, id);
  if (!row) return null;
  return { row, ...readBody(db, id) };
}

export function readBody(db: DatabaseSync, id: string): { messages: OcMessage[]; parts: Map<string, OcPart[]> } {
  const messages: OcMessage[] = [];
  const parts = new Map<string, OcPart[]>();
  try {
    for (const r of db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC').all(id)) {
      const m = r as unknown as { id: string; time_created: number; data: string };
      messages.push(messageFrom(m.id, m.time_created, m.data));
    }
  } catch { /* a store we cannot read is a store with nothing in it */ }
  try {
    for (const r of db.prepare('SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC').all(id)) {
      const p = r as unknown as { message_id: string; time_created: number; data: string };
      const parsed = partFrom(p.message_id, p.time_created, p.data);
      const list = parts.get(p.message_id);
      if (list) list.push(parsed);
      else parts.set(p.message_id, [parsed]);
    }
  } catch { /* as above */ }
  return { messages, parts };
}
