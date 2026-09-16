import { toReport, validateReport } from '@nerfd/core';
import { listSessions, resolveSession } from '../db.ts';
import { flag, str, type Args } from '../args.ts';
import { CLIENT_VERSION, loadConfig, saveConfig } from '../paths.ts';
import { publishSession } from '../publish.ts';

// Read this as the person reading it: they did not ask for a legal document,
// they asked what is about to leave their laptop. Say it once, say all of it,
// and point at the command that proves it.

export const CONSENT = [
  'sharing is ON. when a session ends, one small JSON record is sent to the board:',
  '  model, effort level, tool and version, plan tier, ISO week and the time it ended,',
  '  task category and size, repo language and size and age buckets, duration,',
  '  counts (prompts, turns, tool calls, edits, files, tests, errors, rate limits,',
  '  timeouts, interrupts, model switches), token totals, latency percentiles,',
  '  your rating and kept flag if you gave one, and the share of added lines that survived.',
  'never sent: prompt text, model output, code, file paths, repo or branch names,',
  '  your notes, or anything naming you, your machine or your employer.',
  'the reporter id is a hash of a random number generated at install. it is not an account,',
  'and it is not derived from anything about you. that one POST is the only network call the',
  'CLI ever makes; with sharing off it makes none.',
  '',
  'see the exact record and everything held locally:  nerfd privacy',
  'stop at any time:                                  nerfd share off',
].join('\n');

const OFF = [
  'sharing is OFF. nothing leaves this machine, and the CLI makes no network calls.',
  'the local scorecard keeps working: nerfd sessions, which, cost, drift, dash.',
  '',
  'see what is stored here:  nerfd privacy',
  'contribute to the board:  nerfd share on        (or send one session: nerfd share last)',
].join('\n');

/**
 * `nerfd share on|off|status`
 * `nerfd share [last|<id>|all] [--evidence https://gist.github.com/...] [--dry-run] [--server URL]`
 */
export async function share(a: Args): Promise<void> {
  const cfg = loadConfig();
  const ref = a._[0] ?? 'last';

  if (ref === 'on' || ref === 'off' || ref === 'status') {
    const changed = ref !== 'status' && cfg.share !== (ref === 'on' ? 'auto' : 'never');
    if (ref !== 'status') { cfg.share = ref === 'on' ? 'auto' : 'never'; saveConfig(cfg); }
    process.stdout.write((cfg.share === 'auto' ? CONSENT : OFF) + '\n');
    if (cfg.share === 'auto') process.stdout.write(`server: ${cfg.server}\n`);
    if (changed && cfg.share === 'auto') process.stdout.write('\n`nerfd privacy` shows the exact record, and everything held locally, before the next one goes.\n');
    return;
  }

  const server = str(a, 'server');
  if (server) cfg.server = server;
  const evidence = str(a, 'evidence') ?? null;
  const dry = flag(a, 'dry-run');

  const targets = ref === 'all'
    ? listSessions({ endedOnly: true }).filter((s) => !s.shared_at)
    : [resolveSession(ref)].filter((s): s is NonNullable<typeof s> => s != null);
  if (targets.length === 0) { process.stderr.write('nothing to share.\n'); process.exitCode = 1; return; }

  if (dry) {
    const reports = targets.map((s) => toReport(s, cfg.install_id, CLIENT_VERSION, targets.length === 1 ? evidence : null)).filter((r) => r != null);
    for (const r of reports) { const err = validateReport(r); if (err) process.stderr.write(`${r.report_id.slice(0, 8)}: invalid (${err})\n`); }
    process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
    process.stdout.write(`\n(dry run: ${reports.length} record(s) would be POSTed to ${cfg.server}/v1/reports. nothing was sent.)\n`);
    return;
  }

  if (evidence) process.stdout.write(`the evidence link is public and permanent, and ties this record to that github account: ${evidence}\n`);

  let ok = 0;
  for (const s of targets) {
    const r = await publishSession(s, cfg, targets.length === 1 ? evidence : null);
    if (r.ok) ok++; else process.stderr.write(`${s.id.slice(0, 8)}: ${r.reason}\n`);
  }
  process.stdout.write(`shared ${ok}/${targets.length} to ${cfg.server}\n`);
}
