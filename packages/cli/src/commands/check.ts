import { listSessions, putSession } from '../db.ts';
import { survivingCount } from '../git.ts';
import { flag, type Args } from '../args.ts';
import { loadConfig } from '../paths.ts';
import { fmtPct, table } from '../table.ts';

/**
 * `nerfd check` — re-measure how much of each session's added code still exists.
 * Runs on sessions that ended at least an hour ago and have not been checked
 * in the last day. Cheap enough to run from a cron or a shell prompt hook.
 */
export function check(a: Args): void {
  const now = Date.now();
  const force = flag(a, 'force');
  const salt = loadConfig().install_id;
  expireLineHashes(now);
  const candidates = listSessions({ endedOnly: true, limit: 200 }).filter((s) => {
    if (!s.cwd || !s.line_hashes || s.line_hashes.length === 0) return false;
    const endedAgo = now - Date.parse(s.ended_at!);
    if (endedAgo < 60 * 60 * 1000) return false;                 // let the dust settle
    if (endedAgo > 30 * 86400 * 1000) return false;              // stop re-checking old stuff
    if (force || !s.survival.checked_at) return true;
    return now - Date.parse(s.survival.checked_at) > 86400 * 1000;
  });
  if (candidates.length === 0) { process.stdout.write('nothing to check.\n'); return; }

  const out: Array<[string, string, number, string]> = [];
  for (const s of candidates) {
    const surviving = survivingCount(s.cwd!, s.line_hashes!, salt);
    if (surviving == null) continue;
    s.survival.lines_surviving = surviving;
    s.survival.ratio = s.survival.lines_added ? surviving / s.survival.lines_added : null;
    s.survival.checked_at = new Date().toISOString();
    putSession(s);
    out.push([s.id.slice(0, 8), s.model ?? '?', s.survival.lines_added, fmtPct(s.survival.ratio)]);
  }
  process.stdout.write(table(['id', 'model', 'added', 'surviving'], out) + '\n');
}

/**
 * Line hashes exist to answer one question: is this code still there an hour
 * later. After the 30-day window nothing ever reads them again, so they are
 * dropped rather than kept forever in $HOME.
 */
function expireLineHashes(now: number): void {
  for (const s of listSessions({ endedOnly: true, limit: 2000 })) {
    if (!s.line_hashes || s.line_hashes.length === 0) continue;
    if (now - Date.parse(s.ended_at!) <= 30 * 86400 * 1000) continue;
    s.line_hashes = null;
    putSession(s);
  }
}
