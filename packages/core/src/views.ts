import { aggregate, drift, rowSteering, steeringRate, type Drift, type Group, type Row } from './aggregate.ts';
import { lookupModel } from './catalog.ts';
import { familyTable } from './modelref.ts';
import { driftZ } from './stats.ts';
import { CRITERIA, tierModels, type Criterion, type Tier, type TierRow } from './tiers.ts';
import { CATEGORIES, type Category } from './types.ts';

// Two views built on the same aggregator as the boards, so a model page and
// a "best at debugging" card never disagree with the tier table.
//
//   modelView  - one model: where it ranks, on what work, and how it has
//                moved week by week since it was first seen.
//   workBoard  - one card per kind of work: who is best at it right now.
//
// Both take rows a person actually steered (the caller filters), and the same
// minimum session count the tier board uses, so "rank 2 of 6" means the same
// thing everywhere.

/** Lower is better for these; the rest are higher-is-better. */
const LOWER_BETTER: ReadonlySet<Criterion> = new Set(['steering', 'speed', 'value']);

export interface CriterionStanding {
  criterion: Criterion;
  tier: Tier;
  value: number | null;
  display: string;
  lower_better: boolean;
  rank: number | null;      // 1 = best in the field on this criterion
  of: number;               // models with enough sessions AND a value for it
  best: { model: string; display: string } | null;
}

export interface CategoryStanding {
  category: Category;
  n: number;                // this model's sessions on this work
  n_field: number;          // everyone's sessions on this work
  eligible: boolean;        // n >= min_n, so the rank means something
  tier: Tier;               // overall band within this category's field
  score: number | null;
  rank: number | null;
  of: number;               // eligible models in this category
  best: { model: string; score: number | null } | null;
  rating_mean: number | null;
  n_rated: number;
  success_rate: number | null;
  survival_mean: number | null;
  friction_free: number;
  steering: number | null;
  cost_per_success: number | null;
}

export type Move = { metric: 'rating' | 'clean' | 'steering' | 'survival' | 'latency'; z: number; direction: 'worse' | 'better' };

export interface ModelWeek {
  week: string;
  n: number;
  n_rated: number;
  score: number | null;
  field_score: number | null;        // every model that week, same formula
  rating_mean: number | null;
  friction_free: number;
  survival_mean: number | null;
  steering: number | null;
  latency_p50_ms: number | null;
  error_rate: number;
  rate_limit_rate: number;
  cost_per_success: number | null;
  tools: string[];
  efforts: string[];
  // Change detection against the trailing four weeks, computed for every
  // week and not just the latest, so "when did it move" has an answer.
  rating_z: number | null;
  clean_z: number | null;
  steering_z: number | null;
  survival_z: number | null;
  latency_z: number | null;
  flag: 'none' | 'watch' | 'alert';
  moved: Move[];
}

export interface PeriodShift {
  from: string[];           // the earliest weeks on record
  to: string[];             // the latest weeks on record
  n_from: number;
  n_to: number;
  score_from: number | null;
  score_to: number | null;
  moves: Move[];            // |z| >= 2 between the two periods
  verdict: 'worse' | 'better' | 'mixed' | 'steady' | 'insufficient';
}

export interface ModelView {
  model: string;
  weeks: number;
  n: number;
  n_field: number;
  min_n: number;
  identity: {
    family: string | null;
    display: string | null;
    vendor: string | null;
    open_weights: boolean | null;
    version: string | null;
    released: string | null;             // YYYY-MM-DD from the catalogue, else YYYY-MM from the family table
    released_source: 'catalogue' | 'family-table' | null;
    serving_modes: string[];
    providers: string[];
    tools: string[];
    plans: Array<{ plan_id: string; n: number }>;
  };
  first_week: string | null;
  last_week: string | null;
  weeks_seen: number;
  overall: { group: Group; tier: Tier; score: number | null; rank: number | null; of: number; criteria: CriterionStanding[] };
  categories: CategoryStanding[];
  weekly: ModelWeek[];
  changes: ModelWeek[];               // the weeks that carry a flag
  shift: PeriodShift;
  drift: Drift | null;
  breakdown: { tool: Group[]; lang: Group[]; size: Group[]; effort: Group[]; plan: Group[] };
  hosts: Group[];                     // same family, by provider x quant x serving mode
}

const order: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3, '-': 4 };

/**
 * Everything one model page needs. `rows` is the whole field, already
 * reduced to sessions a person steered; the model is ranked against it.
 * Null when the model has no sessions in the window.
 */
