import { isoWeek, type Row, type Session } from '@nerfd/core';
import { listSessions } from './db.ts';

/** Local sessions in the shape the shared aggregator wants. */
export function sessionToRow(s: Session): Row | null {
  if (!s.model || !s.ended_at) return null;
  return {
    reporter: 'me',
    tool: s.tool,
    model: s.model,
    model_ref: s.model_ref,
    effort: s.effort,
    plan_id: s.plan_id,
    plan_usd_month: s.plan_usd_month,
    week: isoWeek(s.ended_at),
    ended_at: s.ended_at,
    category: s.category,
    size: s.size,
    repo: s.repo,
    duration_s: s.duration_s ?? 0,
    metrics: s.metrics,
    signals: s.signals ?? null,
    rating: s.outcome.rating,
    kept: s.outcome.kept,
    survival_ratio: s.survival.ratio,
  };
}

export interface RowFilter { weeks?: number; category?: string; lang?: string; tool?: string; model?: string; size?: string; minDurationS?: number }

export function localRows(f: RowFilter = {}): Row[] {
  const since = f.weeks ? new Date(Date.now() - f.weeks * 7 * 86400 * 1000).toISOString() : undefined;
  return listSessions({ sinceIso: since, endedOnly: true })
    .map(sessionToRow)
    .filter((r): r is Row => r != null)
    .filter((r) => (f.category ? r.category === f.category : true))
    .filter((r) => (f.lang ? r.repo.lang === f.lang : true))
    .filter((r) => (f.tool ? r.tool === f.tool : true))
    .filter((r) => (f.model ? r.model === f.model : true))
    .filter((r) => (f.size ? r.size === f.size : true))
    // Sessions under a minute with no prompts are noise (opened and closed).
    .filter((r) => r.metrics.prompts > 0 || r.duration_s >= (f.minDurationS ?? 60));
}
