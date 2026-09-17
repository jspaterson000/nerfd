import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStatusline } from '../limits/statusline.ts';
import { loadConfig, saveConfig } from '../paths.ts';
import { detectPlan } from '../plandetect/index.ts';

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

// ---------------------------------------------------------------------------
// The status-line wrapper
//
// Claude Code's transcripts carry no window state; the status JSON is the only
// place it appears, so nerfd wraps whatever status line the person already
// has. Wrapping, not replacing: the original command is saved to config.json,
// run on every redraw with the same stdin, and its output is passed through
// untouched. `nerfd init --remove` puts it back exactly as it was.
//
// Where there is no status line at all, one is installed only for a plan that
// actually has windows to report - Pro or Max - and the person is told, on one
// line, that it happened.
// ---------------------------------------------------------------------------

const STATUSLINE_COMMAND = `${process.execPath} ${CLI_PATH} statusline`;

/** Set when the wrapper was installed where there was no status line before. */
export let lastStatuslineNote: string | null = null;

function isOurStatusLine(s: unknown): boolean {
  return !!s && typeof s === 'object'
    && typeof (s as { command?: unknown }).command === 'string'
    && (s as { command: string }).command.includes(CLI_PATH)
    && /\bstatusline\b/.test((s as { command: string }).command);
}

function claudePlanHasWindows(): boolean {
  try {
    // Only Pro and Max report `rate_limits` in the status JSON; an API-billed
    // or unknown install would sample nothing but still pay for the wrapper.
    const id = detectPlan('claude-code').plan_id ?? '';
    return /^claude-(pro|max)\b/.test(id);
  } catch {
    return false;
  }
}

/**
 * Install or remove the status-line wrapper in ~/.claude/settings.json.
 * Returns the file written, or null when nothing needed doing.
 */
export function installClaudeStatusline(remove = false): string | null {
  lastStatuslineNote = null;
  const path = join(homedir(), '.claude', 'settings.json');
  const settings = readJson(path);
  const current = settings.statusLine as Record<string, unknown> | undefined;
  const cfg = withStatusline(loadConfig());

  if (remove) {
    if (!isOurStatusLine(current)) return null;
    const original = cfg.statusline_original;
    // Exactly as it was, or gone if there was nothing there before.
    if (original && typeof original.command === 'string') settings.statusLine = original;
    else delete settings.statusLine;
    cfg.statusline_original = null;
    saveConfig(cfg);
    writeJsonWithBackup(path, settings);
    return path;
  }

  if (isOurStatusLine(current)) return null;          // already wrapped

  if (current && typeof current.command === 'string' && current.command.trim()) {
    cfg.statusline_original = {
      type: typeof current.type === 'string' ? current.type : 'command',
      command: current.command,
      ...(typeof current.padding === 'number' ? { padding: current.padding } : {}),
    };
    saveConfig(cfg);
    settings.statusLine = { ...current, type: 'command', command: STATUSLINE_COMMAND };
    writeJsonWithBackup(path, settings);
    return path;
  }

  if (!claudePlanHasWindows()) return null;
  cfg.statusline_original = null;
  saveConfig(cfg);
  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND };
  writeJsonWithBackup(path, settings);
  lastStatuslineNote = 'claude-code  status line installed (none was set): a Pro/Max plan reports its limit windows there, and nerfd reads only session_id and rate_limits. remove: nerfd init --remove';
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

export type CodexHookStatus = 'on' | 'untrusted' | 'off';

/** What `nerfd init` and `nerfd doctor` say when Codex has our hooks but will not run them. */
export const CODEX_UNTRUSTED_NOTE = [
  'codex runs a hook only after you trust it: open `codex` in a terminal, type /hooks, and trust the nerfd entries.',
  'until then nothing is captured live. the Codex app and the ChatGPT app write the same session logs, and',
  '`nerfd backfill --since 90d` reads those, so their sessions are counted either way.',
];

/**
 * Codex refuses to run a user-level hook until the person has reviewed it
 * in /hooks. It records that consent in config.toml as
 * `[hooks.state."<hooks.json path>:<event>:<group>:<index>"] trusted_hash`,
 * keyed by the snake_case event name and our position in the file. This
 * reads those keys back so the two commands can say "installed but off"
 * instead of "on". One regex over the lines; the file is TOML but the keys
 * are one line each.
 */
export function codexHookStatus(): CodexHookStatus {
  const hooksPath = join(homedir(), '.codex', 'hooks.json');
  const x = readJson(hooksPath).hooks as HooksMap | undefined;
  if (!x) return 'off';
  const ours: string[] = [];
  for (const [ev, groups] of Object.entries(x)) {
    groups.forEach((g, gi) => {
      if (!isOurs(g)) return;
      const snake = ev.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      g.hooks.forEach((_, hi) => ours.push(`${hooksPath}:${snake}:${gi}:${hi}`));
    });
  }
  if (ours.length === 0) return 'off';
  let toml = '';
  try { toml = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8'); } catch { return 'untrusted'; }
  const trusted = new Set<string>();
  for (const line of toml.split('\n')) {
    const m = /^\s*\[hooks\.state\."(.+)"\]\s*$/.exec(line);
    if (m) trusted.add(m[1]!);
  }
  return ours.every((k) => trusted.has(k)) ? 'on' : 'untrusted';
}

export function hookStatus(): { claude: boolean; codex: CodexHookStatus } {
  const c = readJson(join(homedir(), '.claude', 'settings.json')).hooks as HooksMap | undefined;
  const has = (h?: HooksMap) => !!h && Object.values(h).some((entries) => entries.some(isOurs));
  return { claude: has(c), codex: codexHookStatus() };
}
