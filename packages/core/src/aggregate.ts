import type { ModelRef } from './modelref.ts';
import { costUsd } from './pricing.ts';
import { signalRates, type Signals } from './signals.ts';
import { driftZ, mean, percentile, wilson } from './stats.ts';
import type { Category, Kept, LimitWindow, Metrics, RepoProfile, Size, Tool } from './types.ts';

// Aggregation shared by the local CLI and the public server, so the number
// you see for yourself is computed exactly like the number everyone sees.

/** The minimal row both a local Session and a public Report can be mapped to. */
export interface Row {
  reporter?: string;      // pseudonymous; "me" locally
  tool: Tool;
  model: string;
  // Optional: records written before the adapter layer have no model_ref, and
  // they still aggregate, as "-".
  model_ref?: ModelRef;
  effort: string | null;
  plan_id?: string | null;
  plan_usd_month?: number | null;
  week: string;
  ended_at: string;
  category: Category;
  size: Size;
  repo: RepoProfile;
  duration_s: number;
  metrics: Metrics;
  // Behavioural signals, where the adapter could produce turns. Counts only.
  signals?: Signals | null;
  rating: number | null;
  kept: Kept;
  survival_ratio: number | null;
  // Subscription window state the tool wrote to disk, where it writes any:
  // percentages, a window length and the tokens between two readings. See
  // limits.ts and docs/LIMITS.md. Optional: most tools report nothing.
  limit_windows?: LimitWindow[] | null;
  // Nobody prompted this session: a Codex auto-review, a CI agent. It is real
  // spend against a real plan, so economics and limits keep it, but it is not
  // evidence about how a model behaves for a person, so the quality boards
  // filter it out. Optional: a record written before the flag has none.
  automated?: boolean;
}

/** Rows a person actually steered. What every quality ranking is built on. */
export function steeredRows(rows: Row[]): Row[] {
  return rows.filter((r) => !r.automated);
}

/**
 * The cap applied to a session's wall-clock span when active time is unknown.
 * A session the tool could not give us turns for is not evidence of a nine
 * hour shift; four hours is the longest single sitting worth believing.
 */
export const ACTIVE_FALLBACK_CAP_S = 4 * 3600;

/**
 * Hours of work a session represents. Active time where the adapter could
 * compute it, otherwise the wall-clock span capped at `ACTIVE_FALLBACK_CAP_S`.
 *
 * This is the only definition of "hours" in the codebase. `duration_s` stays
 * the wall-clock span - it is what size inference reads - but summing it
 * across resumed sessions counts nights and weekends as work.
 */
export function hoursOf(row: { duration_s: number | null; metrics: Metrics }): number {
  const active = row.metrics.active_s;
  return (active ?? Math.min(row.duration_s ?? 0, ACTIVE_FALLBACK_CAP_S)) / 3600;
}

export type GroupKey =
  | 'model' | 'category' | 'tool' | 'week' | 'lang' | 'size' | 'effort' | 'plan_id'
  // The provider board: same weights, different host, different quantisation.
  | 'provider' | 'quant' | 'family' | 'serving_mode';

export interface Group {
  key: Record<string, string>;
  n: number;
  n_rated: number;
  rating_mean: number | null;
  good: { p: number; lo: number; hi: number } | null;  // share of sessions rated >= 4
  survival_mean: number | null;                        // mean of survival_ratio where measured
  n_survival: number;
  kept_rate: number | null;                            // explicit kept / (kept+partial+reverted)
  latency_p50_ms: number | null;                       // median of per-session p50s
  error_rate: number;                                  // sessions with >=1 error
  rate_limit_rate: number;                             // sessions with >=1 subscription-wall hit (429 / quota)
  overloaded_rate: number;                             // sessions with >=1 provider overload (529 / "overloaded"), which is not a wall
  interrupt_rate: number;                              // sessions with >=1 interrupt
  switch_rate: number;                                 // sessions where the user switched model
  tool_call_error_rate: number | null;                 // tool calls that failed to parse or validate, over all tool calls
  friction_free: number;                               // sessions with none of the above, overload included
  duration_median_s: number | null;
  // Behavioural signals, averaged over the sessions in this group that have
  // them. Each is the mean of a per-session rate, not a pooled ratio: a
  // 200-turn session should not outvote a 5-turn one. `n_signals` is the
  // denominator, and every rate is null when it is zero.
  correction_rate: number | null;         // per user turn
  reprompt_rate: number | null;           // per user turn
  frustration_rate: number | null;        // per user turn
  pushback_rate: number | null;           // per user turn, incl. interrupted assistant turns
  clarification_rate: number | null;      // per assistant turn
  edit_without_read_rate: number | null;  // per edit tool call
  abandoned_rate: number | null;          // share of sessions that ended on friction
  n_signals: number;
  success_rate: number | null;                         // rated >=4, or unrated with kept / survival >= 0.6
  cost_mean: number | null;                            // API-equivalent USD per session, priced models only
  cost_per_success: number | null;                     // total cost / successful sessions: what a good outcome really costs
  waste_share: number | null;                          // share of spend on sessions that failed (rated <=2, reverted, or survival < 0.2)
  n_priced: number;
  score: number | null;                                // 0..100 composite, see scoreGroup
}

