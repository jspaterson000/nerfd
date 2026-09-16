import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMetrics, estimateCapacity, planGenerosity, planSummaries, reconstructWindows,
  type LimitWindow, type Row,
} from '../src/index.ts';
import { queryData } from '../../server/src/queries.ts';

// Three reporters on one $200 plan, five hour windows, with the numbers
// chosen so every published figure can be checked by hand:
//
//   r1 / bucket 100   two sessions, Δ60%,  600k tokens -> 1,000,000
//   r2 / bucket 200   one session,  Δ50%,  600k tokens -> 1,200,000  (wall hit)
//   r3 / bucket 300   one session,  Δ25%,  200k tokens ->   800,000
//   r1 / bucket 500   the half before a reset, Δ40%, 400k -> 1,000,000
//   r1 / bucket 501   the half after it,       Δ20%, 250k -> 1,250,000
//   r3 / bucket 301   Δ10%: under the 20% floor, discarded
//   r2 / bucket 600   Δ40% over ten minutes of a five hour window: no coverage, discarded

const WINDOW_MIN = 300;
const PLAN = 'claude-max-20x';
const PLAN_USD = 200;
const WEEKS_PER_MONTH = 30.44 / 7;

/** Half of every window's tokens are uncached input plus output, so the second basis is exactly half the first. */
function tokens(total: number): LimitWindow['tokens'] {
  return { total, uncached_in: total * 0.3, out: total * 0.2, cached_in: total * 0.5 };
}

function win(over: Partial<LimitWindow>): LimitWindow {
  return {
    scope: 'five_hour', window_min: WINDOW_MIN, used_pct_start: null, used_pct_end: null,
    samples: 5, resets_in_min_end: 60, reset_bucket: null, wall_hit: false, tokens: tokens(0),
    ...over,
  };
}

function row(reporter: string, endedAt: string, durationS: number, limit_windows: LimitWindow[]): Row {
  return {
    reporter, tool: 'claude-code', model: 'claude-opus-5', effort: null,
    plan_id: PLAN, plan_usd_month: PLAN_USD,
    week: '2026-W38', ended_at: endedAt,
    category: 'code', size: 'm', repo: { lang: 'ts', size: 'm', age: 'established' },
    duration_s: durationS,
    metrics: { ...emptyMetrics(), prompts: 5, turns: 20 },
    rating: 4, kept: 'kept', survival_ratio: 0.9,
    limit_windows,
  };
}

const FOUR_HOURS = 15_000;   // 250 minutes: 83% of a five hour window
const TWO_HOURS = 9_000;     // 150 minutes

const rows: Row[] = [
  // r1, one window watched across two sessions.
  row('r1', '2026-09-16T02:30:00Z', TWO_HOURS, [win({ reset_bucket: 100, used_pct_start: 0, used_pct_end: 30, tokens: tokens(300_000) })]),
  row('r1', '2026-09-16T05:00:00Z', TWO_HOURS, [win({ reset_bucket: 100, used_pct_start: 30, used_pct_end: 60, tokens: tokens(300_000) })]),
  // r1 again: one session that ran through a reset, so it carries two entries.
  row('r1', '2026-09-16T12:00:00Z', FOUR_HOURS, [
    win({ reset_bucket: 500, used_pct_start: 60, used_pct_end: 100, tokens: tokens(400_000), resets_in_min_end: 0 }),
    win({ reset_bucket: 501, used_pct_start: 0, used_pct_end: 20, tokens: tokens(250_000), resets_in_min_end: 280 }),
  ]),
  // r2: hit the wall, and a second session whose window moved plenty in ten minutes.
  row('r2', '2026-09-16T06:00:00Z', FOUR_HOURS, [win({ reset_bucket: 200, used_pct_start: 0, used_pct_end: 50, tokens: tokens(600_000), wall_hit: true })]),
  row('r2', '2026-09-16T08:00:00Z', 600, [win({ reset_bucket: 600, used_pct_start: 0, used_pct_end: 40, tokens: tokens(900_000) })]),
  // r3: one good window and one that barely moved.
  row('r3', '2026-09-16T06:00:00Z', FOUR_HOURS, [win({ reset_bucket: 300, used_pct_start: 0, used_pct_end: 25, tokens: tokens(200_000) })]),
  row('r3', '2026-09-16T10:00:00Z', FOUR_HOURS, [win({ reset_bucket: 301, used_pct_start: 0, used_pct_end: 10, tokens: tokens(500_000) })]),
];

test('reconstructWindows groups sessions into windows and splits at a reset', () => {
  const obs = reconstructWindows(rows);
  assert.equal(obs.length, 7);

  const shared = obs.find((o) => o.reporter === 'r1' && o.reset_bucket === 100)!;
  assert.equal(shared.sessions, 2);
  assert.equal(shared.delta_pct, 60);
  assert.equal(shared.tokens_total, 600_000);
  assert.equal(shared.tokens_uncached, 300_000);
  assert.equal(shared.samples, 10);
  assert.equal(shared.usage_end_pct, 60);       // the last reading, not the first
  assert.equal(shared.elapsed_min, 300);
  assert.equal(shared.coverage, 1);

  // The session that ran through a reset is two windows, not one 60% jump.
  const before = obs.find((o) => o.reset_bucket === 500)!;
  const after = obs.find((o) => o.reset_bucket === 501)!;
  assert.equal(before.delta_pct, 40);
  assert.equal(after.delta_pct, 20);
  assert.equal(after.resets_in_min_end, 280);

  // Ten minutes of a five hour window is not a window.
  assert.ok((obs.find((o) => o.reset_bucket === 600)!.coverage ?? 0) < 0.05);
});

