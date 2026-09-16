import { aggregate, isSuccess, type PlanSummary, type Row } from './aggregate.ts';
import { planById } from './plans.ts';
import { percentile } from './stats.ts';
import type { LimitScope, LimitWindow, Tool } from './types.ts';

// Tokens versus limits: what a subscription window actually holds, how much
// of it people use, how often they hit the wall, and which plan is the most
// generous per dollar. See docs/LIMITS.md - the record shape and the
// estimator are the spec, this file is only its implementation.
//
// Nothing here reads a vendor API. Every number comes from the window state
// the tool already wrote to this machine: a used percentage, a window length,
// a coarse reset bucket and the tokens spent between two readings.

/** A band, as everything public here is published: never a bare number. */
export interface Band { p25: number | null; p50: number | null; p75: number | null }

/**
 * One reconstructed window: every session a reporter ran against the same
 * limit window, summed. The unit the estimator works in - never a single
 * session pair, because a tool that quantises to whole percents makes one
 * pair wrong by up to half a percent of the window.
 */
export interface WindowObs {
  reporter: string;
  plan_id: string;             // '-' when the session carried no plan
  scope: LimitScope;
  window_min: number | null;
  reset_bucket: number | null;
  sessions: number;
  samples: number;             // readings behind the window
  delta_pct: number;           // Σ (used_pct_end - used_pct_start), sessions with both
  tokens_total: number;
  tokens_uncached: number;     // uncached input + output: the other basis
  wall_hit: boolean;
  usage_end_pct: number | null;      // used_pct_end of the last session in the window
  resets_in_min_end: number | null;  // minutes to reset at that last reading
  first_start_ms: number;
  last_end_ms: number;
  elapsed_min: number;               // first start to last end
  /** elapsed / window_min: how much of the window the sessions span. Null when the window length is unknown. */
  coverage: number | null;
}

export interface CapacityOpts {
  /** Windows that moved less than this many percent are too quantised to divide by. */
  minDeltaPct?: number;
  /** Windows whose sessions span less than this share of the window are too gappy to believe. */
  minCoverage?: number;
}

export interface CapacityEstimate {
  plan_id: string;
  scope: LimitScope;
  window_min: number | null;
  n_windows: number;                 // windows that survived the filters
  n_reporters: number;
  capacity_total: Band;              // tokens the window holds, total-token basis
  capacity_uncached: Band;           // uncached input + output basis
  usage_median_pct: number | null;   // how much of the window people actually end on
  wall_hit_share: number;            // windows in which somebody hit the wall
  samples_median: number | null;
}

export interface PlanGenerosity {
  tool: Tool;
  plan_id: string;
  name: string;
  usd_month: number | null;
  scope: LimitScope | null;          // the window the band was computed on
  window_min: number | null;
  n_windows: number;
  tokens_per_dollar: Band;           // all null when the plan has no published price
  successes_per_dollar: number | null;
  wall_hit_share: number;            // reporter-weeks with at least one wall hit
  usage_median_pct: number | null;
  quality: number | null;            // the plan's composite score, same aggregator as everywhere else
  reporter_weeks: number;
  n: number;                         // sessions on the plan
}

const WEEKS_PER_MONTH = 30.44 / 7;
/** Minutes in an average month: 43800, as docs/LIMITS.md defines it. */
export const MINUTES_PER_MONTH = 43800;

const nums = (xs: Array<number | null | undefined>): number[] => xs.filter((x): x is number => x != null && Number.isFinite(x));
const band = (xs: number[]): Band => ({ p25: percentile(xs, 25), p50: percentile(xs, 50), p75: percentile(xs, 75) });
const windowsOf = (r: Row): LimitWindow[] => r.limit_windows ?? [];

/**
 * A session hit the wall if a window said so, or the tool reported a 429 it
 * could not attribute to one. `metrics.overloaded` is deliberately not
 * consulted: a 529 says the provider's fleet was busy, not that the
 * subscription was spent, and counting it here put a wall on plans that never
 * hit one.
 */
export function rowWallHit(r: Row): boolean {
  return windowsOf(r).some((w) => w.wall_hit) || r.metrics.rate_limit_hits > 0;
}

/**
 * Sessions to windows: group by (reporter, plan, scope, window length, reset
 * bucket) and sum tokens and Δused_pct. A session with either percentage
 * missing contributes its tokens to nothing - it would inflate the numerator
 * against a denominator it never moved - so it is skipped whole.
 *
 * The output is ordered, so two runs over the same rows agree byte for byte.
 */
