import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Session } from '@nerfd/core';
import '../quiet.ts';
import { CONTEXT_LIMIT_RE, TOOL_ARG_ERROR_RE } from '../transcript.ts';
import { backfillSession } from './backfill.ts';
import { emptyLedger, type Adapter, type HookInput, type LedgerFacts, type NormalisedEvent } from './types.ts';

// Crush keeps one SQLite database per project, at `<project>/.crush/crush.db`,
// and a registry of every project it has ever opened. That registry is the
// entry point: from it, every database on the machine can be found and read.
//
// It has exactly one hook, `PreToolUse`, and no session-end event of any kind
// (`internal/hooks/hooks.go` declares one constant, and the docs say so). So
// the hook gives tool-call counts as they happen and the database gives
// everything else, after the fact. A Crush session is closed by `nerfd check`
// or by backfill, never by Crush telling us it finished.
//
// Verified against charmbracelet/crush@01e8382 (0.94.2 on npm as
// @charmland/crush):
//   internal/db/migrations/*.sql   sessions and messages columns, unix seconds
//   internal/message/message.go    parts = [{"type","data"}]
//   internal/message/content.go    the payload of each part type
//   internal/projects/projects.go  {"projects":[{path,data_dir,last_accessed}]}
//   internal/hooks/input.go        {event, session_id, cwd, tool_name, tool_input}
//   internal/config/config.go      hooks: {PreToolUse: [{name,matcher,command,timeout}]}
//
// Privacy: `sessions.title` is a summary of the person's first prompt and is
// never read, by anything here. Message text, paths and commands are read only
// by `crushTurns`, whose output feeds the signal detectors in memory and is
// never stored; nothing in this file writes any of it to disk or to a record.
// (docs/PRIVACY.md, packages/core/src/signals.ts)

/** One line of a session, for the local `nerfd show --turns` view. */
export type AdapterTurn = {
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
};

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
const TAG = 'nerfd';

/** `$CRUSH_GLOBAL_DATA`, else `$XDG_DATA_HOME/crush`, else `~/.local/share/crush`. */
export function crushDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CRUSH_GLOBAL_DATA) return env.CRUSH_GLOBAL_DATA;
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'crush');
  return join(homedir(), '.local', 'share', 'crush');
}

/** `$CRUSH_GLOBAL_CONFIG`, else `$XDG_CONFIG_HOME/crush`, else `~/.config/crush`. */
export function crushConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CRUSH_GLOBAL_CONFIG) return env.CRUSH_GLOBAL_CONFIG;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'crush');
  return join(homedir(), '.config', 'crush');
}

export const crushRegistryPath = (env?: NodeJS.ProcessEnv) => join(crushDataDir(env), 'projects.json');
export const crushConfigPath = (env?: NodeJS.ProcessEnv) => join(crushConfigDir(env), 'crush.json');

export interface CrushProject { path: string; data_dir: string; db: string }

/**
 * The registry Crush writes every time it opens a project:
 * `{"projects":[{"path","data_dir","last_accessed"}]}`, most recent first.
 */
export function crushProjects(registry = crushRegistryPath()): CrushProject[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(registry, 'utf8')); } catch { return []; }
  const list = Array.isArray(raw) ? raw : (raw as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) return [];
  const out: CrushProject[] = [];
  for (const p of list) {
    const path = typeof (p as any)?.path === 'string' ? (p as any).path as string : null;
    if (!path) continue;
    const declared = typeof (p as any).data_dir === 'string' ? (p as any).data_dir as string : '.crush';
    const dataDir = isAbsolute(declared) ? declared : resolve(path, declared);
    out.push({ path, data_dir: dataDir, db: join(dataDir, 'crush.db') });
  }
  return out;
}

/** The project whose directory contains `cwd`; the deepest one wins. */
export function crushProjectFor(cwd: string | null, projects: CrushProject[]): CrushProject | null {
  if (!cwd) return null;
  const target = resolve(cwd);
  let best: CrushProject | null = null;
  for (const p of projects) {
    const root = resolve(p.path);
    if (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      if (!best || resolve(best.path).length < root.length) best = p;
    }
  }
  return best;
}