test('estimateCapacity discards thin windows and publishes a band', () => {
  const [e, ...rest] = estimateCapacity(reconstructWindows(rows));
  assert.equal(rest.length, 0);
  assert.equal(e!.plan_id, PLAN);
  assert.equal(e!.scope, 'five_hour');
  assert.equal(e!.window_min, WINDOW_MIN);

  // Five windows survive: the Δ10% one and the ten-minute one do not.
  assert.equal(e!.n_windows, 5);
  assert.equal(e!.n_reporters, 3);
  // Capacities: 800k, 1000k, 1000k, 1200k, 1250k.
  assert.deepEqual(e!.capacity_total, { p25: 1_000_000, p50: 1_000_000, p75: 1_200_000 });
  // The uncached basis is exactly half of every window's tokens here.
  assert.deepEqual(e!.capacity_uncached, { p25: 500_000, p50: 500_000, p75: 600_000 });
  assert.equal(e!.wall_hit_share, 0.2);         // one window of five
  assert.equal(e!.usage_median_pct, 50);        // 20, 25, 50, 60, 100
  assert.equal(e!.samples_median, 5);
});

test('a lower floor keeps the thin window and moves the band', () => {
  const loose = estimateCapacity(reconstructWindows(rows), { minDeltaPct: 10 })[0]!;
  assert.equal(loose.n_windows, 6);             // the Δ10% window is now in
  // ...and it is the most generous-looking of the lot: 500k tokens for 10%.
  assert.equal(loose.capacity_total.p75, 1_250_000);
  // Coverage is a separate filter, so the ten-minute window is still out.
  assert.equal(estimateCapacity(reconstructWindows(rows), { minDeltaPct: 10, minCoverage: 0 })[0]!.n_windows, 7);
});

test('planGenerosity prices the window and counts clean successes', () => {
  const [p, ...rest] = planGenerosity(rows, planSummaries(rows));
  assert.equal(rest.length, 0);
  assert.equal(p!.plan_id, PLAN);
  assert.equal(p!.name, 'Claude Max 20x');
  assert.equal(p!.usd_month, PLAN_USD);
  assert.equal(p!.window_min, WINDOW_MIN);
  assert.equal(p!.n, 7);

  // 1,000,000 tokens a window x 146 windows a month / $200.
  assert.equal(p!.tokens_per_dollar.p50, 730_000);
  assert.equal(p!.tokens_per_dollar.p25, 730_000);
  assert.equal(p!.tokens_per_dollar.p75, 876_000);

  // Clean successes per reporter-week: r1 3, r2 1 (the wall-hit session does
  // not count), r3 2, over the pro-rata weekly price. The median is r3's.
  const usdWeek = PLAN_USD / WEEKS_PER_MONTH;
  assert.ok(Math.abs(p!.successes_per_dollar! - 2 / usdWeek) < 1e-9);

  assert.ok(Math.abs(p!.wall_hit_share - 1 / 3) < 1e-9);   // one reporter-week of three
  assert.equal(p!.usage_median_pct, 30);                   // 10, 20, 25, 30, 40, 50, 60, 100
  assert.equal(p!.quality, 83);                            // the same composite the board shows
  assert.equal(p!.reporter_weeks, 3);
});

test('a plan with no price gets no tokens-per-dollar', () => {
  const free = rows.map((r) => ({ ...r, plan_id: 'claude-enterprise', plan_usd_month: null }));
  const [p] = planGenerosity(free, planSummaries(free));
  assert.deepEqual(p!.tokens_per_dollar, { p25: null, p50: null, p75: null });
  assert.equal(p!.successes_per_dollar, null);
  assert.equal(p!.n_windows, 5);   // the windows are still estimated
});

test('GET /v1/limits serves the plans and the windows', () => {
  const out = queryData(new URL('http://x/v1/limits?weeks=8'), () => rows, false, 'http://x');
  const body = out!.body as {
    weeks: number; n: number;
    plans: Array<{ plan_id: string; tokens_per_dollar: { p50: number | null } }>;
    windows: Array<{ scope: string; window_min: number; n_windows: number; capacity_total: { p50: number } }>;
  };
  assert.equal(body.weeks, 8);
  assert.equal(body.n, 7);
  assert.equal(body.plans.length, 1);
  assert.equal(body.plans[0]!.plan_id, PLAN);
  assert.equal(body.plans[0]!.tokens_per_dollar.p50, 730_000);
  assert.equal(body.windows.length, 1);
  assert.equal(body.windows[0]!.window_min, WINDOW_MIN);
  assert.equal(body.windows[0]!.n_windows, 5);
  assert.equal(body.windows[0]!.capacity_total.p50, 1_000_000);

  // weeks is clamped like every other endpoint, and the aggregate is in the
  // open dataset too.
  assert.equal((queryData(new URL('http://x/v1/limits?weeks=999'), () => rows, false, 'http://x')!.body as { weeks: number }).weeks, 52);
  const exported = queryData(new URL('http://x/export.json'), () => rows, false, 'http://x')!.body as { limits: { plans: unknown[]; windows: unknown[] } };
  assert.equal(exported.limits.plans.length, 1);
  assert.equal(exported.limits.windows.length, 1);
});

test('plans are ordered by tokens per dollar, best first', () => {
  const cheap = rows.map((r) => ({ ...r, reporter: `x${r.reporter}`, plan_id: 'claude-pro', plan_usd_month: 20 }));
  const ranked = planGenerosity([...rows, ...cheap], planSummaries([...rows, ...cheap]));
  assert.deepEqual(ranked.map((p) => p.plan_id), ['claude-pro', PLAN]);
});
