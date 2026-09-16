import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureHome } from './paths.ts';
import type { Session } from '@nerfd/core';

// One row per session. The full record lives in `data` as JSON; the extra
// columns exist only so listing and filtering stay cheap.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  tool        TEXT NOT NULL,
  model       TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  category    TEXT NOT NULL,
  rating      INTEGER,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS sessions_model ON sessions(model);
`;

let db: DatabaseSync | null = null;

/**
 * A hook is not the only writer. Claude Code runs hooks with `async: true` and
 * OpenCode's plugin fires several events at once, so two `nerfd hook`
 * processes routinely touch the same session row at the same moment. Ten
 * seconds is the budget for waiting one out: SessionEnd may legitimately hold
 * the write lock for a few seconds while it parses a transcript.
 */
export const BUSY_TIMEOUT_MS = 10_000;

/** SQLITE_BUSY (5) and SQLITE_LOCKED (6), however the runtime dresses them up. */
function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number }).errcode;
  if (code === 5 || code === 6) return true;
  return /database is locked|database table is locked|is busy/i.test((e as Error)?.message ?? '');
}

function sleep(ms: number): void {
  // The hook path is synchronous by design, so this is the only honest wait.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `busy_timeout` covers the statements SQLite routes through its busy handler,
 * but not all of them: `PRAGMA journal_mode=WAL` and the first statement of a
 * write transaction can still come back SQLITE_BUSY immediately when a sibling
 * process holds the lock. A hook that gives up there loses a tool call from
 * the session, silently, which is exactly the bug this file is defending
 * against - so a busy answer is retried rather than believed.
 */
function retryBusy<T>(fn: () => T, budgetMs = BUSY_TIMEOUT_MS): T {
  const deadline = Date.now() + budgetMs;
  let wait = 5;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      sleep(wait);
      wait = Math.min(wait * 2, 250);
    }
  }
}

export function openDb(path = DB_PATH): DatabaseSync {
  if (db) return db;
  ensureHome();
  db = new DatabaseSync(path);
  // busy_timeout is set first and on its own: switching journal mode and
  // creating the schema both want the write lock, and setting the timeout
  // after them would be too late for exactly the two statements that need it.
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
  retryBusy(() => db!.exec('PRAGMA journal_mode=WAL;'));
  retryBusy(() => db!.exec(SCHEMA));
  return db;
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE` ... `COMMIT`, rolling back on any error.
 *
 * IMMEDIATE takes the write lock up front rather than on the first write, so a
 * read-modify-write of one session row cannot interleave with a sibling
 * process's: the second `BEGIN IMMEDIATE` waits out `busy_timeout` and then
 * reads what the first one committed. A deferred transaction would let both
 * read the old row and the loser would be told to retry, which is exactly the
 * clobber this exists to prevent.
 *
 * Keep `fn` synchronous and short of I/O that can block forever: the lock is
 * held for its whole duration.
 */
export function transact<T>(fn: () => T): T {
  const d = openDb();
  retryBusy(() => d.exec('BEGIN IMMEDIATE'));
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw e;
  }
}

export function getSession(id: string): Session | null {
  const row = openDb().prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Session) : null;
}

export function putSession(s: Session): void {
  openDb().prepare(`
    INSERT INTO sessions (id, tool, model, started_at, ended_at, category, rating, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tool = excluded.tool, model = excluded.model, started_at = excluded.started_at,
      ended_at = excluded.ended_at, category = excluded.category, rating = excluded.rating,
      data = excluded.data
  `).run(s.id, s.tool, s.model, s.started_at, s.ended_at, s.category, s.outcome.rating, JSON.stringify(s));
}

export interface ListOpts { limit?: number; sinceIso?: string; endedOnly?: boolean }

export function listSessions(opts: ListOpts = {}): Session[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sinceIso) { where.push('started_at >= ?'); args.push(opts.sinceIso); }
  if (opts.endedOnly) where.push('ended_at IS NOT NULL');
  const sql = `SELECT data FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}`;
  const rows = openDb().prepare(sql).all(...(args as never[])) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as Session);
}

/** Most recent session, preferring ended ones. */
export function lastSession(): Session | null {
  return listSessions({ limit: 1, endedOnly: true })[0] ?? listSessions({ limit: 1 })[0] ?? null;
}

/** Resolve "last", a full id, or an id prefix. */
export function resolveSession(ref: string | undefined): Session | null {
  if (!ref || ref === 'last') return lastSession();
  const exact = getSession(ref);
  if (exact) return exact;
  const rows = openDb().prepare('SELECT data FROM sessions WHERE id LIKE ? ORDER BY started_at DESC LIMIT 2').all(ref + '%') as Array<{ data: string }>;
  if (rows.length === 1) return JSON.parse(rows[0]!.data) as Session;
  return null;
}

export function countSessions(): { total: number; ended: number; rated: number } {
  const d = openDb();
  const total = (d.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c;
  const ended = (d.prepare('SELECT COUNT(*) c FROM sessions WHERE ended_at IS NOT NULL').get() as { c: number }).c;
  const rated = (d.prepare('SELECT COUNT(*) c FROM sessions WHERE rating IS NOT NULL').get() as { c: number }).c;
  return { total, ended, rated };
}