// --- the database, read-only and never migrated -----------------------------

function openRead(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try { return new DatabaseSync(path, { readOnly: true }); } catch { return null; }
}

function columns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

export interface CrushSessionRow {
  id: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  message_count: number;
  created_at: number;   // unix seconds
  updated_at: number;   // unix seconds
}

const SESSION_COLS = 'id, prompt_tokens, completion_tokens, cost, message_count, created_at, updated_at';

/**
 * Top-level sessions only. `parent_session_id` is set for the title-generation
 * and sub-agent sessions Crush spawns, and its own `ListSessions` filters them
 * out; counting them would be counting the same work twice.
 */
export function crushSessions(db: DatabaseSync, sinceSec = 0): CrushSessionRow[] {
  try {
    return db.prepare(
      `SELECT ${SESSION_COLS} FROM sessions WHERE parent_session_id IS NULL AND updated_at >= ? ORDER BY updated_at DESC`,
    ).all(sinceSec) as unknown as CrushSessionRow[];
  } catch {
    return [];
  }
}

interface CrushMessageRow {
  id: string;
  role: string;
  model: string | null;
  provider: string | null;
  parts: string;
  created_at: number;
  finished_at: number | null;
}

function crushMessages(db: DatabaseSync, sessionId: string): CrushMessageRow[] {
  const cols = columns(db, 'messages');
  if (cols.size === 0) return [];
  const provider = cols.has('provider') ? 'provider' : 'NULL AS provider';
  const summary = cols.has('is_summary_message') ? ' AND is_summary_message = 0' : '';
  try {
    return db.prepare(
      `SELECT id, role, model, ${provider}, parts, created_at, finished_at FROM messages
       WHERE session_id = ?${summary} ORDER BY created_at ASC, rowid ASC`,
    ).all(sessionId) as unknown as CrushMessageRow[];
  } catch {
    return [];
  }
}

interface Part { type: string; data: Record<string, unknown> }