export function modelView(rows: Row[], model: string, minN: number, weeks: number): ModelView | null {
  const mine = rows.filter((r) => r.model === model);
  if (mine.length === 0) return null;

  const fieldTiers = tierModels(aggregate(rows, ['model']), minN);
  const me = fieldTiers.find((t) => t.model === model)!;
  const eligible = fieldTiers.filter((t) => t.overall !== '-');
  const group = aggregate(mine, ['model'])[0]!;

  const weekRows = weeklySeries(rows, mine);
  const weeksSeen = [...new Set(mine.map((r) => r.week))].sort();

  return {
    model,
    weeks,
    n: mine.length,
    n_field: rows.length,
    min_n: minN,
    identity: identityOf(mine),
    first_week: weeksSeen[0] ?? null,
    last_week: weeksSeen.at(-1) ?? null,
    weeks_seen: weeksSeen.length,
    overall: {
      group,
      tier: me.overall,
      score: me.score,
      rank: rankOf(eligible, me, (t) => t.score, false),
      of: eligible.filter((t) => t.score != null).length,
      criteria: CRITERIA.map((c) => criterionStanding(c, me, eligible)),
    },
    categories: categoryStandings(rows, model, minN),
    weekly: weekRows,
    changes: weekRows.filter((w) => w.flag !== 'none'),
    shift: periodShift(mine),
    drift: drift(rows, model),
    breakdown: {
      tool: aggregate(mine, ['tool']),
      lang: aggregate(mine, ['lang']),
      size: aggregate(mine, ['size']),
      effort: aggregate(mine, ['effort']),
      plan: aggregate(mine, ['plan_id']),
    },
    hosts: hostsOf(rows, mine),
  };
}

function rankOf<T>(list: T[], me: T, value: (t: T) => number | null, lowerBetter: boolean): number | null {
  const v = value(me);
  if (v == null || !list.includes(me)) return null;
  const better = list.filter((t) => { const x = value(t); return x != null && (lowerBetter ? x < v : x > v); }).length;
  return better + 1;
}

function criterionStanding(c: Criterion, me: TierRow, eligible: TierRow[]): CriterionStanding {
  const lower = LOWER_BETTER.has(c);
  const value = (t: TierRow) => t.criteria[c].value;
  const withValue = eligible.filter((t) => value(t) != null);
  const best = withValue.length
    ? withValue.reduce((a, b) => ((lower ? value(b)! < value(a)! : value(b)! > value(a)!) ? b : a))
    : null;
  return {
    criterion: c,
    tier: me.criteria[c].tier,
    value: me.criteria[c].value,
    display: me.criteria[c].display,
    lower_better: lower,
    rank: rankOf(withValue, me, value, lower),
    of: withValue.length,
    best: best ? { model: best.model, display: best.criteria[c].display } : null,
  };
}

/** One row per kind of work the model has done, ranked within that work. */
function categoryStandings(rows: Row[], model: string, minN: number): CategoryStanding[] {
  const out: CategoryStanding[] = [];
  for (const category of CATEGORIES) {
    const field = rows.filter((r) => r.category === category);
    if (!field.some((r) => r.model === model)) continue;
    const groups = aggregate(field, ['model']);
    const tiers = tierModels(groups, minN);
    const me = tiers.find((t) => t.model === model)!;
    const g = groups.find((x) => x.key.model === model)!;
    const eligible = tiers.filter((t) => t.overall !== '-' && t.score != null);
    const best = eligible[0] ?? null;
    out.push({
      category,
      n: g.n,
      n_field: field.length,
      eligible: me.overall !== '-',
      tier: me.overall,
      score: me.score,
      rank: rankOf(eligible, me, (t) => t.score, false),
      of: eligible.length,
      best: best ? { model: best.model, score: best.score } : null,
      rating_mean: g.rating_mean,
      n_rated: g.n_rated,
      success_rate: g.success_rate,
      survival_mean: g.survival_mean,
      friction_free: g.friction_free,
      steering: steeringRate(g),
      cost_per_success: g.cost_per_success,
    });
  }
  // Best work first: ranked rows by score, then unranked by n.
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? -1) - (a.score ?? -1) || b.n - a.n);
}

const clean = (r: Row) => (r.metrics.errors + r.metrics.rate_limit_hits + r.metrics.interrupts + r.metrics.model_switches === 0 ? 1 : 0);
const pick = (list: Row[], f: (r: Row) => number | null) => list.map(f).filter((x): x is number => x != null);

/**
 * The z-scores between two sets of sessions, on the five things drift
 * watches. Sign is normalised in `moves`: 'worse' always means worse.
 */
