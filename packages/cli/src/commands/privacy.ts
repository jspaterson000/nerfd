import { existsSync, rmSync, statSync } from 'node:fs';
import { toReport, validateReport, type Tool } from '@nerfd/core';
import { countSessions, lastSession, listSessions } from '../db.ts';
import { flag, type Args } from '../args.ts';
import { countSampleFiles, LIMITS_DIR, SAMPLE_TTL_DAYS } from '../limits/store.ts';
import { CLIENT_VERSION, CONFIG_PATH, DB_PATH, HOME, LOG_PATH, loadConfig } from '../paths.ts';
import { effectivePlan, withDetections, WHY_NOT } from '../plandetect/index.ts';
import { table } from '../table.ts';

// `nerfd privacy` is the answer to "what is this thing actually doing".
// It reads the same config, calls the same toReport, and runs the same
// validator as the real send, so nothing here can drift from the truth
// without the send path drifting with it.

/** Fields in Session that stay on this machine. Kept next to the code that decides. */
const NEVER_SENT: Array<[string, string]> = [
  ['first_prompt', 'first 300 characters of your first prompt'],
  ['touched_files', 'absolute paths of the files a session edited'],
  ['cwd', 'the directory the session ran in'],
  ['git_branch', 'the branch name at session start'],
  ['git_head_start', 'the commit sha at session start'],
  ['outcome.note', 'the note you type with `nerfd rate`'],
  ['line_hashes', 'hashes of the lines a session added, for the survival check'],
  ['transcript_path', "the path to your tool's own transcript"],
  ['cwd_hash', 'a hash of the working directory'],
];

const ALSO_NEVER = [
  'prompt text, model output, source code, diffs, or line contents',
  'file names or paths, repo names, remotes, branches, or commit hashes',
  'your username, hostname, email, git identity, or environment variables',
  'your IP-derived location, or anything from a third-party analytics service',
];

function size(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}

