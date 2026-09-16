import { toReport } from '@nerfd/core';
import { listSessions } from '../db.ts';
import { flag, type Args } from '../args.ts';
import { CLIENT_VERSION, loadConfig } from '../paths.ts';

/** `nerfd export [--public] [--csv]` — your data, your file. */
export function exportCmd(a: Args): void {
  const cfg = loadConfig();
  const sessions = listSessions({ endedOnly: true });
  if (flag(a, 'public')) {
    const reports = sessions.map((s) => toReport(s, cfg.install_id, CLIENT_VERSION)).filter((r) => r != null);
    if (flag(a, 'csv')) { process.stdout.write(toCsv(reports.map((r) => flatten(r as unknown as Record<string, unknown>)))); return; }
    process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
    return;
  }
  if (flag(a, 'csv')) { process.stdout.write(toCsv(sessions.map((s) => flatten({ ...s, line_hashes: undefined, touched_files: undefined } as unknown as Record<string, unknown>))) ); return; }
  process.stdout.write(JSON.stringify(sessions.map((s) => ({ ...s, line_hashes: undefined })), null, 2) + '\n');
}

function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = Array.isArray(v) ? v.join('|') : v;
  }
  return out;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}
