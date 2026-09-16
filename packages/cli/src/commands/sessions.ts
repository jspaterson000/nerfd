import { hoursOf, signalRates, toReport, type Session } from '@nerfd/core';
import { listSessions, putSession, resolveSession } from '../db.ts';
import { finalise } from '../hooks/handler.ts';
import { flag, num, str, type Args } from '../args.ts';
import { CLIENT_VERSION, loadConfig } from '../paths.ts';
import { fmtDuration, fmtPct, table } from '../table.ts';

/**
 * How much the human had to steer: corrections, restatements and "no, stop".
 * A count here rather than a rate, because the row next to it is a count too.
 */
function steerCount(s: Session): number | string {
  const g = s.signals;
  return g ? g.corrections + g.reprompts + g.pushback : '-';
}

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function sessions(a: Args): void {
  const n = num(a, 'n', 20);
  const rows = listSessions({ limit: n });
  if (rows.length === 0) { process.stdout.write('no sessions yet. run `nerfd init`, then use Claude Code or Codex.\n'); return; }
  process.stdout.write(
    table(
      ['id', 'tool', 'model', 'cat', 'sz', 'dur', 'prompts', 'edits', 'err', 'rl', 'int', 'steer', 'rating', 'kept', 'surv', 'when'],
      rows.map((s) => [
        // Active time, not the wall-clock span: a session resumed the next
        // morning is not a twelve hour session.
        s.id.slice(0, 8), s.tool, s.model ?? '?', s.category, s.size, fmtDuration(Math.round(hoursOf(s) * 3600)),
        s.metrics.prompts, s.metrics.edits, s.metrics.errors, s.metrics.rate_limit_hits, s.metrics.interrupts,
        steerCount(s),
        s.outcome.rating ?? '-', s.outcome.kept === 'unknown' ? '-' : s.outcome.kept, fmtPct(s.survival.ratio),
        s.ended_at ? ago(s.ended_at) : 'open',
      ]),
    ) + '\n',
  );
  const unrated = rows.filter((s) => s.ended_at && s.outcome.rating == null && s.metrics.prompts > 0).length;
  if (unrated) process.stdout.write(`\n${unrated} unrated. \`nerfd rate last 4 kept\` takes two seconds.\n`);
}

export function show(a: Args): void {
  const s = resolveSession(str(a, 'session') ?? a._[0]);
  if (!s) { process.stderr.write('no such session\n'); process.exitCode = 1; return; }
  if (flag(a, 'refresh') && s.ended_at) { finalise(s); putSession(s); }
  if (flag(a, 'public')) {
    // The real install id, so the preview is byte-identical to what is sent.
    process.stdout.write(JSON.stringify(toReport(s, loadConfig().install_id, CLIENT_VERSION), null, 2) + '\n');
    return;
  }
  const { line_hashes, ...rest } = s;
  process.stdout.write(JSON.stringify({
    ...rest,
    // Derived, not stored: the counts are what the record holds, the rates
    // are what they mean. Both are numbers; there is no text in either.
    signal_rates: s.signals ? signalRates(s.signals) : null,
    line_hashes: line_hashes ? `[${line_hashes.length} hashes]` : null,
  }, null, 2) + '\n');
}