const router = (r: Row) => r.model_ref?.serving_mode === 'router';

function keyOf(r: Row, by: GroupKey[]): Record<string, string> {
  const k: Record<string, string> = {};
  for (const b of by) {
    switch (b) {
      case 'lang': k[b] = r.repo.lang; break;
      case 'effort': k[b] = r.effort ?? '-'; break;
      // An auto-routing id was served by some host, picked per request. It
      // has no family and no attributable provider, so it groups as unknown
      // rather than polluting a real row.
      case 'provider': k[b] = router(r) ? '-' : (r.model_ref?.provider ?? '-'); break;
      case 'family': k[b] = router(r) ? '-' : (r.model_ref?.family ?? '-'); break;
      case 'quant': k[b] = r.model_ref?.quant ?? 'unknown'; break;
      case 'plan_id': k[b] = r.plan_id ?? '-'; break;
      case 'serving_mode': k[b] = r.model_ref?.serving_mode ?? '-'; break;
      default: k[b] = String(r[b]);
    }
  }
  return k;
}

export function aggregate(rows: Row[], by: GroupKey[]): Group[] {
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const k = keyOf(r, by);
    const id = by.map((b) => k[b]).join(" | ");
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(r);
  }
  const out: Group[] = [];
  for (const [, list] of buckets) {
    out.push(summarise(keyOf(list[0]!, by), list));
  }
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.n - a.n);
}

export function summarise(key: Record<string, string>, list: Row[]): Group {
  const ratings = list.map((r) => r.rating).filter((x): x is number => x != null);
  const surv = list.map((r) => r.survival_ratio).filter((x): x is number => x != null);
  const keptRows = list.filter((r) => r.kept === 'kept' || r.kept === 'partial' || r.kept === 'reverted');
  const lat = list.map((r) => r.metrics.latency_p50_ms).filter((x): x is number => x != null);
  const frac = (f: (r: Row) => boolean) => list.filter(f).length / list.length;
  const g: Group = {
    key,
    n: list.length,
    n_rated: ratings.length,
    rating_mean: mean(ratings),
    good: ratings.length ? wilson(ratings.filter((x) => x >= 4).length, ratings.length) : null,
    survival_mean: mean(surv),
    n_survival: surv.length,
    kept_rate: keptRows.length ? keptRows.filter((r) => r.kept === 'kept').length / keptRows.length : null,
    latency_p50_ms: percentile(lat, 50),
    error_rate: frac((r) => r.metrics.errors > 0),
    rate_limit_rate: frac((r) => r.metrics.rate_limit_hits > 0),
    overloaded_rate: frac((r) => (r.metrics.overloaded ?? 0) > 0),
    interrupt_rate: frac((r) => r.metrics.interrupts > 0),
    switch_rate: frac((r) => r.metrics.model_switches > 0),
    tool_call_error_rate: toolCallErrorRate(list),
    // Overload is deliberately still friction here: a 529 is a turn that
    // failed, and the person waited for it, even though it says nothing about
    // their quota. It is `errors` that carries it, so this needs no new term.
    friction_free: frac((r) => r.metrics.errors === 0 && r.metrics.rate_limit_hits === 0 && r.metrics.interrupts === 0 && r.metrics.model_switches === 0),
    duration_median_s: percentile(list.map((r) => r.duration_s), 50),
    ...signalSummary(list),
    ...economics(list),
    score: null,
  };
  g.score = scoreGroup(g);
  return g;
}

