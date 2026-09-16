// Statistics helpers. Everything public shows n and an interval, never a bare mean.

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Wilson score interval for a proportion. z = 1.96 -> 95%. */
export function wilson(successes: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
}

/** Standard error of a mean. */
export function sem(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

/**
 * Drift: is this window's mean different from the baseline's, beyond noise?
 * Returns a z-like score. |z| > 2 is worth flagging, |z| > 3 is a headline.
 */
export function driftZ(current: number[], baseline: number[]): number | null {
  const mc = mean(current), mb = mean(baseline);
  const sc = sem(current), sb = sem(baseline);
  if (mc == null || mb == null || sc == null || sb == null) return null;
  const se = Math.sqrt(sc * sc + sb * sb);
  if (se === 0) return null;
  return (mc - mb) / se;
}

/** ISO week label like 2026-W38. */
export function isoWeek(dateIso: string): string {
  const d = new Date(dateIso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
