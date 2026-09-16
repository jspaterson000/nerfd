import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Where Goose keeps things. Verified against crates/goose/src/config/paths.rs:
// `GOOSE_PATH_ROOT` (absolute only) overrides everything and puts config under
// `<root>/config`, data under `<root>/data` and plugins under
// `<root>/.agents/plugins`. Otherwise etcetera's app strategy picks the
// platform location, which is why more than one candidate is probed: the docs
// say `~/.config/goose` and `~/.local/share/goose` on macOS and Linux
// (documentation/docs/guides/logs.md) while older macOS installs still carry
// `~/Library/Application Support/Block/goose`
// (documentation/docs/guides/environment-variables.md:517).

const SESSIONS_FOLDER = 'sessions';   // crates/goose/src/session/session_manager.rs:28
const DB_NAME = 'sessions.db';        // crates/goose/src/session/session_manager.rs:29

function pathRoot(): string | null {
  const v = process.env.GOOSE_PATH_ROOT;
  return v && isAbsolute(v) ? v : null;
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Every place a `config.yaml` could be, most specific first. */
export function gooseConfigCandidates(): string[] {
  const root = pathRoot();
  if (root) return [join(root, 'config', 'config.yaml')];
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  const out = [];
  if (xdg && isAbsolute(xdg)) out.push(join(xdg, 'goose', 'config.yaml'));
  out.push(join(home, '.config', 'goose', 'config.yaml'));
  out.push(join(home, 'Library', 'Application Support', 'Block', 'goose', 'config.yaml'));
  return out;
}

export function gooseConfigPath(): string | null {
  return firstExisting(gooseConfigCandidates());
}

/** Every place `sessions/sessions.db` could be, most specific first. */
export function gooseDbCandidates(): string[] {
  const root = pathRoot();
  const tail = join(SESSIONS_FOLDER, DB_NAME);
  if (root) return [join(root, 'data', tail)];
  const home = homedir();
  const xdg = process.env.XDG_DATA_HOME;
  const out = [];
  if (xdg && isAbsolute(xdg)) out.push(join(xdg, 'goose', tail));
  out.push(join(home, '.local', 'share', 'goose', tail));
  out.push(join(home, 'Library', 'Application Support', 'Block', 'goose', tail));
  return out;
}

export function gooseDbPath(): string | null {
  return process.env.NERFD_GOOSE_DB ?? firstExisting(gooseDbCandidates());
}

/**
 * `<home>/.agents/plugins` — the Open Plugins storage path Goose reads
 * (crates/goose/src/config/paths.rs, DirType::Plugins) and the cross-tool
 * convention Kimi and Crush are converging on. Ours is one directory inside
 * it; nothing else in there is ever touched.
 */
export function goosePluginsDir(): string {
  const root = pathRoot();
  const base = root ?? (process.env.NERFD_AGENTS_HOME ?? homedir());
  return join(base, '.agents', 'plugins');
}

export function nerfdPluginDir(): string {
  return join(goosePluginsDir(), 'nerfd');
}
