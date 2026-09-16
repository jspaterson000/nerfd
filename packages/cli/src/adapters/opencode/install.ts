import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { opencodeConfigDir } from './config.ts';

// OpenCode has no shell hooks. What it has is a plugin loader that imports
// every JS module in its plugins directory, so the install writes one small
// loader of our own and never touches anyone else's file.
//
// The loader is deliberately three lines: the plugin that does the work ships
// inside nerfd and is imported by absolute path, so an upgrade to nerfd
// upgrades the plugin without rewriting anything in the user's config.

const MARKER = 'nerfd-managed';
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.ts');
const PLUGIN_PATH = fileURLToPath(new URL('../../../plugins/opencode/nerfd.js', import.meta.url));

/** 1.18 documents `plugins/`; older builds used `plugin/`. We write the documented one and clean the other. */
export const PLUGIN_DIR_NAME = 'plugins';
export const LEGACY_PLUGIN_DIR_NAME = 'plugin';

export function loaderPath(): string {
  return join(opencodeConfigDir(), PLUGIN_DIR_NAME, 'nerfd.js');
}

export function commandPath(): string {
  return join(opencodeConfigDir(), 'commands', 'nerfd.md');
}

export function shippedPluginPath(): string {
  return PLUGIN_PATH;
}

function loaderSource(): string {
  return [
    `// ${MARKER}: written by \`nerfd init\`, removed by \`nerfd init --remove\`.`,
    '// Edits here are overwritten. The plugin itself lives inside nerfd.',
    `import { createNerfdPlugin } from ${JSON.stringify(pathToFileURL(PLUGIN_PATH).href)};`,
    '',
    `export const NerfdPlugin = createNerfdPlugin(${JSON.stringify({ node: process.execPath, cli: CLI_PATH })});`,
    '',
  ].join('\n');
}

function commandSource(): string {
  return [
    '---',
    'description: Rate this session for nerfd (e.g. /nerfd 4 kept "solid refactor")',
    '---',
    '',
    `<!-- ${MARKER} -->`,
    '',
    `Run exactly this shell command and show its one-line output, then stop: ${process.execPath} ${CLI_PATH} rate last $ARGUMENTS`,
    'Do not edit any files. Do not do anything else.',
    '',
  ].join('\n');
}

function isOurs(path: string): boolean {
  try { return existsSync(path) && readFileSync(path, 'utf8').includes(MARKER); } catch { return false; }
}

/** Only ever removes a file we wrote: another plugin in the same directory is not ours to delete. */
function removeIfOurs(path: string): void {
  try { if (isOurs(path)) rmSync(path, { force: true }); } catch { /* nothing to do */ }
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o644 });
}

export function installOpencode(remove = false): string[] {
  const loader = loaderPath();
  const legacy = join(opencodeConfigDir(), LEGACY_PLUGIN_DIR_NAME, 'nerfd.js');
  const cmd = commandPath();

  // A loader left in the singular directory by an older nerfd would double
  // every event, so it goes whether we are installing or uninstalling.
  removeIfOurs(legacy);

  if (remove) {
    removeIfOurs(loader);
    removeIfOurs(cmd);
    return [loader, cmd];
  }
  write(loader, loaderSource());
  write(cmd, commandSource());
  return [loader, cmd];
}

export function opencodeInstalled(): boolean {
  return isOurs(loaderPath());
}
