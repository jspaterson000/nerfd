import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTexts, emptyMetrics, modelView, periodShift, workBoard, type Row } from '../src/index.ts';

// The model page and the "best at each kind of work" cards are built on the
// same aggregator as the tier board. These tests pin the three claims a
// person reads off them: where it ranks, on what work, and when it moved.

function row(over: Omit<Partial<Row>, 'metrics'> & { metrics?: Partial<Row['metrics']> } = {}): Row {
  return {
    reporter: 'r1', tool: 'claude-code', model: 'a', effort: 'high', plan_id: 'claude-max-20x', plan_usd_month: 200,
    week: '2026-W38', ended_at: '2026-09-16T00:00:00Z',
    category: 'code', size: 'm', repo: { lang: 'ts', size: 'm', age: 'established' }, duration_s: 600,
    rating: 4, kept: 'kept', survival_ratio: 0.9,
    ...over,
    metrics: { ...emptyMetrics(), prompts: 3, turns: 10, ...(over.metrics ?? {}) },
  };
}
const many = (n: number, over: Parameters<typeof row>[0]) => Array.from({ length: n }, () => row(over));

test('modelView ranks a model in the field and inside each kind of work', () => {
  const rows = [
    ...many(12, { model: 'a', category: 'debug', rating: 5 }),
    ...many(12, { model: 'a', category: 'ux', rating: 2, survival_ratio: 0.3 }),
    ...many(12, { model: 'b', category: 'debug', rating: 3 }),
    ...many(12, { model: 'b', category: 'ux', rating: 5 }),
    ...many(2, { model: 'c', category: 'debug', rating: 5 }),      // too thin to rank anywhere
  ];
  const v = modelView(rows, 'a', 10, 8)!;
  assert.ok(v);
  assert.equal(v.n, 24);
  assert.equal(v.overall.of, 2, 'only a and b have ten sessions');
  assert.ok(v.overall.rank === 1 || v.overall.rank === 2);

  const debug = v.categories.find((c) => c.category === 'debug')!;
  const ux = v.categories.find((c) => c.category === 'ux')!;
  assert.equal(debug.rank, 1, 'a leads at debugging');
  assert.equal(debug.of, 2);
  assert.equal(ux.rank, 2, 'and trails at UI');
  assert.equal(ux.best?.model, 'b');
  assert.equal(v.categories[0]!.category, 'debug', 'best work first');

  const quality = v.overall.criteria.find((c) => c.criterion === 'quality')!;
  assert.equal(quality.of, 2);
  assert.equal(quality.lower_better, false);

  // c has sessions but no rank, and never a "best" it did not earn.
  const c = modelView(rows, 'c', 10, 8)!;
  assert.equal(c.overall.rank, null);
  assert.equal(c.overall.tier, '-');
  assert.equal(c.categories[0]!.eligible, false);
  assert.equal(c.categories[0]!.best?.model, 'a');

  assert.equal(modelView(rows, 'nobody', 10, 8), null);
});

test('the weekly series flags the week a model moved, not the weeks around it', () => {
  const weeks = ['2026-W30', '2026-W31', '2026-W32', '2026-W33', '2026-W34', '2026-W35'];
  const rows: Row[] = [];
  for (const [i, week] of weeks.entries()) {
    // Four good weeks, then two bad ones: ratings collapse, errors appear.
    // Both sides keep a little variance; a z-score needs a standard error.
    const bad = i >= 4;
    for (let k = 0; k < 8; k++) rows.push(row({ week, rating: bad ? 1 + (k % 2) : 4 + (k % 2), metrics: { errors: bad ? (k % 4 === 0 ? 0 : 2) : (k === 7 ? 1 : 0) } }));
  }
  const v = modelView(rows, 'a', 3, 8)!;
  assert.equal(v.weekly.length, 6);
  assert.equal(v.weekly[0]!.flag, 'none', 'the first week has no baseline');
  assert.equal(v.weekly[3]!.flag, 'none', 'a steady week does not flag');
  assert.equal(v.weekly[4]!.flag, 'alert', 'the week it fell is the week that flags');
  assert.ok(v.weekly[4]!.moved.some((m) => m.metric === 'rating' && m.direction === 'worse'));
  assert.ok(v.weekly[4]!.moved.some((m) => m.metric === 'clean' && m.direction === 'worse'));
  assert.equal(v.changes.length >= 1, true);
  assert.equal(v.changes[0]!.week, '2026-W34');

  // First weeks against latest weeks: worse, and it says which metrics.
  assert.equal(v.shift.verdict, 'worse');
  assert.deepEqual(v.shift.from, ['2026-W30'], 'eight sessions is already a period');
  assert.deepEqual(v.shift.to, ['2026-W35']);
  assert.ok(v.shift.moves.every((m) => m.direction === 'worse'));

  // The field line is every model that week, on the same formula.
  assert.equal(v.weekly[0]!.field_score, v.weekly[0]!.score, 'a is the whole field here');
});

test('periodShift refuses a verdict on thin history', () => {
  assert.equal(periodShift(many(30, { week: '2026-W38' })).verdict, 'insufficient', 'one week has no before and after');
  const two = [...many(3, { week: '2026-W37', rating: 5 }), ...many(3, { week: '2026-W38', rating: 1 })];
  assert.equal(periodShift(two).verdict, 'insufficient', 'five sessions a side, not three');
  const steady = [...many(6, { week: '2026-W37' }), ...many(6, { week: '2026-W38' })];
  assert.equal(periodShift(steady).verdict, 'steady');
  // A thin latest week borrows the week before it rather than failing.
  const tail = [...many(6, { week: '2026-W35' }), ...many(6, { week: '2026-W36' }), ...many(2, { week: '2026-W37' }), ...many(1, { week: '2026-W38' })];
  const s = periodShift(tail);
  assert.deepEqual(s.from, ['2026-W35']);
  assert.deepEqual(s.to, ['2026-W36', '2026-W37', '2026-W38']);
  assert.equal(s.verdict, 'steady');
});

test('workBoard puts the best model first inside each kind of work and never ranks a thin one', () => {
  const rows = [
    ...many(12, { model: 'a', category: 'debug', rating: 5 }),
    ...many(12, { model: 'b', category: 'debug', rating: 2, survival_ratio: 0.2 }),
    ...many(4, { model: 'c', category: 'ux', rating: 5 }),
  ];
  const cards = workBoard(rows, 10);
  assert.equal(cards[0]!.category, 'debug', 'most sessions first');
  assert.equal(cards[0]!.ranked[0]!.model, 'a');
  assert.equal(cards[0]!.ranked[0]!.tier !== '-', true);
  assert.equal(cards[0]!.n_ranked, 2);
  const ux = cards.find((c) => c.category === 'ux')!;
  assert.equal(ux.n_ranked, 0);
  assert.equal(ux.ranked[0]!.tier, '-', 'listed with its n, not ranked');
});

test('classifyTexts reads the whole conversation, first prompt counting double', () => {
  assert.equal(classifyTexts(['here is the repo', 'the build fails with a traceback, fix it']), 'debug');
  assert.equal(classifyTexts(['add a function', 'it fails']), 'code', 'the opening request counts double: 2x2 beats 3');
  assert.equal(classifyTexts(['it fails', 'add a function']), 'debug');
  assert.equal(classifyTexts([null, undefined, '']), 'other');
  assert.equal(classifyTexts([]), 'other');
});
