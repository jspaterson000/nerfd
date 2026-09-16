import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWeekly, type WeeklyInputs } from '../src/post/weekly.ts';

// The weekly post is the marketing plan, so its rules are tested: numbers
// with n, the flagged model named with its move, "nerfed" never in our
// voice, and a thin week that says so instead of inventing a verdict.

function inputs(over: Partial<WeeklyInputs> = {}): WeeklyInputs {
  return {
    week: '2026-W38', origin: 'https://nerfd.org',
    meta: { reports: 1204, reporter_weeks: 41, models: ['a', 'b', 'c'] },
    thisWeek: { n: 210 },
    drift: { models: [
      { model: 'gpt-6-astra', drift: { flag: 'watch', current: { week: '2026-W38', n: 38, score: 71 }, rating_z: null, friction_z: -1.1, steering_z: 2.4, latency_z: 0.3 }, weekly: [{ week: '2026-W37', n: 40, score: 83 }, { week: '2026-W38', n: 38, score: 71 }] },
      { model: 'claude-opus-5', drift: { flag: 'none', current: { week: '2026-W38', n: 52, score: 80 }, rating_z: 0.2, friction_z: 0.1, steering_z: -0.4, latency_z: 0 }, weekly: [] },
      { model: 'thin', drift: { flag: 'none', current: { week: '2026-W38', n: 2, score: null }, rating_z: null, friction_z: null, steering_z: null, latency_z: null }, weekly: [] },
    ] },
    work: { min_n: 10, work: [
      { category: 'debug', n: 120, ranked: [{ model: 'gpt-6-astra', tier: 'S', score: 83, n: 40 }] },
      { category: 'ux', n: 90, ranked: [{ model: 'gpt-5.6-sol', tier: 'S', score: 86, n: 79 }] },
      { category: 'refactor', n: 4, ranked: [{ model: 'x', tier: '-', score: null, n: 2 }] },
    ] },
    limits: { plans: [{ plan_id: 'chatgpt-pro', name: 'ChatGPT Pro', usd_month: 200, tokens_per_dollar: { p50: 3_200_000 }, wall_hit_share: 0.12, n: 300 }] },
    ...over,
  };
}

test('the weekly post names the week, the move, the leaders and the plan, with n everywhere', () => {
  const p = composeWeekly(inputs());
  assert.match(p.lines[0]!, /^Week W38\. 210 sessions this week, 1204 on record, 3 models, 41 reporter-weeks\./);
  assert.match(p.lines[1]!, /gpt-6-astra watch: score 71 from 83 \(n=38, steering up, z \+2\.4\)/);
  assert.match(p.lines[1]!, /Flat: 1 other with 5\+ sessions/);
  assert.match(p.lines[2]!, /debugging gpt-6-astra \(S 83, n=40\); UI gpt-5\.6-sol \(S 86, n=79\)/);
  assert.match(p.lines[3]!, /ChatGPT Pro, 3\.2M per \$ \(median, n=300\); wall hit in 12%/);
  assert.match(p.lines.at(-1)!, /Change detection, not a verdict.*nerfd\.org\/board/);
  assert.doesNotMatch(p.text, /nerf(ed|\b)/i);
  assert.doesNotMatch(p.text, /!/);
  assert.ok(p.card.startsWith('<svg') && p.card.includes('Week W38'));
});

test('a quiet week says nobody moved, and a thin week says it cannot tell', () => {
  const quiet = composeWeekly(inputs({ drift: { models: [{ model: 'a', drift: { flag: 'none', current: { week: '2026-W38', n: 9, score: 70 }, rating_z: 0, friction_z: 0, steering_z: 0, latency_z: 0 }, weekly: [] }] } }));
  assert.match(quiet.lines[1]!, /No model moved against its own last four weeks \(1 with 5\+ sessions this week\)/);
  const thin = composeWeekly(inputs({ drift: { models: [] }, work: { min_n: 10, work: [] }, limits: { plans: [] } }));
  assert.match(thin.lines[1]!, /Too few sessions this week/);
  assert.equal(thin.lines.length, 3, 'no leaders line and no plan line when there is nothing to say');
});
