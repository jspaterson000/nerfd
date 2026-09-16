#!/usr/bin/env node
import './quiet.ts';
import { parseArgs, num, str } from './args.ts';
import { log } from './paths.ts';

const HELP = `nerfd - nerfd.ai. a local-first scorecard of how AI models perform on your real work.

  nerfd init [--claude] [--codex] [--share] [--server URL] [--remove]   install hooks into every tool found
  nerfd sessions [-n 20]                        recent sessions
  nerfd show <id|last> [--public] [--refresh]   one session; --public shows exactly what would be shared
  nerfd rate [id|last] [1-5] [kept|partial|reverted] [category] [s|m|l] [note...]
  nerfd record --tool <name> --model <id> ...   report a session from any other tool or script
  nerfd stats [--by model,category] [--weeks 8] [--cat X] [--lang X]
  nerfd which <category> [--lang X] [--size s|m|l]   which model to use right now, from your own data
  nerfd cost [--weeks 8]                        api-equivalent cost, cost per success, waste, subscription value
  nerfd plan [detect|<tool> <plan-id|$amount>]   subscription plan; auto-detected, declare to override
  nerfd drift [--weeks 8]                       week-over-week change per model
  nerfd check [--force]                         re-measure how much of each session's code survived
  nerfd share on|off|status                     autonomous reporting of redacted records after each session
  nerfd share [last|<id>|all] [--dry-run] [--resend] [--evidence URL]   send specific records (--resend re-sends ones already shared)
  nerfd export [--public] [--csv]               dump your data
  nerfd report [--weeks 4] [--out file] [--projects] [--share]   your own usage, errors, ranking and economics as one page
                                                (--share writes the card to post and prints the text)
  nerfd post weekly [--weeks 8]                 compose the weekly drift report from the public board: text and card
  nerfd founder [@handle|remove]                put your X handle on the founding reporters wall, by choice
  nerfd dash [--port 8787]                      local dashboard over your own sessions
  nerfd backfill [tool] [--since 90d] [--refresh] [--restamp]  import sessions the tool recorded before nerfd existed
                                                (--refresh re-reads the ledger for sessions already on record)
  nerfd model-info <raw_id> [--family --version --size --quant --provider --modified]
  nerfd privacy [purge --yes]                what is stored, what is sent, how to stop
  nerfd doctor                                  paths, counts, hook status
  nerfd hook <tool>                             (internal) hook entry point, reads JSON on stdin
`;

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._.shift() ?? 'help';

  if (cmd === 'hook') {
    // Never let a hook failure surface to the host tool. Only the error's
    // name is logged: V8 puts the offending input into JSON parse messages.
    try {
      const raw = await readStdin();
      if (!raw.trim()) return;
      const { handleHook } = await import('./hooks/handler.ts');
      await handleHook(a._[0] ?? 'claude-code', JSON.parse(raw));
    } catch (e) {
      log(`hook error: ${(e as Error).name}`);
    }
    return;
  }

  switch (cmd) {
    case 'init': return (await import('./commands/init.ts')).init(a);
    case 'sessions': case 'ls': return (await import('./commands/sessions.ts')).sessions(a);
    case 'show': return (await import('./commands/sessions.ts')).show(a);
    case 'rate': return (await import('./commands/rate.ts')).rate(a);
    case 'record': return (await import('./commands/record.ts')).record(a);
    case 'cost': return (await import('./commands/cost.ts')).cost(a);
    case 'plan': return (await import('./commands/plan.ts')).plan(a);
    case 'stats': return (await import('./commands/stats.ts')).stats(a);
    case 'which': return (await import('./commands/stats.ts')).which(a);
    case 'drift': return (await import('./commands/stats.ts')).driftCmd(a);
    case 'check': return (await import('./commands/check.ts')).check(a);
    case 'share': return (await import('./commands/share.ts')).share(a);
    case 'export': return (await import('./commands/export.ts')).exportCmd(a);
    case 'report': return (await import('./commands/report.ts')).report(a);
    case 'post': return (await import('./commands/post.ts')).post(a);
    case 'founder': return (await import('./commands/founder.ts')).founder(a);
    case 'backfill': return (await import('./commands/backfill.ts')).backfill(a);
    case 'model-info': case 'model': return (await import('./commands/model.ts')).modelInfo(a);
    case 'privacy': return (await import('./commands/privacy.ts')).privacy(a);
    case 'doctor': return (await import('./commands/doctor.ts')).doctor();
    case 'statusline': return (await import('./limits/statusline.ts')).statusline();
    case 'dash': {
      const { startServer } = await import('@nerfd/server');
      const { localRows } = await import('./rows.ts');
      const port = num(a, 'port', 8787);
      startServer({ port, readOnly: true, title: 'nerfd / local', rows: () => localRows({ weeks: num(a, 'weeks', 26), includeAutomated: true }) });
      process.stdout.write(`local dashboard: http://localhost:${port}  (ctrl-c to stop)\n`);
      return;
    }
    case 'help': case '--help': case '-h':
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
      process.exitCode = 1;
      void str;
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 1;
});
