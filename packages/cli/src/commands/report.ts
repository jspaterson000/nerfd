import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, num, str, type Args } from '../args.ts';
import { HOME, ensureHome } from '../paths.ts';
import { buildReportData } from '../report/data.ts';
import { renderFallback } from '../report/fallback.ts';
import { openPath } from '../report/open.ts';
import type { ReportData } from '../report/types.ts';

/**
 * `nerfd report [--weeks 4] [--out path] [--no-open] [--projects] [--json]`
 *
 * One self-contained HTML file built from the local database and opened with
 * the OS opener. No server, no port, no network: the file is the product, and
 * it can be saved, printed or sent. `--json` prints the same data the page is
 * rendered from, which is what the privacy test reads.
 */
export async function report(a: Args): Promise<void> {
  const weeks = Math.max(1, num(a, 'weeks', 4));
  const projects = flag(a, 'projects');
  const data = buildReportData({ weeks, projects });

  if (flag(a, 'json')) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  const html = await render(data);
  const out = outPath(str(a, 'out'));
  ensureHome();
  // 0o600: this is the one artefact that holds a whole month of your work in
  // one place, and on a shared box the default umask is not good enough.
  writeFileSync(out, html, { mode: 0o600 });

  process.stdout.write(`${out}\n`);
  process.stdout.write(`${data.glance.sentence}\n`);
  if (!flag(a, 'no-open')) openPath(out);
}

function outPath(given: string | undefined): string {
  if (!given) return join(HOME, 'report.html');
  return isAbsolute(given) ? given : resolve(process.cwd(), given);
}

type Renderer = (data: ReportData, opts: { logos: Record<string, string> }) => string;

/**
 * The designed page when it is there, the plain one when it is not. The
 * specifier is built at runtime on purpose: `html.ts` is an optional module,
 * and a static import of a file that may not exist would stop the whole CLI
 * from compiling rather than degrade to a page that still says everything.
 */
async function render(data: ReportData): Promise<string> {
  try {
    const url = new URL('../report/html.ts', import.meta.url).href;
    const mod = (await import(url)) as { renderReport?: Renderer };
    if (typeof mod?.renderReport === 'function') {
      const html = mod.renderReport(data, { logos: loadLogos() });
      if (typeof html === 'string' && html.length > 0) return html;
    }
  } catch {
    // A renderer that is missing, half-written or throwing is not a reason to
    // produce no report at all.
  }
  return renderFallback(data);
}

/**
 * Provider marks, inlined as SVG source so the page needs nothing from the
 * network. Keyed by file stem: 'anthropic', 'groq', 'ollama'. A missing
 * assets directory is normal in a packaged install, and means no logos.
 */
export function loadLogos(dir = fileURLToPath(new URL('../../../server/assets/logos/', import.meta.url))): Record<string, string> {
  const out: Record<string, string> = {};
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const svg = readFileSync(join(dir, name), 'utf8');
      // Nothing in this set is big; anything that is has gone wrong.
      if (svg.length <= 64 * 1024) out[name.slice(0, -4)] = svg;
    } catch { /* one unreadable mark is not a failed report */ }
  }
  return out;
}
