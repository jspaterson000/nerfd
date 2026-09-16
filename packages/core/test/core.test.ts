import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA, CRITERION_HELP, aggregate, classifyPrompt, drift, emptyMetrics, emptySignals, hoursOf, isAutomatedSession, isoWeek, planSummaries, reporterWeeks, scoreGroup, steeringRate, summarise, tierModels, validateReport, wilson, type Row, type Signals } from '../src/index.ts';

test('classifyPrompt picks the strongest signal', () => {
  assert.equal(classifyPrompt('fix the failing test, it throws on empty input'), 'debug');
  assert.equal(classifyPrompt('refactor the parser into smaller functions'), 'refactor');
  assert.equal(classifyPrompt('make the modal responsive and fix the dark mode colours'), 'ux');
  assert.equal(classifyPrompt('should we build or buy, what are the trade-offs'), 'strategy');
  assert.equal(classifyPrompt(''), 'other');
  assert.equal(classifyPrompt(null), 'other');
});

test('wilson interval is bounded and narrows with n', () => {
  const a = wilson(8, 10), b = wilson(80, 100);
  assert.ok(a.lo >= 0 && a.hi <= 1);
  assert.ok(b.hi - b.lo < a.hi - a.lo);
  assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 0 });
});

test('isoWeek matches ISO 8601', () => {
  assert.equal(isoWeek('2026-09-16T00:00:00Z'), '2026-W38');
  assert.equal(isoWeek('2024-12-30T00:00:00Z'), '2025-W01');
  assert.equal(isoWeek('2021-01-03T00:00:00Z'), '2020-W53');
});

function row(over: Omit<Partial<Row>, 'metrics'> & { metrics?: Partial<Row['metrics']> } = {}): Row {
  return {
    reporter: 'r1', tool: 'claude-code', model: 'm1', effort: null, plan_id: 'claude-max-20x', plan_usd_month: 200,
    week: '2026-W38', ended_at: '2026-09-16T00:00:00Z',
    category: 'code', size: 'm', repo: { lang: 'ts', size: 'm', age: 'established' }, duration_s: 600,
    rating: 4, kept: 'kept', survival_ratio: 0.9,
    ...over,
    metrics: { ...emptyMetrics(), prompts: 3, turns: 10, ...(over.metrics ?? {}) },
  };
}

test('validateReport accepts a good record and rejects a bad one', () => {
  const good = {
    report_id: 'r1', reporter_id: 'abc', client_version: '0.1.0', tool: 'claude-code', tool_version: '2.1.0',
    model: 'm1', effort: 'high', week: '2026-W38', ended_at: '2026-09-16T00:00:00Z', category: 'code', size: 'm',
    repo: { lang: 'ts', size: 'm', age: 'established' }, duration_s: 600, metrics: emptyMetrics(),
    rating: 4, kept: 'kept', survival_ratio: 0.9, evidence_url: null,
  };
  assert.equal(validateReport(good), null);
  assert.match(validateReport({ ...good, rating: 9 }) ?? '', /rating/);
  assert.match(validateReport({ ...good, category: 'vibes' }) ?? '', /category/);
  assert.match(validateReport({ ...good, evidence_url: 'https://evil.example/x' }) ?? '', /evidence_url/);
  assert.match(validateReport({ ...good, week: '2026-38' }) ?? '', /week/);

  // Active time: absent is fine (older clients), null is fine, negative is not.
  const { active_s: _drop, ...older } = good.metrics;
  assert.equal(validateReport({ ...good, metrics: older }), null);
  assert.equal(validateReport({ ...good, metrics: { ...good.metrics, active_s: 1800 } }), null);
  assert.match(validateReport({ ...good, metrics: { ...good.metrics, active_s: -1 } }) ?? '', /active_s/);
  assert.match(validateReport({ ...good, metrics: { ...good.metrics, active_s: 8 * 86400 } }) ?? '', /active_s/);
});