/** `parts` is a JSON array of `{"type": "...", "data": {...}}`. */
function parts(json: string): Part[] {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: Part[] = [];
  for (const p of raw) {
    const type = typeof (p as any)?.type === 'string' ? (p as any).type as string : null;
    if (!type) continue;
    const data = ((p as any).data && typeof (p as any).data === 'object' ? (p as any).data : {}) as Record<string, unknown>;
    out.push({ type, data });
  }
  return out;
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Everything the store knows about one session. Tokens and cost are
 * session-level running totals: Crush records no per-message usage, so there
 * is nothing finer to have.
 */
export function crushFacts(db: DatabaseSync, row: CrushSessionRow): LedgerFacts {
  const f = emptyLedger();
  f.tokens_in = Number(row.prompt_tokens ?? 0);
  f.tokens_out = Number(row.completion_tokens ?? 0);
  f.first_ts = new Date(Number(row.created_at) * 1000).toISOString();
  f.last_ts = new Date(Number(row.updated_at) * 1000).toISOString();

  let lastUser: number | null = null;
  for (const m of crushMessages(db, row.id)) {
    const started = Number(m.created_at) * 1000;
    if (m.role === 'user') { lastUser = started; continue; }
    if (m.role === 'assistant') {
      f.turns++;
      if (m.model) f.model = m.model;
      if (m.provider) f.raw_provider = m.provider;
      if (lastUser != null && started > lastUser && started - lastUser < 30 * 60 * 1000) {
        f.latencies_ms.push(started - lastUser);
        lastUser = null;
      }
    }
    // Tool results arrive on their own `role: 'tool'` messages, so the parts
    // of every message are scanned, not only the assistant's.
    for (const p of parts(m.parts)) {
      if (p.type === 'finish') {
        const reason = s(p.data.reason);
        if (reason === 'canceled') f.interrupts++;
        if (reason === 'error') f.api_errors++;
        if (reason === 'max_tokens') f.context_limit_hits++;
      }
      if (p.type === 'tool_result' && p.data.is_error === true) {
        // Counted by shape, not read into anything that is kept.
        const text = `${s(p.data.content) ?? ''} ${s(p.data.metadata) ?? ''}`;
        if (TOOL_ARG_ERROR_RE.test(text)) f.tool_call_errors++;
        if (CONTEXT_LIMIT_RE.test(text)) f.context_limit_hits++;
      }
    }
  }
  f.raw_model = f.model;
  return f;
}

/**
 * The row for one session id. Crush's hook reports a short hash of the id
 * rather than the id itself, so an exact match is tried first, then a prefix
 * match, then the session that was open at the time — in that order, because
 * the first is certain and the last is a guess.
 */
export function findCrushSession(db: DatabaseSync, id: string, atIso: string | null = null): CrushSessionRow | null {
  const bare = id.replace(/^crush-/, '');
  try {
    const exact = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(bare) as unknown as CrushSessionRow | undefined;
    if (exact) return exact;
    if (/^[0-9a-f]{6,}$/i.test(bare)) {
      const pre = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id LIKE ? AND parent_session_id IS NULL`).get(`${bare}%`) as unknown as CrushSessionRow | undefined;
      if (pre) return pre;
    }
  } catch {
    return null;
  }
  if (!atIso) return null;
  const at = Math.floor(Date.parse(atIso) / 1000);
  if (!Number.isFinite(at)) return null;
  const rows = crushSessions(db);
  return rows.find((r) => Number(r.created_at) <= at + 60 && Number(r.updated_at) >= at - 60) ?? null;
}

// --- the one hook -----------------------------------------------------------

// Crush's payload names the event `event`, not `hook_event_name`, and
// `PreToolUse` is the only one there is. It fires *before* the tool runs, so
// it counts attempts, not outcomes: a Crush session records tool calls and
// edits, and never a tool failure. Mapping it to PostToolUse is what makes
// those counts comparable with every other tool's; the difference is stated
// here rather than hidden in a number.
const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name']> = {
  PreToolUse: 'PostToolUse',
};

export const CRUSH_EVENTS = ['PreToolUse'];

type CrushHook = { name?: string; matcher?: string; command: string; timeout?: number };

function ourHook(h: CrushHook): boolean {
  return h?.name === TAG || (typeof h?.command === 'string' && h.command.includes(CLI_PATH));
}

/**
 * Crush's hook config is a flat map of event name to a list of
 * `{name, matcher, command, timeout}` — not Claude Code's nested shape, even
 * though the stdin payload is deliberately Claude-Code-compatible. `command`
 * is a single string, so the two paths in it are quoted.
 */
export function installCrush(remove = false, path = crushConfigPath()): string {
  const file = readJsonc(path);
  const hooks = (file.hooks && typeof file.hooks === 'object' ? file.hooks : {}) as Record<string, CrushHook[]>;
  for (const ev of CRUSH_EVENTS) {
    const kept = (hooks[ev] ?? []).filter((h) => !ourHook(h));
    hooks[ev] = remove ? kept : [...kept, {
      name: TAG,
      matcher: '',
      command: `"${process.execPath}" "${CLI_PATH}" hook crush`,
      timeout: 10,
    }];
    if (hooks[ev]!.length === 0) delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete file.hooks;
  else file.hooks = hooks;

  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${TAG}-${Date.now()}`);
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  return path;
}

/**
 * Crush reads JSONC. Comments are stripped rather than refused, because a
 * config with a comment in it is a config someone wrote by hand, and losing
 * it would be worse than losing the comment — the backup keeps the original.
 */
function readJsonc(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  const stripped = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ''))
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(stripped) as Record<string, unknown>; } catch {
    throw new Error(`could not parse ${path}; fix it or move it aside`);
  }
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

