import { aggregate, costUsd, hostedEquivalentUsd, hoursOf, isSuccess, planSummaries, reporterWeeks, priceFor } from '@nerfd/core';
import { num, str, type Args } from '../args.ts';
import { loadConfig } from '../paths.ts';
import { localRows } from '../rows.ts';
import { fmtNum, fmtPct, table } from '../table.ts';

const mult = (x: number) => (x < 1 ? x.toFixed(2) : x.toFixed(1)) + "x";
const money = (v: number | null | undefined) => (v == null ? '-' : v < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`);

/**
 * `nerfd cost [--weeks 8]`
 * Two views. API-equivalent: what the tokens would cost at list price, per
 * session and per successful session, and how much went on failures.
 * Subscription: what your plan actually bought you, by week.
 */
export function cost(a: Args): void {
  const weeks = num(a, 'weeks', 8);
  // Economics keeps the automated sessions: a robot's tokens are on the bill.
  const rows = localRows({ weeks, category: str(a, 'cat'), includeAutomated: true });
  if (rows.length === 0) { process.stdout.write('no data yet.\n'); return; }

  const groups = aggregate(rows, ['model']);
  process.stdout.write(`api-equivalent cost, last ${weeks} weeks (list prices; unpriced models show -)\n\n`);
  process.stdout.write(
    table(
      ['model', 'n', 'priced', 'success', '$/session', '$/success', 'waste', '$/hr'],
      groups.map((g) => {
        const hrs = rows.filter((r) => r.model === g.key.model).reduce((s, r) => s + hoursOf(r), 0);
        const total = rows.filter((r) => r.model === g.key.model).map((r) => costUsd(r.model, r.metrics)).filter((x): x is number => x != null).reduce((s, x) => s + x, 0);
        return [g.key.model, g.n, g.n_priced, fmtPct(g.success_rate), money(g.cost_mean), money(g.cost_per_success), fmtPct(g.waste_share), hrs > 0 && g.n_priced > 0 ? money(total / hrs) : '-'];
      }),
    ) + '\n',
  );
  process.stdout.write('\n$/success = total spend / sessions that succeeded (rated 4+, kept, or 60%+ of the code survived). waste = spend on sessions rated 2 or less, reverted, or under 20% survival.\n');

  const cfg = loadConfig();
  // Weeks, not months: the public reporter id rotates weekly, so a monthly
  // bucket would not be one person's month.
  const months = reporterWeeks(rows).sort((x, y) => y.week.localeCompare(x.week));
  process.stdout.write('\nsubscription value, by week (plan price pro-rated)\n\n');
  if (months.length === 0) {
    process.stdout.write('no plan set. `nerfd plan claude claude-max-20x` (or a dollar amount) and this fills in.\n');
  } else {
    process.stdout.write(
      table(
        ['week', 'tool', 'plan', 'price', 'sessions', 'successes', 'hours', 'api-equiv', 'multiple', '$/success', 'limit hits', 'peak window'],
        months.map((m) => [
          m.week, m.tool, cfg.plans[m.tool]?.name ?? m.plan_id, m.plan_usd_month == null ? 'usage' : `$${m.plan_usd_month}`,
          m.sessions, m.successes, fmtNum(m.hours, 1), money(m.api_equiv_usd),
          m.plan_usd_week && m.api_equiv_usd != null ? mult(m.api_equiv_usd / m.plan_usd_week) : "-",
          m.plan_usd_week && m.successes > 0 ? money(m.plan_usd_week / m.successes) : '-',
          m.limit_hits, m.limit_peak_pct == null ? '-' : `${Math.round(m.limit_peak_pct)}%`,
        ]),
      ) + '\n',
    );
    const cur = months[0]!;
    if (cur.plan_usd_week && cur.api_equiv_usd != null) {
      process.stdout.write(`\nthis week so far: $${cur.plan_usd_week.toFixed(0)} of plan bought ${cur.successes} successful sessions and ~$${cur.api_equiv_usd.toFixed(0)} of api-equivalent usage (${mult(cur.api_equiv_usd / cur.plan_usd_week)}).\n`);
    }
  }

  // Locally served weights are not "unpriced": they cost nothing per token,
  // and the honest comparison is what the same tokens would have cost hosted.
  const localEquiv = rows
    .map((r) => hostedEquivalentUsd(r.model_ref ?? null, r.metrics))
    .filter((x): x is number => x != null)
    .reduce((a, b) => a + b, 0);
  if (localEquiv > 0) process.stdout.write(`\nlocal models: ${money(localEquiv)} of hosted-equivalent tokens ran on your own hardware. never counted as spend.\n`);

  const unpriced = [...new Set(rows.filter((r) => r.model_ref?.serving_mode !== 'local').map((r) => r.model))].filter((m) => !priceFor(m));
  if (unpriced.length) process.stdout.write(`\nno list price in the ${rows[0]?.model_ref ? 'models.dev snapshot' : 'price table'} for: ${unpriced.slice(0, 8).join(', ')}.\n`);
  void planSummaries; void isSuccess;
}