export function reconstructWindows(rows: Row[]): WindowObs[] {
  interface Acc extends WindowObs { lastSeenMs: number }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const endMs = Date.parse(r.ended_at);
    if (!Number.isFinite(endMs)) continue;
    const startMs = endMs - Math.max(0, r.duration_s ?? 0) * 1000;
    const reporter = r.reporter ?? 'me';
    const plan_id = r.plan_id ?? '-';
    for (const w of windowsOf(r)) {
      if (!w || typeof w.scope !== 'string') continue;
      const key = [reporter, plan_id, w.scope, w.window_min ?? '-', w.reset_bucket ?? '-'].join(' | ');
      let a = acc.get(key);
      if (!a) {
        a = {
          reporter, plan_id, scope: w.scope, window_min: w.window_min ?? null, reset_bucket: w.reset_bucket ?? null,
          sessions: 0, samples: 0, delta_pct: 0, tokens_total: 0, tokens_uncached: 0, wall_hit: false,
          usage_end_pct: null, resets_in_min_end: null,
          first_start_ms: startMs, last_end_ms: endMs, elapsed_min: 0, coverage: null, lastSeenMs: -Infinity,
        };
        acc.set(key, a);
      }
      a.sessions += 1;
      a.samples += Math.max(0, w.samples ?? 0);
      a.wall_hit ||= w.wall_hit === true;
      a.first_start_ms = Math.min(a.first_start_ms, startMs);
      a.last_end_ms = Math.max(a.last_end_ms, endMs);
      // The tokens and the movement have to come from the same session.
      if (w.used_pct_start != null && w.used_pct_end != null) {
        a.delta_pct += w.used_pct_end - w.used_pct_start;
        a.tokens_total += w.tokens?.total ?? 0;
        a.tokens_uncached += (w.tokens?.uncached_in ?? 0) + (w.tokens?.out ?? 0);
      }
      // "How full was it when you stopped" is the last reading in the window.
      if (endMs >= a.lastSeenMs) {
        a.lastSeenMs = endMs;
        if (w.used_pct_end != null) a.usage_end_pct = w.used_pct_end;
        if (w.resets_in_min_end != null) a.resets_in_min_end = w.resets_in_min_end;
      }
    }
  }
  const out = [...acc.values()].map(({ lastSeenMs: _drop, ...o }): WindowObs => {
    const elapsed_min = Math.max(0, (o.last_end_ms - o.first_start_ms) / 60_000);
    return { ...o, elapsed_min, coverage: o.window_min && o.window_min > 0 ? elapsed_min / o.window_min : null };
  });
  return out.sort((a, b) =>
    a.plan_id.localeCompare(b.plan_id) || a.scope.localeCompare(b.scope)
    || (a.window_min ?? 0) - (b.window_min ?? 0) || a.reporter.localeCompare(b.reporter)
    || (a.reset_bucket ?? 0) - (b.reset_bucket ?? 0));
}

/** A window is worth dividing by when it moved enough and was watched for enough of its length. */
export function usable(o: WindowObs, opts: CapacityOpts = {}): boolean {
  const minDelta = opts.minDeltaPct ?? 20;
  const minCoverage = opts.minCoverage ?? 0.8;
  if (!(o.delta_pct >= minDelta) || o.delta_pct <= 0) return false;
  // An unknown window length cannot be judged for coverage; it is not a reason
  // to throw the observation away.
  return o.coverage == null || o.coverage >= minCoverage;
}

/**
 * Capacity per (plan, scope, window length): `Σtokens / Σ Δpct × 100` for each
 * window, then the band across windows. Unobserved concurrent sessions bias a
 * window low and cached input biases it high, which is why this publishes p25,
 * p50 and p75 and never a single number.
 *
 * Every figure in an estimate describes the windows that survived the filters,
 * so `usage_median_pct` and `wall_hit_share` are the medians of the same set
 * `n_windows` counts.
 */
export function estimateCapacity(obs: WindowObs[], opts: CapacityOpts = {}): CapacityEstimate[] {
  const cells = new Map<string, WindowObs[]>();
  for (const o of obs) {
    if (!usable(o, opts)) continue;
    const key = [o.plan_id, o.scope, o.window_min ?? '-'].join(' | ');
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(o);
  }
  const out: CapacityEstimate[] = [];
  for (const [, list] of cells) {
    const f = list[0]!;
    out.push({
      plan_id: f.plan_id,
      scope: f.scope,
      window_min: f.window_min,
      n_windows: list.length,
      n_reporters: new Set(list.map((o) => o.reporter)).size,
      capacity_total: band(list.map((o) => (o.tokens_total / o.delta_pct) * 100)),
      capacity_uncached: band(list.map((o) => (o.tokens_uncached / o.delta_pct) * 100)),
      usage_median_pct: percentile(nums(list.map((o) => o.usage_end_pct)), 50),
      wall_hit_share: list.filter((o) => o.wall_hit).length / list.length,
      samples_median: percentile(list.map((o) => o.samples), 50),
    });
  }
  return out.sort((a, b) =>
    a.plan_id.localeCompare(b.plan_id) || (a.window_min ?? 0) - (b.window_min ?? 0) || a.scope.localeCompare(b.scope));
}

