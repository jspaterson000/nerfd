// Plain-text tables. No colour, no box drawing, no spinners. Output should
// look right in a log file, a pipe, and a screenshot.

export type Cell = string | number | null | undefined;

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(v)) return '-';
  return v.toFixed(digits);
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null) return '-';
  return `${Math.round(v * 100)}%`;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return '-';
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '-';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function table(headers: string[], rows: Cell[][], opts: { align?: Array<'l' | 'r'> } = {}): string {
  const str = (c: Cell) => (c == null ? '-' : String(c));
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => str(r[i]).length)));
  const align = opts.align ?? headers.map((_, i) => (rows.every((r) => r[i] == null || /^[-\d.%smh]+$/.test(str(r[i]))) ? 'r' : 'l'));
  const pad = (s: string, i: number) => (align[i] === 'r' ? s.padStart(widths[i]!) : s.padEnd(widths[i]!));
  const line = (cells: Cell[]) => cells.map((c, i) => pad(str(c), i)).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** Tiny inline bar for quick visual comparison, e.g. "####----" */
export function bar(ratio: number | null | undefined, width = 10): string {
  if (ratio == null) return ' '.repeat(width);
  const n = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return '#'.repeat(n) + '.'.repeat(width - n);
}
