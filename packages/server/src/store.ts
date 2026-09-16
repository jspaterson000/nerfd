import { DatabaseSync } from 'node:sqlite';
import type { Report } from "@nerfd/core";

// The public store. One row per report; the record is kept as JSON with a
// few indexed columns. Reports are append-only; there is no update path.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  report_id    TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL,
  model        TEXT NOT NULL,
  week         TEXT NOT NULL,
  ended_at     TEXT NOT NULL,
  category     TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_week ON reports(week);
CREATE INDEX IF NOT EXISTS reports_model ON reports(model);
CREATE INDEX IF NOT EXISTS reports_reporter ON reports(reporter_id, received_at);
`;

export class ReportStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;');
    this.db.exec(SCHEMA);
  }

  /** Insert, or update when the same reporter re-sends the same session (e.g. after rating it). */
  insert(r: Report): 'inserted' | 'updated' | 'rejected' {
    const existing = this.db.prepare('SELECT reporter_id FROM reports WHERE report_id = ?').get(r.report_id) as { reporter_id: string } | undefined;
    if (existing && existing.reporter_id !== r.reporter_id) return 'rejected';
    this.db.prepare(`
      INSERT INTO reports (report_id, reporter_id, model, week, ended_at, category, received_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_id) DO UPDATE SET
        model = excluded.model, week = excluded.week, ended_at = excluded.ended_at,
        category = excluded.category, data = excluded.data
    `).run(r.report_id, r.reporter_id, r.model, r.week, r.ended_at, r.category, new Date().toISOString(), JSON.stringify(r));
    return existing ? 'updated' : 'inserted';
  }

  /** Reports from a reporter in the last 24h. Used for a soft rate limit. */
  recentFromReporter(reporterId: string): number {
    const since = new Date(Date.now() - 86400 * 1000).toISOString();
    return (this.db.prepare('SELECT COUNT(*) c FROM reports WHERE reporter_id = ? AND received_at >= ?').get(reporterId, since) as { c: number }).c;
  }

  rows(weeks = 8): Report[] {
    const since = new Date(Date.now() - weeks * 7 * 86400 * 1000).toISOString();
    const list = this.db.prepare('SELECT data FROM reports WHERE ended_at >= ? ORDER BY ended_at').all(since) as Array<{ data: string }>;
    return list.map((x) => JSON.parse(x.data) as Report);
  }

  all(): Report[] {
    return (this.db.prepare('SELECT data FROM reports ORDER BY ended_at').all() as Array<{ data: string }>).map((x) => JSON.parse(x.data) as Report);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM reports').get() as { c: number }).c;
  }

  reporters(): number {
    return (this.db.prepare('SELECT COUNT(DISTINCT reporter_id) c FROM reports').get() as { c: number }).c;
  }
}