export const crushAdapter: Adapter = {
  id: 'crush',
  label: 'Crush',
  hookEvents: CRUSH_EVENTS,

  detect: () => onPath('crush') || existsSync(crushConfigDir()) || existsSync(crushRegistryPath()),

  install: (remove = false) => [installCrush(remove)],

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object') return null;
    const i = input as HookInput & { event?: string };
    const name = s(i.event) ?? s(i.hook_event_name) ?? '';
    const mapped = EVENT_MAP[name];
    if (!mapped) return null;
    return { ...i, hook_event_name: mapped };
  },

  ledger(session: Session): LedgerFacts | null {
    return withSessionRow(session, (db, row) => crushFacts(db, row));
  },

  /** Every project in the registry, every session in every database. */
  backfill(sinceIso: string): Session[] {
    const since = Math.floor((Date.parse(sinceIso) || 0) / 1000);
    const out: Session[] = [];
    for (const project of crushProjects()) {
      const db = openRead(project.db);
      if (!db) continue;
      try {
        for (const row of crushSessions(db, since)) {
          const facts = crushFacts(db, row);
          const session = backfillSession('crush', row.id, project.db, facts, {
            raw_model: facts.raw_model,
            raw_provider: facts.raw_provider,
            base_url: null,
            declared_name: null,
          });
          if (session) out.push(session);
        }
      } finally {
        db.close();
      }
    }
    return out;
  },
};

/**
 * Turns for one session, in the shape `Signals` consumes (`Turn` in
 * packages/core/src/signals.ts): `text`, `path` and `command` are read by the
 * detectors and never stored. Nothing here writes them anywhere, and the
 * counts the detectors return are the only thing that outlives the call.
 */
export function crushTurns(session: Session): AdapterTurn[] {
  return withSessionRow(session, (db, row) => turnsFor(db, row)) ?? [];
}

/**
 * Find the session in whichever project database holds it, and do something
 * with it. The project the session ran in is asked first, and it is the only
 * one allowed the "which session was open at that moment" guess — in any other
 * database, only an exact id counts.
 */
function withSessionRow<T>(session: Session, fn: (db: DatabaseSync, row: CrushSessionRow) => T): T | null {
  const projects = crushProjects();
  const home = crushProjectFor(session.cwd, projects);
  const ordered = home ? [home, ...projects.filter((p) => p !== home)] : projects;
  for (const project of ordered) {
    const db = openRead(project.db);
    if (!db) continue;
    try {
      const row = findCrushSession(db, session.id, project === home ? session.started_at : null);
      if (row) return fn(db, row);
    } finally {
      db.close();
    }
  }
  return null;
}

function turnsFor(db: DatabaseSync, row: CrushSessionRow): AdapterTurn[] {
  const out: AdapterTurn[] = [];
  const results = new Map<string, boolean>();   // tool_call_id -> ok
  const messages = crushMessages(db, row.id);
  for (const m of messages) {
    for (const p of parts(m.parts)) {
      if (p.type !== 'tool_result') continue;
      const id = s(p.data.tool_call_id);
      if (id) results.set(id, p.data.is_error !== true);
    }
  }

  for (const m of messages) {
    const ts = Number(m.created_at) * 1000;
    const ps = parts(m.parts);
    const text = ps.filter((p) => p.type === 'text').map((p) => s(p.data.text) ?? '').join('\n').trim();
    if (m.role === 'user') { out.push({ role: 'user', ts, text: text || undefined }); continue; }
    if (m.role !== 'assistant') continue;
    const finish = ps.find((p) => p.type === 'finish');
    out.push({
      role: 'assistant',
      ts,
      text: text || undefined,
      model: m.model ?? undefined,
      ends_with_question: text.endsWith('?'),
      interrupted: s(finish?.data.reason) === 'canceled' || undefined,
    });
    for (const p of ps) {
      if (p.type !== 'tool_call') continue;
      const id = s(p.data.id);
      const input = toolInput(s(p.data.input));
      out.push({
        role: 'tool',
        ts: Number(m.finished_at ?? m.created_at) * 1000,
        tool: s(p.data.name) ?? undefined,
        path: input.path,
        command: input.command,
        ok: id ? results.get(id) : undefined,
      });
    }
  }
  return out;
}

/** `tool_call.data.input` is a string holding JSON. */
function toolInput(raw: string | null): { path?: string; command?: string } {
  if (!raw) return {};
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  if (!o || typeof o !== 'object') return {};
  const path = s(o.file_path) ?? s(o.path) ?? s(o.notebook_path);
  const command = s(o.command);
  return { path: path ?? undefined, command: command ?? undefined };
}
