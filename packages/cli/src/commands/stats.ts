import { aggregate, drift, steeringRate, weekly, CATEGORIES, type GroupKey, type Group } from '@nerfd/core';
import { num, str, type Args } from '../args.ts';
import { localRows } from '../rows.ts';
import { bar, fmtDuration, fmtMs, fmtNum, fmtPct, table } from '../table.ts';

function groupRows(groups: Group[], by: GroupKey[]) {
  return groups.map((g) => [
    ...by.map((b) => g.key[b]),
    g.n,
    g.score ?? '-',
    g.rating_mean != null ? fmtNum(g.rating_mean, 2) : '-',
    g.good ? `${fmtPct(g.good.p)} [${fmtPct(g.good.lo)}-${fmtPct(g.good.hi)}]` : '-',
    g.survival_mean != null ? fmtPct(g.survival_mean) : '-',
    fmtPct(g.friction_free),
    fmtPct(steeringRate(g)),
    fmtPct(g.frustration_rate),
    fmtMs(g.latency_p50_ms),
    fmtPct(g.rate_limit_rate),
    fmtPct(g.interrupt_rate),
    fmtDuration(g.duration_median_s),
  ]);
}

const HEAD = ['n', 'score', 'rating', 'good [95%]', 'surv', 'clean', 'steer', 'frus', 'p50', 'ratelim', 'interr', 'dur'];

export function stats(a: Args): void {
  const by = (str(a, 'by') ?? 'model').split(',').map((s) => s.trim()) as GroupKey[];
  const weeks = num(a, 'weeks', 8);
  const rows = localRows({ weeks, category: str(a, 'cat'), lang: str(a, 'lang'), tool: str(a, 'tool'), model: str(a, 'model') });
  if (rows.length === 0) { process.stdout.write(`no finished sessions in the last ${weeks} weeks.\n`); return; }
  const groups = aggregate(rows, by);
  process.stdout.write(`${rows.length} sessions, last ${weeks} weeks, by ${by.join(' x ')}\n\n`);
  process.stdout.write(table([...by, ...HEAD], groupRows(groups, by)) + '\n');
  process.stdout.write('\nscore = 0.55*rating + 0.30*survival + 0.15*clean (missing parts dropped; n<3 unscored). clean = no errors, rate limits, interrupts or model switches.\n');
  process.stdout.write('steer = corrections + restatements + "no, stop" per prompt; frus = frustration markers per prompt. lower is better, and both are blank until a session has signals.\n');
}

export function which(a: Args): void {
  const cat = a._[0];
  if (!cat || !(CATEGORIES as readonly string[]).includes(cat)) {
    process.stderr.write(`usage: nerfd which <${CATEGORIES.join('|')}> [--lang ts] [--size s|m|l] [--weeks 8]\n`);
    process.exitCode = 1;
    return;
  }
  const weeks = num(a, 'weeks', 8);
  const lang = str(a, 'lang');
  const size = str(a, 'size');
  let rows = localRows({ weeks, category: cat, lang, size });
  let scope = `${cat}${lang ? ' / ' + lang : ''}${size ? ' / ' + size : ''}`;
  // Fall back to broader scopes rather than say nothing.
  if (rows.length < 3 && (lang || size)) { rows = localRows({ weeks, category: cat }); scope = `${cat} (too little data for the narrower filter)`; }
  if (rows.length < 3) { rows = localRows({ weeks }); scope = `all categories (only ${rows.length} ${cat} sessions on record)`; }
  if (rows.length === 0) { process.stdout.write('no data yet.\n'); return; }

  const groups = aggregate(rows, ['model']);
  process.stdout.write(`which model for ${scope}, last ${weeks} weeks, your sessions only\n\n`);
  process.stdout.write(
    table(
      ['rank', 'model', 'n', 'score', '', 'rating', 'surv', 'clean', 'p50', 'ratelim'],
      groups.map((g, i) => [
        i + 1, g.key.model, g.n, g.score ?? '-', bar((g.score ?? 0) / 100, 12),
        g.rating_mean != null ? fmtNum(g.rating_mean, 2) : '-', g.survival_mean != null ? fmtPct(g.survival_mean) : '-',
        fmtPct(g.friction_free), fmtMs(g.latency_p50_ms), fmtPct(g.rate_limit_rate),
      ]),
    ) + '\n',
  );
  const top = groups[0]!;
  if (top.score == null) process.stdout.write(`\nnot enough sessions to rank yet (need 3+ per model). keep working; rate a few with \`nerfd rate\`.\n`);
  else if (groups.length === 1) process.stdout.write(`\nonly one model in this scope. try another for a few sessions so there is something to compare.\n`);
  else process.stdout.write(`\n-> ${top.key.model}  (n=${top.n}, score ${top.score}). public data will blend in here once you opt in with \`nerfd share\`.\n`);
}

export function driftCmd(a: Args): void {
  const weeks = num(a, 'weeks', 8);
  const rows = localRows({ weeks, category: str(a, 'cat') });
  const models = [...new Set(rows.map((r) => r.model))];
  if (models.length === 0) { process.stdout.write('no data yet.\n'); return; }
  for (const m of models) {
    const series = weekly(rows.filter((r) => r.model === m));
    const d = drift(rows, m);
    process.stdout.write(`${m}${d ? `  [${d.flag}]` : ''}\n`);
    process.stdout.write(
      table(
        ['week', 'n', 'score', 'rating', 'surv', 'clean', 'p50'],
        series.map((w) => [w.week, w.n, w.score ?? '-', w.rating_mean != null ? fmtNum(w.rating_mean, 2) : '-', w.survival_mean != null ? fmtPct(w.survival_mean) : '-', fmtPct(w.friction_free), fmtMs(w.latency_p50_ms)]),
      ) + '\n',
    );
    if (d) process.stdout.write(`  vs prior ${d.baseline_weeks.length}w: rating z=${fmtNum(d.rating_z, 1)}  clean z=${fmtNum(d.friction_z, 1)}  steer z=${fmtNum(d.steering_z, 1)}  latency z=${fmtNum(d.latency_z, 1)}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write('flags: watch = |z|>=2, alert = |z|>=3 with n>=5 this week. this is change detection, not a verdict.\n');
}