test('hours are active time, and a resumed session is not days of work', () => {
  const threeDays = 3 * 86400;
  // Active time wins outright where the adapter could compute it.
  assert.equal(hoursOf({ duration_s: threeDays, metrics: { ...emptyMetrics(), active_s: 1800 } }), 0.5);
  // Without it, the wall-clock span is believed only up to four hours.
  assert.equal(hoursOf({ duration_s: threeDays, metrics: emptyMetrics() }), 4);
  assert.equal(hoursOf({ duration_s: 900, metrics: emptyMetrics() }), 0.25);
  assert.equal(hoursOf({ duration_s: null, metrics: emptyMetrics() }), 0);

  // And the plan's weekly hours are the same quantity, not the wall span.
  const [week] = reporterWeeks([
    row({ duration_s: threeDays, metrics: { ...emptyMetrics(), active_s: 1800 } }),
    row({ duration_s: 1800, metrics: emptyMetrics() }),
  ]);
  assert.equal(week!.hours, 1);
});

test('aggregate scores only with n >= 3 and drops missing parts', () => {
  const rows = [row(), row({ rating: 5 }), row({ rating: 3, metrics: { errors: 1 } })];
  const [g] = aggregate(rows, ['model']);
  assert.equal(g!.n, 3);
  assert.equal(g!.rating_mean, 4);
  assert.ok(g!.score != null && g!.score > 50);
  const small = summarise({ model: 'x' }, rows.slice(0, 2));
  assert.equal(scoreGroup(small), null);
  const unrated = aggregate(rows.map((r) => ({ ...r, rating: null })), ['model'])[0]!;
  assert.equal(unrated.rating_mean, null);
  assert.ok(unrated.score != null); // survival + friction still score
});

test('economics: cost per success, waste, and subscription value', () => {
  const tokens = { tokens_in: 100_000, tokens_out: 10_000, tokens_cache_read: 1_000_000 };
  // claude-opus-5: 0.1*5 + 0.01*25 + 1*0.5 = $1.25 per session
  const rows = [
    row({ model: 'claude-opus-5', rating: 5, metrics: tokens }),
    row({ model: 'claude-opus-5', rating: 4, metrics: tokens }),
    row({ model: 'claude-opus-5', rating: 1, metrics: tokens }),  // failure: waste
    row({ model: 'claude-opus-5', rating: null, kept: 'kept', metrics: tokens }),
  ];
  const [g] = aggregate(rows, ['model']);
  assert.equal(g!.n_priced, 4);
  assert.ok(Math.abs(g!.cost_mean! - 1.25) < 1e-9);
  assert.ok(Math.abs(g!.cost_per_success! - (5 / 3)) < 1e-9);   // $5 total / 3 successes
  assert.ok(Math.abs(g!.waste_share! - 0.25) < 1e-9);
  assert.equal(aggregate([row({ model: 'unknown-model' })], ['model'])[0]!.cost_mean, null);

  // The unit is a reporter-week, and the plan price is pro-rated to it,
  // because the public reporter id rotates every week.
  const weekly = 200 * 7 / 30.44;
  const [p] = planSummaries(rows);
  assert.equal(p!.plan_id, 'claude-max-20x');
  assert.equal(p!.reporters, 1);
  assert.equal(p!.reporter_weeks, 1);
  assert.equal(p!.sessions_median, 4);
  assert.equal(p!.successes_median, 3);
  assert.ok(Math.abs(p!.value_multiple_median! - 5 / weekly) < 1e-9);
  assert.ok(Math.abs(p!.cost_per_success_median! - weekly / 3) < 1e-9);
});

test('tiers rank relative to the best and skip thin models', () => {
  const mk = (model: string, rating: number, n: number) => Array.from({ length: n }, () => row({ model, rating, metrics: { tokens_in: 1000, tokens_out: 100, tokens_cache_read: 0 } }));
  const rows = [...mk('claude-opus-5', 5, 12), ...mk('claude-sonnet-5', 3, 12), ...mk('claude-haiku-4-5', 4, 2)];
  const tiers = tierModels(aggregate(rows, ['model']), 10);
  assert.equal(tiers[0]!.model, 'claude-opus-5');
  assert.equal(tiers[0]!.criteria.quality.tier, 'S');
  assert.equal(tiers.find((t) => t.model === 'claude-sonnet-5')!.criteria.quality.tier, 'B');
  assert.equal(tiers.find((t) => t.model === 'claude-haiku-4-5')!.overall, '-');
});