type SignalFields = Pick<Group,
  'correction_rate' | 'reprompt_rate' | 'frustration_rate' | 'pushback_rate' |
  'clarification_rate' | 'edit_without_read_rate' | 'abandoned_rate' | 'n_signals'>;

/**
 * Means of the per-session rates, over the sessions that have signals at all.
 * A session whose denominator was zero (no user turns, no edits) contributes
 * nothing to that particular rate rather than contributing a zero, which is
 * why each mean is taken over its own non-null list.
 */
function signalSummary(list: Row[]): SignalFields {
  const withSig = list.map((r) => r.signals).filter((x): x is Signals => x != null);
  if (withSig.length === 0) {
    return {
      correction_rate: null, reprompt_rate: null, frustration_rate: null, pushback_rate: null,
      clarification_rate: null, edit_without_read_rate: null, abandoned_rate: null, n_signals: 0,
    };
  }
  const rates = withSig.map(signalRates);
  const m = (f: (x: (typeof rates)[number]) => number | null) => mean(rates.map(f).filter((x): x is number => x != null));
  return {
    correction_rate: m((x) => x.correction_rate),
    reprompt_rate: m((x) => x.reprompt_rate),
    frustration_rate: m((x) => x.frustration_rate),
    pushback_rate: m((x) => x.pushback_rate),
    clarification_rate: m((x) => x.clarification_rate),
    edit_without_read_rate: m((x) => x.edit_without_read_rate),
    abandoned_rate: withSig.filter((x) => x.abandoned).length / withSig.length,
    n_signals: withSig.length,
  };
}

/**
 * How much of the session was the human steering rather than the model
 * working: corrections, restatements and "no, stop" per user turn. Lower is
 * better. Null when the group has no signals, or no session in it had a user
 * turn to divide by.
 */
