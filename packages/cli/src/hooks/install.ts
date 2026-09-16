import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs our hooks into the host tools' config, merging with whatever is
// already there. We add one entry per event, tagged so we can find and
// remove exactly our own entries later.

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
const TAG = 'nerfd';

export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PostModelSwitch', 'Stop', 'StopFailure', 'SessionEnd'];
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];

type HookEntry = { matcher?: string; hooks: Array<Record<string, unknown>> };
type HooksMap = Record<string, HookEntry[]>;

function entryFor(tool: 'claude' | 'codex', event: string): HookEntry {
  const hook: Record<string, unknown> = {
    type: 'command',
    command: process.execPath,
    args: [CLI_PATH, 'hook', tool],
    timeout: event === 'SessionEnd' ? 30 : 10,
    // Marker so uninstall can find us. Unknown keys are ignored by both tools.
    [TAG]: true,
  };
  if (tool === 'claude' && event !== 'SessionEnd') hook.async = true;
  return { hooks: [hook] };
}

function isOurs(e: HookEntry): boolean {
  return e.hooks.some((h) => h[TAG] === true || (Array.isArray(h.args) && h.args.includes(CLI_PATH)));
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`could not parse ${path}; fix it or move it aside`); }
}

function writeJsonWithBackup(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${TAG}-${Date.now()}`);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function merge(hooks: HooksMap, tool: 'claude' | 'codex', events: string[], remove: boolean): HooksMap {
  const out: HooksMap = { ...hooks };
  for (const ev of events) {
    const existing = (out[ev] ?? []).filter((e) => !isOurs(e));
    out[ev] = remove ? existing : [...existing, entryFor(tool, ev)];
    if (out[ev]!.length === 0) delete out[ev];
  }
  return out;
}

export function installClaude(remove = false): string {
  const path = join(homedir(), '.claude', 'settings.json');
  const settings = readJson(path);
  settings.hooks = merge((settings.hooks as HooksMap) ?? {}, 'claude', CLAUDE_EVENTS, remove);
  writeJsonWithBackup(path, settings);
  installClaudeCommand(remove);
  return path;
}

export function installCodex(remove = false): string {
  const path = join(homedir(), '.codex', 'hooks.json');
  const file = readJson(path);
  file.hooks = merge((file.hooks as HooksMap) ?? {}, 'codex', CODEX_EVENTS, remove);
  writeJsonWithBackup(path, file);
  installCodexPrompt(remove);
  return path;
}

/** /nerfd inside Codex: a custom prompt that asks the agent to run the rating command. */
function installCodexPrompt(remove: boolean): void {
  const dir = join(homedir(), '.codex', 'prompts');
  const path = join(dir, 'nerfd.md');
  if (remove) { try { if (existsSync(path)) writeFileSync(path, ''); } catch { /* ignore */ } return; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    '---',
    'description: Rate this session for nerfd, e.g. /nerfd 4 kept "solid refactor"',
    '---',
    '',
    `Run exactly this shell command and show its one-line output, then stop: ${process.execPath} ${CLI_PATH} rate last $ARGUMENTS`,
    'Do not edit any files. Do not do anything else.',
    '',
  ].join('\n'));
}

/** /nerfd inside Claude Code: `/nerfd 4 kept great refactor` */
function installClaudeCommand(remove: boolean): void {
  const dir = join(homedir(), '.claude', 'commands');
  const path = join(dir, 'nerfd.md');
  if (remove) { try { if (existsSync(path)) writeFileSync(path, ''); } catch { /* ignore */ } return; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    '---',
    'description: Rate this session for nerfd (e.g. /nerfd 4 kept "solid refactor")',
    'disable-model-invocation: true',
    '---',
    '',
    'Session rating recorded:',
    '',
    '!`' + `${process.execPath} ${CLI_PATH} rate --session $CLAUDE_SESSION_ID $ARGUMENTS` + '`',
    '',
    'Reply with one short line acknowledging the rating. Do not do anything else.',
    '',
  ].join('\n'));
}

export function hookStatus(): { claude: boolean; codex: boolean } {
  const c = readJson(join(homedir(), '.claude', 'settings.json')).hooks as HooksMap | undefined;
  const x = readJson(join(homedir(), '.codex', 'hooks.json')).hooks as HooksMap | undefined;
  const has = (h?: HooksMap) => !!h && Object.values(h).some((entries) => entries.some(isOurs));
  return { claude: has(c), codex: has(x) };
}
