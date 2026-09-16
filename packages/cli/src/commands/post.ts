import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoWeek } from '@nerfd/core';
import { flag, num, str, type Args } from '../args.ts';
import { HOME, ensureHome, loadConfig } from '../paths.ts';
import { composeWeekly, type WeeklyInputs } from '../post/weekly.ts';
import { svgToPng } from '../report/png.ts';

/**
 * `nerfd post weekly [--weeks 8] [--server URL] [--out dir] [--json]`
 *
 * Composes the weekly drift report from the public endpoints: the post text
 * to stdout, and a 1200x630 card next to it as SVG, plus PNG when a browser
 * is on the machine. It reads the board; it never posts anything itself.
 */
export async function post(a: Args): Promise<void> {
  const kind = a._[0] ?? 'weekly';
  if (kind !== 'weekly') { process.stderr.write(`unknown post kind "${kind}". only: weekly\n`); process.exitCode = 1; return; }
  const origin = (str(a, 'server') ?? loadConfig().server).replace(/\/$/, '');
  const weeks = Math.max(2, num(a, 'weeks', 8));
  const get = async (path: string) => {
    const res = await fetch(origin + path, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  };
  let inputs: WeeklyInputs;
  try {
    const [meta, thisWeek, drift, work, limits] = await Promise.all([
      get('/v1/meta'), get('/v1/stats?by=week&weeks=1'), get(`/v1/drift?weeks=${weeks}`), get('/v1/work?weeks=4'), get('/v1/limits?weeks=8'),
    ]) as [WeeklyInputs['meta'], WeeklyInputs['thisWeek'], WeeklyInputs['drift'], WeeklyInputs['work'], WeeklyInputs['limits']];
    inputs = { week: isoWeek(new Date().toISOString()), origin, meta, thisWeek, drift, work, limits };
  } catch (e) {
    process.stderr.write(`could not read ${origin}: ${(e as Error).message}\n`); process.exitCode = 1; return;
  }
  const out = composeWeekly(inputs);
  if (flag(a, 'json')) { process.stdout.write(JSON.stringify({ week: inputs.week, lines: out.lines }, null, 2) + '\n'); return; }

  ensureHome();
  const dir = str(a, 'out') ?? join(HOME, 'posts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = join(dir, inputs.week);
  writeFileSync(base + '.txt', out.text + '\n', { mode: 0o600 });
  writeFileSync(base + '.svg', out.card, { mode: 0o600 });
  const png = svgToPng(out.card, base + '.png');
  process.stdout.write(out.text + '\n\n');
  process.stdout.write(`text: ${base}.txt\ncard: ${png ? base + '.png' : base + '.svg (no browser found for PNG; set NERFD_BROWSER)'}\n`);
}
