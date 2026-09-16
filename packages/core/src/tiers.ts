import { steeringRate, type Group } from './aggregate.ts';

// Tiering. Each criterion is normalised against the best model in the set,
// then banded. This is relative, so a tier says "compared to the field this
// week", not "good in the abstract". Only models with enough sessions are
// tiered at all; the rest are listed as unranked with their n.

export type Tier = 'S' | 'A' | 'B' | 'C' | '-';

export const CRITERIA = ['quality', 'reliability', 'steering', 'survival', 'speed', 'value'] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_HELP: Record<Criterion, string> = {
  quality: 'mean rating from the people who did the work',
  reliability: 'share of sessions with no errors, rate limits, interrupts or model switches',
  steering: 'how often the human had to correct, repeat themselves or say stop, per prompt; lower is better',
  survival: 'share of added lines still present an hour or more later',
  speed: 'median response latency, lower is better',
  value: 'API-equivalent cost per successful session, lower is better',
};

export interface TierRow {
  model: string;
  n: number;
  overall: Tier;
  score: number | null;
  criteria: Record<Criterion, { tier: Tier; value: number | null; display: string }>;
  cost_per_success: number | null;
  cost_mean: number | null;
  waste_share: number | null;
}

function band(norm: number | null): Tier {
  if (norm == null) return '-';
  if (norm >= 0.92) return 'S';
  if (norm >= 0.78) return 'A';
  if (norm >= 0.6) return 'B';
  return 'C';
}

function overallBand(score: number | null): Tier {
  if (score == null) return '-';
  if (score >= 80) return 'S';
  if (score >= 65) return 'A';
  if (score >= 50) return 'B';
  return 'C';
}

const money = (v: number | null) => (v == null ? '-' : v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(1)}`);
const pct = (v: number | null) => (v == null ? '-' : `${Math.round(v * 100)}%`);

/** groups must be aggregated by ['model']. */
export function tierModels(groups: Group[], minN = 10): TierRow[] {
  const eligible = groups.filter((g) => g.n >= minN);
  const best = {
    quality: max(eligible.map((g) => g.rating_mean)),
    reliability: max(eligible.map((g) => g.friction_free)),
    steering: min(eligible.map(steeringRate)),
    survival: max(eligible.map((g) => g.survival_mean)),
    speed: min(eligible.map((g) => g.latency_p50_ms)),
    value: min(eligible.map((g) => g.cost_per_success)),
  };
  const rows: TierRow[] = groups.map((g) => {
    const ok = g.n >= minN;
    const norm = (v: number | null, b: number | null, lowerBetter = false) => {
      if (!ok || v == null || b == null) return null;
      // A best of zero is meaningful when lower is better - nobody had to
      // steer at all - so it bands rather than dropping out: matching it is
      // the top tier, anything above it is the bottom one.
      if (lowerBetter) return b === 0 ? (v === 0 ? 1 : 0) : Math.min(1, b / v);
      return b === 0 ? null : Math.min(1, v / b);
    };
    const crit = (key: Criterion, value: number | null, b: number | null, display: string, lowerBetter = false) => ({
      tier: band(norm(value, b, lowerBetter)), value, display,
    });
    return {
      model: g.key.model!,
      n: g.n,
      overall: ok ? overallBand(g.score) : '-',
      score: ok ? g.score : null,
      criteria: {
        quality: crit('quality', g.rating_mean, best.quality, g.rating_mean == null ? '-' : g.rating_mean.toFixed(2)),
        reliability: crit('reliability', g.friction_free, best.reliability, pct(g.friction_free)),
        steering: crit('steering', steeringRate(g), best.steering, pct(steeringRate(g)), true),
        survival: crit('survival', g.survival_mean, best.survival, pct(g.survival_mean)),
        speed: crit('speed', g.latency_p50_ms, best.speed, g.latency_p50_ms == null ? '-' : `${(g.latency_p50_ms / 1000).toFixed(1)}s`, true),
        value: crit('value', g.cost_per_success, best.value, money(g.cost_per_success), true),
      },
      cost_per_success: g.cost_per_success,
      cost_mean: g.cost_mean,
      waste_share: g.waste_share,
    };
  });
  const order: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3, '-': 4 };
  return rows.sort((a, b) => order[a.overall] - order[b.overall] || (b.score ?? -1) - (a.score ?? -1) || b.n - a.n);
}

function max(xs: Array<number | null>): number | null { const v = xs.filter((x): x is number => x != null); return v.length ? Math.max(...v) : null; }
function min(xs: Array<number | null>): number | null { const v = xs.filter((x): x is number => x != null); return v.length ? Math.min(...v) : null; }