export function steeringRate(g: Group): number | null {
  if (g.n_signals === 0) return null;
  const parts = [g.correction_rate, g.reprompt_rate, g.pushback_rate].filter((x): x is number => x != null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** Per-session steering, for a row: the same quantity `steeringRate` means. */
export function rowSteering(r: Row): number | null {
  const s = r.signals;
  if (!s || s.user_turns === 0) return null;
  return (s.corrections + s.reprompts + s.pushback) / s.user_turns;
}

/**
 * Share of tool calls the model emitted that failed to parse or violated the
 * schema. Over calls, not sessions: one session with 200 calls and two
 * failures is not the same as one with two calls and two failures. This is
 * the number that differs most between hosts of the same weights.
 */
function toolCallErrorRate(list: Row[]): number | null {
  const calls = list.reduce((a, r) => a + r.metrics.tool_calls, 0);
  if (calls === 0) return null;
  return list.reduce((a, r) => a + (r.metrics.tool_call_errors ?? 0), 0) / calls;
}

/**
 * Composite 0..100. Published formula, deliberately simple:
 *   rating   (mean 1..5 -> 0..1)   weight 0.55 when ratings exist
 *   survival (mean ratio)          weight 0.30
 *   friction_free                  weight 0.15
 * Missing components are dropped and the remaining weights renormalised.
 * Anything with n < 3 gets no score at all.
 */
export function scoreGroup(g: Group): number | null {
  if (g.n < 3) return null;
  const parts: Array<[number, number]> = [];
  if (g.rating_mean != null && g.n_rated >= 3) parts.push([(g.rating_mean - 1) / 4, 0.55]);
  if (g.survival_mean != null && g.n_survival >= 3) parts.push([g.survival_mean, 0.30]);
  parts.push([g.friction_free, 0.15]);
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  return Math.round((parts.reduce((a, [v, w]) => a + v * w, 0) / wsum) * 100);
}

export interface WeekPoint { week: string; n: number; rating_mean: number | null; friction_free: number; survival_mean: number | null; latency_p50_ms: number | null; score: number | null }

export interface Drift {
  model: string;
  current: WeekPoint;
  baseline_weeks: string[];
  rating_z: number | null;
  friction_z: number | null;
  /** Steering (corrections + reprompts + pushback per user turn). Up is bad. */
  steering_z: number | null;
  latency_z: number | null;
  flag: 'none' | 'watch' | 'alert';
}

/** Per-week series for one model, oldest first. */
export function weekly(rows: Row[]): WeekPoint[] {
  return aggregate(rows, ['week'])
    .map((g) => ({ week: g.key.week!, n: g.n, rating_mean: g.rating_mean, friction_free: g.friction_free, survival_mean: g.survival_mean, latency_p50_ms: g.latency_p50_ms, score: g.score }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * Compare the latest week against the trailing `baselineWeeks` weeks.
 * This is change detection, not a verdict: it says "something moved", and
 * the dashboard is expected to show the raw numbers next to it.
 */
export function drift(rows: Row[], model: string, baselineWeeks = 4): Drift | null {
  const mine = rows.filter((r) => r.model === model);
  const weeks = [...new Set(mine.map((r) => r.week))].sort();
  if (weeks.length < 2) return null;
  const currentWeek = weeks.at(-1)!;
  const baseWeeks = weeks.slice(Math.max(0, weeks.length - 1 - baselineWeeks), -1);
  const cur = mine.filter((r) => r.week === currentWeek);
  const base = mine.filter((r) => baseWeeks.includes(r.week));
  const pick = (list: Row[], f: (r: Row) => number | null) => list.map(f).filter((x): x is number => x != null);
  const rating_z = driftZ(pick(cur, (r) => r.rating), pick(base, (r) => r.rating));
  const friction_z = driftZ(
    cur.map((r) => (r.metrics.errors + r.metrics.rate_limit_hits + r.metrics.interrupts + r.metrics.model_switches === 0 ? 1 : 0)),
    base.map((r) => (r.metrics.errors + r.metrics.rate_limit_hits + r.metrics.interrupts + r.metrics.model_switches === 0 ? 1 : 0)),
  );
  const steering_z = driftZ(pick(cur, rowSteering), pick(base, rowSteering));
  const latency_z = driftZ(pick(cur, (r) => r.metrics.latency_p50_ms), pick(base, (r) => r.metrics.latency_p50_ms));
  // rating and friction_free are "higher is better", so a drop is the alarm;
  // latency and steering are "lower is better", so a rise is.
  const worst = Math.max(...[rating_z, friction_z].map((z) => (z == null ? 0 : -z)), latency_z ?? 0, steering_z ?? 0);
  const flag: Drift['flag'] = cur.length < 5 ? 'none' : worst >= 3 ? 'alert' : worst >= 2 ? 'watch' : 'none';
  const wk = weekly(cur)[0]!;
  return { model, current: wk, baseline_weeks: baseWeeks, rating_z, friction_z, steering_z, latency_z, flag };
}

// ---- Subscription value -------------------------------------------------
// "What do people actually get for $200 a month?" One row per reporter-week
// per tool+plan, then medians across reporters so one heavy user cannot
// define the plan. The unit is a week, not a month, because the public
// reporter id rotates weekly: a monthly bucket would silently split into
// four unrelated reporters. The plan price is pro-rated to the week.

const WEEKS_PER_MONTH = 30.44 / 7;

export interface ReporterWeek {
  reporter: string;
  tool: Tool;
  plan_id: string;
  plan_usd_month: number | null;  // list price, for display
  plan_usd_week: number | null;   // pro-rata, what the ratios are computed against
  week: string;                   // ISO week, e.g. 2026-W38
  month: string;                  // deprecated alias of `week`, kept so older callers compile
  sessions: number;
  successes: number;
  api_equiv_usd: number | null;   // what the same tokens would cost at API list prices
  limit_hits: number;             // sessions with a rate-limit hit
  limit_peak_pct: number | null;  // highest reported window usage
  hours: number;
}

export interface PlanSummary {
  tool: Tool;
  plan_id: string;
  plan_usd_month: number | null;
  reporter_weeks: number;
  reporter_months: number;                // reporter_weeks / 4.35, rounded: the old unit, for the UI
  reporters: number;
  sessions_median: number | null;         // per reporter-week
  successes_median: number | null;
  api_equiv_median: number | null;
  value_multiple_median: number | null;   // api_equiv / pro-rata plan price: 4.0 means $4 of API usage per $1 paid
  cost_per_success_median: number | null; // pro-rata plan price / successes in the week
  limit_hit_share: number;                // reporter-weeks that hit a limit at least once
  hours_median: number | null;
}

export function reporterWeeks(rows: Row[]): ReporterWeek[] {
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.plan_id) continue;
    const key = [r.reporter ?? 'me', r.tool, r.plan_id, r.week].join(' | ');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }
  const out: ReporterWeek[] = [];
  for (const [, list] of buckets) {
    const first = list[0]!;
    const priced = list.map((r) => costUsd(r.model_ref ?? r.model, r.metrics)).filter((x): x is number => x != null);
    const peaks = list.map((r) => r.metrics.limit_used_pct).filter((x): x is number => x != null);
    const month = first.plan_usd_month ?? null;
    out.push({
      reporter: first.reporter ?? 'me',
      tool: first.tool,
      plan_id: first.plan_id!,
      plan_usd_month: month,
      plan_usd_week: month == null ? null : month / WEEKS_PER_MONTH,
      week: first.week,
      month: first.week,
      sessions: list.length,
      successes: list.filter((r) => isSuccess(r) === true).length,
      api_equiv_usd: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
      limit_hits: list.filter((r) => r.metrics.rate_limit_hits > 0).length,
      limit_peak_pct: peaks.length ? Math.max(...peaks) : null,
      hours: list.reduce((a, r) => a + hoursOf(r), 0),
    });
  }
  return out;
}

/** @deprecated the unit is a reporter-week now; this is the same function. */
export const reporterMonths = reporterWeeks;

export function planSummaries(rows: Row[]): PlanSummary[] {
  const rws = reporterWeeks(rows);
  const buckets = new Map<string, ReporterWeek[]>();
  for (const rw of rws) {
    const key = rw.tool + ' | ' + rw.plan_id;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(rw);
  }
  const out: PlanSummary[] = [];
  for (const [, list] of buckets) {
    const f = list[0]!;
    const weekly = f.plan_usd_week;
    const med = (xs: Array<number | null>) => percentile(xs.filter((x): x is number => x != null), 50);
    out.push({
      tool: f.tool,
      plan_id: f.plan_id,
      plan_usd_month: f.plan_usd_month,
      reporter_weeks: list.length,
      reporter_months: Math.round(list.length / WEEKS_PER_MONTH),
      reporters: new Set(list.map((x) => x.reporter)).size,
      sessions_median: med(list.map((x) => x.sessions)),
      successes_median: med(list.map((x) => x.successes)),
      api_equiv_median: med(list.map((x) => x.api_equiv_usd)),
      value_multiple_median: weekly ? med(list.map((x) => (x.api_equiv_usd == null ? null : x.api_equiv_usd / weekly))) : null,
      cost_per_success_median: weekly ? med(list.map((x) => (x.successes > 0 ? weekly / x.successes : null))) : null,
      limit_hit_share: list.filter((x) => x.limit_hits > 0).length / list.length,
      hours_median: med(list.map((x) => x.hours)),
    });
  }
  return out.sort((a, b) => (b.value_multiple_median ?? -1) - (a.value_multiple_median ?? -1) || b.reporter_weeks - a.reporter_weeks);
}

export function isSuccess(r: Row): boolean | null {
  if (r.rating != null) return r.rating >= 4;
  if (r.kept === 'kept') return true;
  if (r.kept === 'reverted') return false;
  if (r.survival_ratio != null) return r.survival_ratio >= 0.6;
  return null;
}

export function isFailure(r: Row): boolean {
  if (r.rating != null && r.rating <= 2) return true;
  if (r.kept === 'reverted') return true;
  if (r.rating == null && r.survival_ratio != null && r.survival_ratio < 0.2) return true;
  return false;
}

/** Cost, cost per success, and waste. Only sessions on priced models count. */
export function economics(list: Row[]): Pick<Group, 'success_rate' | 'cost_mean' | 'cost_per_success' | 'waste_share' | 'n_priced'> {
  const judged = list.map(isSuccess).filter((x): x is boolean => x != null);
  const success_rate = judged.length ? judged.filter(Boolean).length / judged.length : null;
  const priced = list.map((r) => ({ r, c: costUsd(r.model_ref ?? r.model, r.metrics) })).filter((x): x is { r: Row; c: number } => x.c != null);
  if (priced.length === 0) return { success_rate, cost_mean: null, cost_per_success: null, waste_share: null, n_priced: 0 };
  const total = priced.reduce((a, x) => a + x.c, 0);
  const successes = priced.filter((x) => isSuccess(x.r) === true).length;
  const wasted = priced.filter((x) => isFailure(x.r)).reduce((a, x) => a + x.c, 0);
  return {
    success_rate,
    cost_mean: total / priced.length,
    cost_per_success: successes > 0 ? total / successes : null,
    waste_share: total > 0 ? wasted / total : null,
    n_priced: priced.length,
  };
}