function compare(cur: Row[], base: Row[]): { rating_z: number | null; clean_z: number | null; steering_z: number | null; survival_z: number | null; latency_z: number | null; moves: Move[]; worst: number } {
  const rating_z = driftZ(pick(cur, (r) => r.rating), pick(base, (r) => r.rating));
  const clean_z = driftZ(cur.map(clean), base.map(clean));
  const steering_z = driftZ(pick(cur, rowSteering), pick(base, rowSteering));
  const survival_z = driftZ(pick(cur, (r) => r.survival_ratio), pick(base, (r) => r.survival_ratio));
  const latency_z = driftZ(pick(cur, (r) => r.metrics.latency_p50_ms), pick(base, (r) => r.metrics.latency_p50_ms));
  const moves: Move[] = [];
  const consider = (metric: Move['metric'], z: number | null, higherBetter: boolean) => {
    if (z == null || Math.abs(z) < 2) return;
    moves.push({ metric, z, direction: (higherBetter ? z < 0 : z > 0) ? 'worse' : 'better' });
  };
  consider('rating', rating_z, true);
  consider('clean', clean_z, true);
  consider('survival', survival_z, true);
  consider('steering', steering_z, false);
  consider('latency', latency_z, false);
  // The worst move in the "bad" direction, the same quantity drift() flags on.
  const worst = Math.max(0, ...[rating_z, clean_z, survival_z].map((z) => (z == null ? 0 : -z)), steering_z ?? 0, latency_z ?? 0);
  return { rating_z, clean_z, steering_z, survival_z, latency_z, moves, worst };
}

/** Per-week series for one model with the field beside it and a flag on every week. */
function weeklySeries(rows: Row[], mine: Row[], baselineWeeks = 4): ModelWeek[] {
  const field = new Map(aggregate(rows, ['week']).map((g) => [g.key.week!, g.score]));
  const groups = aggregate(mine, ['week']).sort((a, b) => a.key.week!.localeCompare(b.key.week!));
  const weeks = groups.map((g) => g.key.week!);
  return groups.map((g, i) => {
    const week = g.key.week!;
    const list = mine.filter((r) => r.week === week);
    const baseWeeks = weeks.slice(Math.max(0, i - baselineWeeks), i);
    const base = mine.filter((r) => baseWeeks.includes(r.week));
    const c = i === 0 ? null : compare(list, base);
    const flag: ModelWeek['flag'] = !c || list.length < 5 ? 'none' : c.worst >= 3 ? 'alert' : c.worst >= 2 ? 'watch' : 'none';
    return {
      week,
      n: g.n,
      n_rated: g.n_rated,
      score: g.score,
      field_score: field.get(week) ?? null,
      rating_mean: g.rating_mean,
      friction_free: g.friction_free,
      survival_mean: g.survival_mean,
      steering: steeringRate(g),
      latency_p50_ms: g.latency_p50_ms,
      error_rate: g.error_rate,
      rate_limit_rate: g.rate_limit_rate,
      cost_per_success: g.cost_per_success,
      tools: [...new Set(list.map((r) => r.tool))].sort(),
      efforts: [...new Set(list.map((r) => r.effort ?? '-'))].sort(),
      rating_z: c?.rating_z ?? null,
      clean_z: c?.clean_z ?? null,
      steering_z: c?.steering_z ?? null,
      survival_z: c?.survival_z ?? null,
      latency_z: c?.latency_z ?? null,
      flag,
      // A flag needs five sessions; a move is reported whenever it is
      // measurable, so a thin week can still say what it saw.
      moved: c?.moves ?? [],
    };
  });
}

/**
 * The earliest weeks on record against the latest: "is it different now from
 * when it arrived". Each side grows week by week until it holds at least
 * `minN` sessions, up to `span` weeks, and the two never overlap; a week
 * with two sessions in it is not a period. Fewer than two weeks, or a side
 * that still has under `minN` sessions, is 'insufficient' rather than a
 * verdict on noise.
 */