test('drift flags a large drop with enough data', () => {
  const base = Array.from({ length: 20 }, (_, i) => row({ week: `2026-W3${i % 2 === 0 ? 6 : 7}`, ended_at: '2026-09-02T00:00:00Z', rating: 4 + (i % 2) }));
  const cur = Array.from({ length: 8 }, () => row({ week: '2026-W38', rating: 1, metrics: { errors: 2, interrupts: 1 } }));
  const d = drift([...base, ...cur], 'm1');
  assert.ok(d);
  assert.equal(d!.flag, 'alert');
  assert.ok(d!.rating_z! < -3);
  assert.equal(drift(cur, 'm1'), null); // single week: nothing to compare
});


/** A session with the behaviour dialled in: `n` of everything over `turns` prompts. */
function sig(over: Partial<Signals> = {}): Signals {
  return { ...emptySignals(), user_turns: 4, assistant_turns: 4, ...over };
}

test('validateReport rejects text smuggled into signals', () => {
  const good = {
    report_id: 'r1', reporter_id: 'abc', client_version: '0.1.0', tool: 'claude-code', tool_version: '2.1.0',
    model: 'm1', effort: 'high', week: '2026-W38', ended_at: '2026-09-16T00:00:00Z', category: 'code', size: 'm',
    repo: { lang: 'ts', size: 'm', age: 'established' }, duration_s: 600, metrics: emptyMetrics(),
    rating: 4, kept: 'kept', survival_ratio: 0.9, evidence_url: null,
  };
  // A client that predates signals is still valid.
  assert.equal(validateReport(good), null);
  assert.equal(validateReport({ ...good, signals: sig(), signal_version: 1 }), null);

  // The whole privacy argument is that Signals has no string field, so a
  // string anywhere inside it is a transcript leak, not a rounding error.
  assert.match(validateReport({ ...good, signals: { ...sig(), corrections: 'lots' } }) ?? '', /must not be a string/);
  assert.match(validateReport({ ...good, signals: { ...sig(), abandoned: 'yes' } }) ?? '', /must not be a string/);
  assert.match(validateReport({ ...good, signals: { ...sig(), first_prompt: 'fix the parser' } }) ?? '', /must not be a string/);

  assert.match(validateReport({ ...good, signals: { ...sig(), corrections: -1 } }) ?? '', /signals.corrections/);
  assert.match(validateReport({ ...good, signals: { ...sig(), corrections: 1e9 } }) ?? '', /signals.corrections/);
  assert.match(validateReport({ ...good, signals: { ...sig(), abandoned: null } }) ?? '', /signals.abandoned/);
  assert.match(validateReport({ ...good, signals: { ...sig(), steering_ratio: 'long' } }) ?? '', /must not be a string/);
  assert.equal(validateReport({ ...good, signals: { ...sig(), steering_ratio: null } }), null);
  assert.match(validateReport({ ...good, signals: [] }) ?? '', /signals invalid/);
  assert.match(validateReport({ ...good, signals: sig(), signal_version: -1 }) ?? '', /signal_version/);
});

test('aggregate averages per-session signal rates over the sessions that have them', () => {
  const rows = [
    row({ signals: sig({ corrections: 2, reprompts: 1, pushback: 1, frustration: 2, clarifications: 1, abandoned: true }) }),
    row({ signals: sig({ corrections: 0, reprompts: 1, pushback: 1, edit_tool_calls: 4, edits_without_read: 1 }) }),
    row(), // no signals: contributes to n, not to the rates
  ];
  const [g] = aggregate(rows, ['model']);
  assert.equal(g!.n, 3);
  assert.equal(g!.n_signals, 2);
  assert.equal(g!.correction_rate, 0.25);          // mean of 0.5 and 0
  assert.equal(g!.reprompt_rate, 0.25);
  assert.equal(g!.pushback_rate, 0.25);
  assert.equal(g!.frustration_rate, 0.25);
  assert.equal(g!.clarification_rate, 0.125);      // per assistant turn
  assert.equal(g!.edit_without_read_rate, 0.25);   // only one session edited anything
  assert.equal(g!.abandoned_rate, 0.5);
  assert.equal(steeringRate(g!), 0.75);            // corrections + reprompts + pushback

  // No signals anywhere: nulls, not zeroes, so a thin week cannot look calm.
  const none = aggregate([row(), row()], ['model'])[0]!;
  assert.equal(none.n_signals, 0);
  assert.equal(none.correction_rate, null);
  assert.equal(none.abandoned_rate, null);
  assert.equal(steeringRate(none), null);

  // The published score is unchanged by any of this.
  assert.equal(aggregate(rows, ['model'])[0]!.score, aggregate(rows.map((r) => ({ ...r, signals: null })), ['model'])[0]!.score);
});