/**
 * The estimate a plan's headline is quoted from: the cell with the most
 * windows behind it, ties broken by the shorter window and then the scope
 * name, so the choice is deterministic and not a function of map order.
 */
export function headlineEstimate(est: CapacityEstimate[], planId: string): CapacityEstimate | null {
  const mine = est.filter((e) => e.plan_id === planId && e.window_min != null && e.window_min > 0 && e.capacity_total.p50 != null);
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) =>
    b.n_windows - a.n_windows || (a.window_min ?? 0) - (b.window_min ?? 0) || a.scope.localeCompare(b.scope))[0]!;
}

/**
 * What a plan gives you for the money, one row per plan. Tokens per dollar is
 * the capacity band scaled to a month of windows; successes per dollar is the
 * outcome answer to the same question, and the quality score sits beside both
 * so a cheap plan that produces nothing cannot win on price alone.
 */
export function planGenerosity(rows: Row[], plans: PlanSummary[], opts: CapacityOpts = {}): PlanGenerosity[] {
  const est = estimateCapacity(reconstructWindows(rows), opts);
  const quality = new Map(aggregate(rows, ['plan_id']).map((g) => [g.key.plan_id ?? '-', g.score]));

  // One row per plan, not per tool and plan: a subscription is one price even
  // when three tools spend it.
  const byPlan = new Map<string, PlanSummary>();
  for (const p of plans) if (!byPlan.has(p.plan_id)) byPlan.set(p.plan_id, p);

  const out: PlanGenerosity[] = [];
  for (const [plan_id, summary] of byPlan) {
    const mine = rows.filter((r) => r.plan_id === plan_id);
    const usdMonth = summary.plan_usd_month ?? null;
    const head = headlineEstimate(est, plan_id);

    // capacity per window x windows per month / price.
    const perDollar = (v: number | null): number | null => {
      if (v == null || !usdMonth || usdMonth <= 0 || !head?.window_min) return null;
      return (v * (MINUTES_PER_MONTH / head.window_min)) / usdMonth;
    };

    const weeks = reporterWeekRollup(mine, plan_id);
    const usdWeek = usdMonth == null ? null : usdMonth / WEEKS_PER_MONTH;
    const spd = usdWeek && usdWeek > 0 ? percentile(weeks.map((w) => w.clean_successes / usdWeek), 50) : null;

    out.push({
      tool: summary.tool,
      plan_id,
      name: planById(plan_id)?.name ?? plan_id,
      usd_month: usdMonth,
      scope: head?.scope ?? null,
      window_min: head?.window_min ?? null,
      n_windows: head?.n_windows ?? 0,
      tokens_per_dollar: {
        p25: perDollar(head?.capacity_total.p25 ?? null),
        p50: perDollar(head?.capacity_total.p50 ?? null),
        p75: perDollar(head?.capacity_total.p75 ?? null),
      },
      successes_per_dollar: spd,
      wall_hit_share: weeks.length ? weeks.filter((w) => w.wall_hit).length / weeks.length : 0,
      usage_median_pct: percentile(nums(mine.flatMap((r) => windowsOf(r).map((w) => w.used_pct_end))), 50),
      quality: quality.get(plan_id) ?? null,
      reporter_weeks: weeks.length,
      n: mine.length,
    });
  }
  return out.sort((a, b) =>
    (b.tokens_per_dollar.p50 ?? -1) - (a.tokens_per_dollar.p50 ?? -1)
    || (b.successes_per_dollar ?? -1) - (a.successes_per_dollar ?? -1)
    || b.n - a.n || a.plan_id.localeCompare(b.plan_id));
}

interface PlanWeek { reporter: string; week: string; sessions: number; clean_successes: number; wall_hit: boolean }

/**
 * One row per reporter-week on a plan. A "clean success" is a session that
 * succeeded without hitting the subscription wall or the context wall: the
 * work the plan actually bought, as opposed to the work it interrupted.
 * The week is the unit because the public reporter id rotates weekly.
 */
function reporterWeekRollup(rows: Row[], plan_id: string): PlanWeek[] {
  const buckets = new Map<string, PlanWeek>();
  for (const r of rows) {
    if ((r.plan_id ?? '-') !== plan_id) continue;
    const reporter = r.reporter ?? 'me';
    const key = reporter + ' | ' + r.week;
    let w = buckets.get(key);
    if (!w) { w = { reporter, week: r.week, sessions: 0, clean_successes: 0, wall_hit: false }; buckets.set(key, w); }
    w.sessions += 1;
    const wall = rowWallHit(r);
    w.wall_hit ||= wall;
    if (isSuccess(r) === true && !wall && r.metrics.context_limit_hits === 0) w.clean_successes += 1;
  }
  return [...buckets.values()].sort((a, b) => a.reporter.localeCompare(b.reporter) || a.week.localeCompare(b.week));
}
