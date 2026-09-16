import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMetrics, planSummaries, type Row } from '@nerfd/core';
import { queryData } from '../src/queries.ts';

// The two things the first real data on the live board got wrong: what the
// headline number counts, and what a session with no human in it is evidence
// of. Both are decided here, in the one query layer Node and Cloudflare share.

function row(over: Partial<Row> = {}): Row {
  return {
    reporter: 'rw1', tool: 'codex', model: 'gpt-5.3-codex', effort: null,
    plan_id: 'chatgpt-pro', plan_usd_month: 200,
    week: '2026-W38', ended_at: new Date(Date.now() - 86400_000).toISOString(),
    category: 'code', size: 'm', repo: { lang: 'ts', size: 'm', age: 'established' },
    duration_s: 600, rating: 4, kept: 'kept', survival_ratio: 0.9,
    metrics: { ...emptyMetrics(), prompts: 3, turns: 10, tokens_in: 100_000, tokens_out: 10_000 },
    ...over,
  };
}

const ask = (path: string, rows: Row[]) =>
  queryData(new URL('http://x' + path), () => rows, false, 'http://x', {
    count: () => rows.length,
    reporterWeeks: () => new Set(rows.map((r) => r.reporter)).size,
  })!.body as Record<string, any>;

test('/v1/meta counts reporter-weeks, not people, and says so in the field name', () => {
  const rows = [row({ reporter: 'a' }), row({ reporter: 'b' }), row({ reporter: 'b' })];
  const m = ask('/v1/meta', rows);

  // reporter_id = hash(install_id + ISO week), so two ids can be one person in
  // two weeks. The field is named for what it actually counts.
  assert.equal(m.reporter_weeks, 2);
  // The old name is kept for one release so a cached page does not go blank.
  assert.equal(m.reporters, m.reporter_weeks);
  assert.equal(m.automated_n, 0);
});

test('/v1/meta reports how many sessions nobody prompted', () => {
  const m = ask('/v1/meta', [row(), row({ automated: true }), row({ automated: true })]);
  assert.equal(m.automated_n, 2);
});

test('an automated session is out of the tier board but still on the bill', () => {
  // Three steered sessions and one auto-review, same model, same plan, same week.
  const rows = [row(), row(), row(), row({ automated: true, rating: 1, survival_ratio: 0 })];

  const tiers = ask('/v1/tiers?min=3', rows);
  assert.equal(tiers.n, 3, 'the ranked population excludes the automated session');
  assert.equal(tiers.tiers[0].n, 3);

  // ...and its rating does not drag the model down.
  const steeredOnly = ask('/v1/stats', rows);
  assert.equal(steeredOnly.n, 3);
  assert.equal(steeredOnly.groups[0].rating_mean, 4);

  // But the tokens were spent, so economics and the plans board keep it.
  const plans = ask('/v1/plans', rows);
  const p = plans.plans.find((x: any) => x.plan_id === 'chatgpt-pro')!;
  assert.equal(p.sessions_median, 4, 'the plan paid for all four');
  assert.deepEqual(planSummaries(rows).find((x) => x.plan_id === 'chatgpt-pro')!.sessions_median, 4);

  // The friction and drift boards are quality boards too.
  assert.equal((ask('/v1/friction', rows)).n, 3);
  assert.equal((ask('/v1/drift', rows)).n, 3);

  // And anyone who wants to look can ask for them back.
  assert.equal(ask('/v1/tiers?min=3&automated=1', rows).n, 4);
});

test('/v1/model ranks one model against the field and 404s an unknown one', () => {
  const rows = [
    ...Array.from({ length: 4 }, () => row({ model: 'gpt-5.3-codex', category: 'debug', rating: 5 })),
    ...Array.from({ length: 4 }, () => row({ model: 'claude-opus-5', category: 'debug', rating: 3 })),
    row({ model: 'gpt-5.3-codex', automated: true, rating: 1 }),
  ];
  const q = queryData(new URL('http://x/v1/model?id=gpt-5.3-codex&min=3'), () => rows, false, 'http://x')!;
  assert.equal(q.status, 200);
  const v = q.body as Record<string, any>;
  assert.equal(v.n, 4, 'the automated session is not evidence about the model');
  assert.equal(v.overall.rank, 1);
  assert.equal(v.overall.of, 2);
  assert.equal(v.categories[0].category, 'debug');
  assert.equal(v.categories[0].rank, 1);

  const missing = queryData(new URL('http://x/v1/model?id=nobody'), () => rows, false, 'http://x')!;
  assert.equal(missing.status, 404);
  assert.equal(queryData(new URL('http://x/v1/model'), () => rows, false, 'http://x')!.status, 400);
});

test('/v1/work returns one card per kind of work, best first, and /v1/tiers echoes its category', () => {
  const rows = [
    ...Array.from({ length: 3 }, () => row({ model: 'gpt-5.3-codex', category: 'debug', rating: 5 })),
    ...Array.from({ length: 3 }, () => row({ model: 'claude-opus-5', category: 'debug', rating: 2, survival_ratio: 0.1 })),
    row({ model: 'claude-opus-5', category: 'ux' }),
  ];
  const w = ask('/v1/work?min=3', rows);
  assert.equal(w.work.length, 2);
  assert.equal(w.work[0].category, 'debug');
  assert.equal(w.work[0].ranked[0].model, 'gpt-5.3-codex');
  assert.equal(w.work[1].n_ranked, 0);
  assert.equal(ask('/v1/tiers?category=debug&min=3', rows).category, 'debug');
  assert.equal(ask('/v1/tiers?min=3', rows).category, null);
});