export function periodShift(mine: Row[], span = 4, minN = 5): PeriodShift {
  const weeks = [...new Set(mine.map((r) => r.week))].sort();
  const count = new Map<string, number>();
  for (const r of mine) count.set(r.week, (count.get(r.week) ?? 0) + 1);
  const grow = (order: string[]): string[] => {
    const out: string[] = [];
    let n = 0;
    for (const w of order) { if (out.length >= span || (n >= minN && out.length >= 1)) break; out.push(w); n += count.get(w) ?? 0; }
    return out;
  };
  let from = grow(weeks);
  let to = grow([...weeks].reverse()).reverse();
  // Never let the two sides share a week; give the overlap to the later side.
  from = from.filter((w) => !to.includes(w));
  if (from.length === 0 || to.length === 0 || weeks.length < 2) {
    return { from, to, n_from: 0, n_to: 0, score_from: null, score_to: null, moves: [], verdict: 'insufficient' };
  }
  const a = mine.filter((r) => from.includes(r.week));
  const b = mine.filter((r) => to.includes(r.week));
  const score = (list: Row[]) => (list.length ? aggregate(list, ['model'])[0]!.score : null);
  const c = compare(b, a);
  const worse = c.moves.some((m) => m.direction === 'worse');
  const better = c.moves.some((m) => m.direction === 'better');
  const verdict: PeriodShift['verdict'] = a.length < minN || b.length < minN ? 'insufficient'
    : worse && better ? 'mixed' : worse ? 'worse' : better ? 'better' : 'steady';
  return { from, to, n_from: a.length, n_to: b.length, score_from: score(a), score_to: score(b), moves: c.moves, verdict };
}

function mode<T>(xs: T[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | null = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}

function identityOf(mine: Row[]): ModelView['identity'] {
  const refs = mine.map((r) => r.model_ref).filter((x): x is NonNullable<typeof x> => x != null);
  const family = mode(refs.map((r) => r.family).filter((x): x is string => x != null));
  const version = mode(refs.map((r) => r.version).filter((x): x is string => x != null));
  const def = family ? familyTable().find((f) => f.family === family) ?? null : null;
  const ver = def && version ? (def.versions ?? []).find((v) => v.version === version) ?? null : null;
  // The catalogue knows the day; the family table knows the month. Both are
  // publication dates, which is what "since release" needs.
  const hit = refs.map((r) => (r.raw_id ? lookupModel(r.provider ?? r.raw_provider, r.raw_id) : null)).find((h) => h?.model.release_date) ?? null;
  const released = hit?.model.release_date ?? ver?.released ?? null;
  const plans = new Map<string, number>();
  for (const r of mine) if (r.plan_id) plans.set(r.plan_id, (plans.get(r.plan_id) ?? 0) + 1);
  return {
    family,
    display: def?.display ?? null,
    vendor: def?.vendor ?? null,
    open_weights: def?.open_weights ?? null,
    version,
    released,
    released_source: hit?.model.release_date ? 'catalogue' : ver?.released ? 'family-table' : null,
    serving_modes: [...new Set(refs.map((r) => r.serving_mode))].sort(),
    providers: [...new Set(refs.map((r) => r.provider).filter((x): x is string => x != null))].sort(),
    tools: [...new Set(mine.map((r) => r.tool))].sort(),
    plans: [...plans].map(([plan_id, n]) => ({ plan_id, n })).sort((a, b) => b.n - a.n),
  };
}

/** Same weights, every host: rows of the same family, one per provider x quant x serving mode. */
function hostsOf(rows: Row[], mine: Row[]): Group[] {
  const family = mode(mine.map((r) => r.model_ref?.family).filter((x): x is string => x != null));
  if (!family) return [];
  const same = rows.filter((r) => r.model_ref?.family === family && r.model_ref.serving_mode !== 'router');
  return aggregate(same, ['model', 'provider', 'quant', 'serving_mode']);
}

// ---- Best at each kind of work ------------------------------------------

export interface WorkCard {
  category: Category;
  n: number;                 // sessions on this work, all models
  n_models: number;          // models with any session on it
  n_ranked: number;          // models with enough sessions to rank
  ranked: Array<{ model: string; tier: Tier; score: number | null; n: number; steering: number | null; cost_per_success: number | null; success_rate: number | null }>;
}

/** One card per kind of work, best model first. Empty categories are omitted. */
export function workBoard(rows: Row[], minN: number, top = 5): WorkCard[] {
  const out: WorkCard[] = [];
  for (const category of CATEGORIES) {
    const field = rows.filter((r) => r.category === category);
    if (field.length === 0) continue;
    const groups = aggregate(field, ['model']);
    const byModel = new Map(groups.map((g) => [g.key.model!, g]));
    const tiers = tierModels(groups, minN);
    const ranked = tiers
      .sort((a, b) => order[a.overall] - order[b.overall] || (b.score ?? -1) - (a.score ?? -1) || b.n - a.n)
      .slice(0, top)
      .map((t) => {
        const g = byModel.get(t.model)!;
        return { model: t.model, tier: t.overall, score: t.score, n: t.n, steering: steeringRate(g), cost_per_success: g.cost_per_success, success_rate: g.success_rate };
      });
    out.push({ category, n: field.length, n_models: groups.length, n_ranked: tiers.filter((t) => t.overall !== '-').length, ranked });
  }
  return out.sort((a, b) => b.n - a.n);
}
