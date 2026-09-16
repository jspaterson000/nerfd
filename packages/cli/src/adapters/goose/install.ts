import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nerfdPluginDir } from './paths.ts';

// Goose reads hooks from `<plugin-root>/hooks/hooks.json` of every plugin it
// discovers under `~/.agents/plugins/<name>/`, per the Open Plugins
// installation spec (crates/goose/src/hooks/mod.rs and
// crates/goose/src/plugins/discovery.rs). The file format is the same
// event -> rules -> actions shape Claude Code uses:
//
//   { "hooks": { "PostToolUse": [ { "matcher": "...", "hooks": [ ... ] } ] } }
//
// Three things about it are easy to get wrong and were verified in source:
//
//  1. `matcher` is an unanchored *regular expression*, not a glob. A bare "*"
//     does not compile, so Goose logs a warning and silently drops the whole
//     rule (hooks/mod.rs:998-1006). To run for every event, omit the key. We
//     omit it.
//  2. `command` is a single shell string run through `sh -c`, with no `args`
//     array (hooks/mod.rs:1126-1130). Both paths are therefore quoted.
//  3. `AfterFileEdit` and `AfterShellExecution` fire *in addition to*
//     `PostToolUse`, and only when it already fired
//     (state_machine/ops_toolcalling.rs:277-297). Subscribing to both would
//     count one edit as two tool calls, so we take `PostToolUse` alone and
//     translate the tool name in `normalise`.
//
// Everything is confined to our own plugin directory. No other plugin under
// `~/.agents/plugins` is read, written or even listed.

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.ts');
const TAG = 'nerfd';

/**
 * The events we subscribe to. `Stop` is here because it is the one event that
 * marks a finished model turn; it is observation-only for us, and the command
 * discards its own output so a Stop hook can never force a turn to continue.
 */
export const GOOSE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd',
];

interface HookAction { type: string; command: string; timeout?: number; [k: string]: unknown }
interface HookRule { matcher?: string; hooks: HookAction[] }
type HooksMap = Record<string, HookRule[]>;

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function hookCommand(): string {
  // stdout and stderr go nowhere on purpose. Goose parses a hook's stdout for
  // `{"decision":"block"}` on Stop and PreToolUse; a stray line from Node must
  // never be able to block someone's turn. nerfd's own log is ~/.nerfd/hook.log.
  return `${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} hook goose >/dev/null 2>&1`;
}

function ruleFor(event: string): HookRule {
  return {
    hooks: [{
      type: 'command',
      command: hookCommand(),
      // Seconds. Goose defaults to 30 (hooks/mod.rs:DEFAULT_HOOK_TIMEOUT_SECS).
      timeout: event === 'SessionEnd' ? 30 : 10,
      // Marker so uninstall removes exactly our rules. Goose ignores unknown keys.
      [TAG]: true,
    }],
  };
}

function isOurs(rule: HookRule): boolean {
  return Array.isArray(rule.hooks)
    && rule.hooks.some((h) => h?.[TAG] === true || (typeof h?.command === 'string' && h.command.includes(CLI_PATH)));
}

function readHooksFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    throw new Error(`could not parse ${path}; fix it or move it aside`);
  }
}

function merge(existing: HooksMap, remove: boolean): HooksMap {
  const out: HooksMap = {};
  // Anything a previous version of nerfd subscribed to that we no longer want
  // is dropped, and anything a person added to our plugin by hand is kept.
  for (const [event, rules] of Object.entries(existing)) {
    const keep = (Array.isArray(rules) ? rules : []).filter((r) => r && !isOurs(r));
    if (keep.length) out[event] = keep;
  }
  if (remove) return out;
  for (const event of GOOSE_EVENTS) out[event] = [...(out[event] ?? []), ruleFor(event)];
  return out;
}

const RECIPE = [
  '# Rate the current session for nerfd. Wire it up as /nerfd by adding this to',
  '# ~/.config/goose/config.yaml:',
  '#',
  '#   slash_commands:',
  '#     - command: "nerfd"',
  '#       recipe_path: "<this file>"',
  '#',
  '# nerfd does not edit config.yaml itself: it is your file, it has comments and',
  '# ordering that a two-hundred-line YAML reader would destroy, and it holds the',
  '# provider settings for every model you use.',
  'version: 1.0.0',
  'title: nerfd rating',
  'description: Record a 1-5 rating and whether you kept the work from this session.',
  'prompt: |',
  '  Run exactly this shell command and show its one-line output, then stop:',
  '',
  `  {{command}} rate last {{args}}`,
  '',
  '  Do not edit any files. Do not do anything else.',
  '',
].join('\n');

function recipeBody(): string {
  return RECIPE
    .replace('{{command}}', `${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)}`)
    .replace('{{args}}', '{{rating}}');
}

const MANIFEST = {
  name: 'nerfd',
  version: '0.1.0',
  description: 'Records how a coding session went — counts only, never prompts, code or paths.',
};

/**
 * Write (or with `remove`, take back out) the nerfd plugin. Returns the paths
 * touched, newest first, the same contract the other adapters' installers use.
 */
export function installGoose(remove = false): string[] {
  const root = nerfdPluginDir();
  const hooksPath = join(root, 'hooks', 'hooks.json');
  const manifestPath = join(root, 'plugin.json');
  const recipePath = join(root, 'recipes', 'nerfd.yaml');

  if (remove) {
    const file = readHooksFile(hooksPath);
    const hooks = merge((file.hooks as HooksMap) ?? {}, true);
    if (Object.keys(hooks).length === 0) {
      // Nothing of anyone else's in there. Take the whole plugin back out so
      // Goose stops discovering it, rather than leaving an empty shell.
      try { rmSync(root, { recursive: true, force: true }); } catch { /* not ours to force */ }
      return [root];
    }
    writeFileSync(hooksPath, JSON.stringify({ ...file, hooks }, null, 2) + '\n');
    return [hooksPath];
  }

  mkdirSync(join(root, 'hooks'), { recursive: true });
  mkdirSync(join(root, 'recipes'), { recursive: true });

  // A manifest is not required for hook discovery — Goose lists the directory
  // children of ~/.agents/plugins and reads hooks/hooks.json from each
  // (plugins/discovery.rs). It is written anyway because other tools reading
  // the same shared ~/.agents/plugins directory expect one, and an unreadable
  // plugin in a shared directory is a bug we would be handing to someone else.
  writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2) + '\n');
  writeFileSync(recipePath, recipeBody());

  const file = readHooksFile(hooksPath);
  writeFileSync(hooksPath, JSON.stringify({ ...file, hooks: merge((file.hooks as HooksMap) ?? {}, false) }, null, 2) + '\n');
  return [hooksPath, manifestPath, recipePath];
}

/** Is our plugin wired into Goose right now? */
export function gooseHooksInstalled(): boolean {
  try {
    const hooks = readHooksFile(join(nerfdPluginDir(), 'hooks', 'hooks.json')).hooks as HooksMap | undefined;
    return !!hooks && Object.values(hooks).some((rules) => (rules ?? []).some(isOurs));
  } catch {
    return false;
  }
}
