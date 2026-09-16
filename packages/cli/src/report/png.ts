import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A 1200x630 PNG from an SVG, for posting. Zero dependencies means no
// rasteriser of our own, so this borrows a Chrome that is already on the
// machine and runs it headless on a local file. Nothing is fetched. When no
// browser is found the caller keeps the SVG and says so.

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser(): string | null {
  if (process.env.NERFD_BROWSER && existsSync(process.env.NERFD_BROWSER)) return process.env.NERFD_BROWSER;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Render an SVG string to a PNG at `out`. Returns false when no browser is available. */
export function svgToPng(svg: string, out: string, width = 1200, height = 630): boolean {
  const browser = findBrowser();
  if (!browser) return false;
  const dir = mkdtempSync(join(tmpdir(), 'nerfd-card-'));
  try {
    const page = join(dir, 'card.html');
    writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fbfbfc}svg{display:block}</style></head><body>${svg}</body></html>`);
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--window-size=${width},${height}`, '--force-device-scale-factor=1', `--screenshot=${out}`, pathToFileURL(page).href,
    ], { stdio: 'ignore', timeout: 30000 });
    return existsSync(out);
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