test('steering is a tier criterion, and lower is better', () => {
  assert.deepEqual([...CRITERIA], ['quality', 'reliability', 'steering', 'survival', 'speed', 'value']);
  assert.match(CRITERION_HELP.steering, /correct|steer/i);
  const mk = (model: string, s: Signals, n: number) => Array.from({ length: n }, () => row({ model, signals: s }));
  const rows = [
    ...mk('calm-model', sig({ corrections: 0, reprompts: 0, pushback: 0 }), 12),
    ...mk('fighty-model', sig({ corrections: 2, reprompts: 1, pushback: 1 }), 12),
  ];
  const tiers = tierModels(aggregate(rows, ['model']), 10);
  const calm = tiers.find((t) => t.model === 'calm-model')!;
  const fighty = tiers.find((t) => t.model === 'fighty-model')!;
  assert.equal(calm.criteria.steering.value, 0);
  assert.equal(calm.criteria.steering.display, '0%');
  assert.equal(calm.criteria.steering.tier, 'S');
  assert.equal(fighty.criteria.steering.display, '100%');   // one steering turn per prompt
  assert.equal(fighty.criteria.steering.tier, 'C');
  // A model with no signals is not punished for it.
  const quiet = tierModels(aggregate(mk('quiet-model', sig(), 12).map((r) => ({ ...r, signals: null })), ['model']), 10)[0]!;
  assert.equal(quiet.criteria.steering.tier, '-');
  assert.equal(quiet.criteria.steering.display, '-');
});

test('drift watches steering as well as rating and latency', () => {
  const calm = sig({ corrections: 0, reprompts: 0, pushback: 0 });
  const base = Array.from({ length: 20 }, (_, i) => row({
    week: `2026-W3${i % 2 === 0 ? 6 : 7}`, ended_at: '2026-09-02T00:00:00Z',
    signals: i % 2 === 0 ? calm : sig({ corrections: 1 }),
  }));
  const cur = Array.from({ length: 8 }, (_, i) => row({ week: '2026-W38', signals: sig({ corrections: 3, reprompts: 2, pushback: 2 + (i % 2) }) }));
  const d = drift([...base, ...cur], 'm1')!;
  assert.ok(d.steering_z != null && d.steering_z > 3, `steering_z was ${d.steering_z}`);
  assert.equal(d.flag, 'alert');
  // Nothing to compare when no session carries signals.
  assert.equal(drift([...base, ...cur].map((r) => ({ ...r, signals: null })), 'm1')!.steering_z, null);
});

test('the automated flag survives redaction and the validator', () => {
  const base = {
    report_id: 'r1', reporter_id: 'abc', client_version: '0.1.0', tool: 'claude-code', tool_version: '2.1.0',
    model: 'm1', effort: 'high', week: '2026-W38', ended_at: '2026-09-16T00:00:00Z', category: 'code', size: 'm',
    repo: { lang: 'ts', size: 'm', age: 'established' }, duration_s: 600, metrics: emptyMetrics(),
    rating: 4, kept: 'kept', survival_ratio: 0.9, evidence_url: null,
  };
  assert.equal(validateReport({ ...base, automated: true }), null);
  assert.equal(validateReport({ ...base, automated: false }), null);
  // A client that predates the flag sends nothing, and is still valid.
  assert.equal(validateReport(base), null);
  assert.equal(validateReport({ ...base, automated: 'yes' }), 'automated invalid');

  // A session with no human prompt and no human turn is automated; one with
  // either is not. Both counters must be zero, because a hook that never saw a
  // prompt still has turns in the transcript, and vice versa.
  const m = emptyMetrics();
  assert.equal(isAutomatedSession({ metrics: m }), true);
  assert.equal(isAutomatedSession({ metrics: { ...m, prompts: 1 } }), false);
  assert.equal(isAutomatedSession({ metrics: m, signals: { ...emptySignals(), user_turns: 2 } }), false);
});