function human(bytes: number | null): string {
  if (bytes == null) return 'not present';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function privacy(a: Args): void {
  if (a._[0] === 'purge') return purge(a);

  const cfg = loadConfig();
  const out: string[] = [];
  const p = (s = '') => out.push(s);

  // (a) sharing status and server.
  p('SHARING');
  if (cfg.share === 'auto') {
    p('  on. after every finished session, one record like the one below is sent.');
  } else if (cfg.share === 'ask') {
    p('  ask. nothing is sent unless you confirm it.');
  } else {
    p('  off. nothing leaves this machine. the CLI makes no network calls at all.');
  }
  p(`  endpoint   POST ${cfg.server}/v1/reports   (the only address the CLI ever contacts)`);
  p(`  turn off   nerfd share off`);

  // (b) what is stored locally, where, and how big.
  const counts = countSessions();
  p();
  p('STORED ON THIS MACHINE');
  p(`  ${HOME}`);
  p(indent(table(['file', 'size', 'holds'], [
    ['config.json', human(size(CONFIG_PATH)), 'install id, server, sharing setting, your plan'],
    ['local.db', human(size(DB_PATH)), `${plural(counts.total, 'session')}, ${counts.ended} finished, ${counts.rated} rated`],
    ['local.db-wal', human(size(DB_PATH + '-wal')), 'sqlite write-ahead log'],
    ['hook.log', human(size(LOG_PATH)), 'hook failures only'],
    ['limits/', plural(countSampleFiles(), 'file'), 'subscription window readings, one file per claude code session'],
  ])));

  // (b1) the status-line wrapper. It runs on every redraw of someone's status
  // line, so what it reads is worth stating in full rather than summarising.
  p();
  p('  the claude code status-line wrapper');
  p(`    ${LIMITS_DIR}/<session id>.jsonl`);
  p('    claude code hands its status line a JSON blob on stdin. the wrapper reads exactly two');
  p('    fields of it, session_id and rate_limits, and writes one line per scope per minute:');
  p('    {ts, scope, used_pct, resets_at}. cwd, model, cost, workspace, transcript_path and');
  p('    version are never read. it then runs your own status-line command with the same stdin');
  p('    and prints its output unchanged. source: packages/cli/src/limits/statusline.ts');
  p(`    the files are read at session end and deleted after ${SAMPLE_TTL_DAYS} days by \`nerfd check\`.`);
  p('    remove the wrapper and restore your own status line: nerfd init --remove');

  const sessions = listSessions({});
  const prompts = sessions.filter((s) => s.first_prompt).length;
  const paths = new Set(sessions.flatMap((s) => s.touched_files)).size;
  const dirs = new Set(sessions.map((s) => s.cwd).filter(Boolean)).size;
  const notes = sessions.filter((s) => s.outcome.note).length;
  const hashes = sessions.reduce((n, s) => n + (s.line_hashes?.length ?? 0), 0);
  p();
  p('  inside local.db, held locally and never sent:');
  p(indent(table(['field', 'what it is', 'held'], NEVER_SENT.map(([k, what]) => [
    k, what,
    k === 'first_prompt' ? plural(prompts, 'prompt')
      : k === 'touched_files' ? plural(paths, 'path')
      : k === 'cwd' ? plural(dirs, 'directory', 'directories')
      : k === 'outcome.note' ? plural(notes, 'note')
      : k === 'line_hashes' ? plural(hashes, 'hash', 'hashes')
      : plural(sessions.length, 'session'),
  ])), 4));
  p();
  p('  if your home directory is backed up or synced, treat local.db like your shell history.');

  // (b2) what detection opened, and what it found. The evidence string is the
  // whole answer to "what did you read": a detector names one field in one
  // file and nothing else is parsed out of it. See docs/PLAN-DETECTION.md.
  const det = withDetections(cfg).detected_plans;
  p();
  p('WHAT NERFD READ TO DETECT YOUR PLAN');
  const detRows = Object.entries(det?.plans ?? {})
    .map(([tool, d]) => [tool, d?.plan_id ?? '-', d?.confidence ?? '-', d?.evidence ?? WHY_NOT[tool as Tool] ?? '-']);
  if (detRows.length === 0) {
    p('  nothing read yet. `nerfd plan detect` runs it; `nerfd plan` shows what it found.');
  } else {
    p(indent(table(['tool', 'plan', 'confidence', 'file and field read'], detRows)));
    p(`  last run ${det?.checked_at ?? 'never'}, at most once a day. it never runs \`security\`, so the macOS keychain is never opened.`);
    p('  nothing else in those files is parsed, returned, logged or stored. re-run: nerfd plan detect. forget: nerfd plan forget');
  }
  const declaredTools = Object.keys(cfg.plans);
  if (declaredTools.length) p(`  declared by you, which always wins: ${declaredTools.map((t) => `${t}=${effectivePlan(cfg, t as Tool).plan_id}`).join(', ')}`);
  p('  of all of that, only the plan id and the word detected/declared/unknown are ever sent.');

  // (c) the exact record for the last session.
  const s = lastSession();
  p();
  p('WHAT WOULD BE SENT FOR YOUR LAST SESSION');
  if (!s) {
    p('  no sessions recorded yet. run `nerfd init`, use your tool, then come back.');
  } else {
    const r = toReport(s, cfg.install_id, CLIENT_VERSION, null);
    if (!r) {
      p(`  ${s.id.slice(0, 8)} has no model or has not finished, so nothing would be sent for it.`);
    } else {
      const err = validateReport(r);
      const empty = s.metrics.prompts === 0 && s.duration_s != null && s.duration_s < 60;
      p(indent(JSON.stringify(r, null, 2)));
      p();
      p('  that is the whole payload. on the wire it is the same JSON without the indentation,');
      p('  built by toReport() in packages/core/src/redact.ts, which you can read in a minute.');
      if (err) p(`  this one would be refused by the server: ${err}`);
      if (empty) p('  this one would be skipped: no prompts and under a minute long.');
      if (s.shared_at) p(`  already sent at ${s.shared_at}.`);
      else if (cfg.share === 'auto') p('  not sent yet.');
    }
  }

  // (d) the list of fields never sent.
  p();
  p('NEVER SENT, UNDER ANY SETTING, WITH NO FLAG TO TURN IT ON');
  for (const line of ALSO_NEVER) p(`  - ${line}`);
  for (const [k, what] of NEVER_SENT) p(`  - ${k}: ${what}`);

  // (e) how to stop, delete, and be forgotten.
  p();
  p('YOUR CONTROLS');
  p('  see it first        nerfd privacy | nerfd share --dry-run | nerfd export --public');
  p('  stop sending        nerfd share off');
  p('  remove the hooks    nerfd init --remove');
  p('  delete local data   nerfd privacy purge --yes       (local.db and hook.log)');
  p('  remove everything   rm -rf ' + HOME);
  p();
  p('  delete what was already shared:');
  p(`    your reporter id is in the record above. ask ${cfg.server} to delete every record`);
  p('    carrying it. a self-serve endpoint is not built yet; see "Open items" in docs/PRIVACY.md.');
  p();
  p(`  the full statement: docs/PRIVACY.md and ${cfg.server}/privacy`);

  process.stdout.write(out.join('\n') + '\n');
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

function indent(block: string, n = 2): string {
  const pad = ' '.repeat(n);
  return block.split('\n').map((l) => pad + l).join('\n');
}

/** `nerfd privacy purge --yes [--new-id]` */
function purge(a: Args): void {
  const targets = [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm', LOG_PATH].filter((f) => existsSync(f));
  if (!flag(a, 'yes')) {
    process.stderr.write(
      'this deletes your local session history and hook log. it cannot be undone.\n' +
      targets.map((f) => `  ${f}  (${human(size(f))})\n`).join('') +
      (targets.length ? '' : '  nothing to delete.\n') +
      'records already sent to the server are not affected; see `nerfd privacy`.\n' +
      'run again with --yes to do it.\n',
    );
    process.exitCode = 1;
    return;
  }
  for (const f of targets) {
    try { rmSync(f); process.stdout.write(`deleted ${f}\n`); }
    catch (e) { process.stderr.write(`could not delete ${f}: ${(e as Error).message}\n`); process.exitCode = 1; }
  }
  if (!targets.length) process.stdout.write('nothing to delete.\n');
  process.stdout.write(`kept ${CONFIG_PATH} (settings and install id). delete it too with: rm ${CONFIG_PATH}\n`);
}
