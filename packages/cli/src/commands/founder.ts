import { sha256 } from '@nerfd/core';
import { str, type Args } from '../args.ts';
import { loadConfig, saveConfig } from '../paths.ts';

/**
 * `nerfd founder @handle`     put your X handle on the founding reporters wall
 * `nerfd founder remove`      take it off
 * `nerfd founder`             show what is on the wall for this install
 *
 * The wall is a list of names by choice, and it is the one place a person can
 * put their name next to this project. It is joined to nothing: not to the
 * reporter id, not to a session. The owner token the server keeps is a hash
 * of the install id under a different salt from the reporter id, so the two
 * cannot be linked even by the server.
 */
export async function founder(a: Args): Promise<void> {
  const cfg = loadConfig();
  const owner = sha256('founder::' + cfg.install_id);
  const server = str(a, 'server') ?? cfg.server;
  const arg = a._[0];

  if (!arg) {
    process.stdout.write(cfg.founder_handle ? `on the wall as @${cfg.founder_handle} (${server})\n` : 'not on the founding wall. add your X handle with: nerfd founder @handle\n');
    return;
  }

  const remove = arg === 'remove' || arg === 'off';
  const handle = remove ? cfg.founder_handle : arg.replace(/^@/, '');
  if (!handle) { process.stderr.write('nothing to remove: this install has no handle on the wall.\n'); process.exitCode = 1; return; }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) { process.stderr.write('an X handle is 1 to 15 letters, digits or underscores.\n'); process.exitCode = 1; return; }

  if (!remove) {
    process.stdout.write([
      `this puts @${handle} on ${server}'s founding reporters list, publicly.`,
      'it is linked to nothing else: your records stay pseudonymous, and the server cannot',
      'connect the handle to them. remove it any time with: nerfd founder remove',
      '',
    ].join('\n'));
  }

  let res: Response;
  try {
    res = await fetch(`${server}/v1/founders`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, owner, remove }), signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    process.stderr.write(`could not reach ${server}: ${(e as Error).message}\n`); process.exitCode = 1; return;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; result?: string };
  if (!res.ok) { process.stderr.write(`${server} said ${res.status}: ${body.error ?? 'error'}\n`); process.exitCode = 1; return; }
  cfg.founder_handle = remove ? null : handle;
  saveConfig(cfg);
  process.stdout.write(remove ? `removed @${handle} from the wall.\n` : `@${handle} is on the wall (${body.result}). see it at ${server}/#founders\n`);
}
