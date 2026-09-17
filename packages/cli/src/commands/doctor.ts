import { existsSync, readFileSync } from 'node:fs';
import { countSessions } from '../db.ts';
import { CODEX_UNTRUSTED_NOTE, hookStatus } from '../hooks/install.ts';
import { CLIENT_VERSION, CONFIG_PATH, DB_PATH, HOME, LOG_PATH, loadConfig } from '../paths.ts';

export function doctor(): void {
  const cfg = loadConfig();
  const st = hookStatus();
  const c = countSessions();
  const lines = [
    `nerfd ${CLIENT_VERSION}  node ${process.version}  ${process.platform}`,
    `home       ${HOME}`,
    `config     ${CONFIG_PATH}`,
    `db         ${DB_PATH}  (${c.total} sessions, ${c.ended} finished, ${c.rated} rated)`,
    `server     ${cfg.server}`,
    `share      ${cfg.share}`,
    `hooks      claude=${st.claude ? 'on' : 'off'}  codex=${st.codex}`,
  ];
  if (st.codex === 'untrusted') lines.push(...CODEX_UNTRUSTED_NOTE.map((l) => '           ' + l));
  if (existsSync(LOG_PATH)) {
    const tail = readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-5);
    if (tail.length && tail[0]) lines.push('', `last hook log lines (${LOG_PATH}):`, ...tail.map((l) => '  ' + l));
  }
  process.stdout.write(lines.join('\n') + '\n');
}
