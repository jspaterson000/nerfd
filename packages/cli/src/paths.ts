import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool } from '@nerfd/core';

export const CLIENT_VERSION = '0.1.0';

export const HOME = process.env.NERFD_HOME ?? join(homedir(), '.nerfd');
export const DB_PATH = join(HOME, 'local.db');
export const CONFIG_PATH = join(HOME, 'config.json');
export const LOG_PATH = join(HOME, 'hook.log');

export interface Config {
  install_id: string;        // random, never derived from identity
  server: string;            // public ingest URL
  share: "never" | "ask" | "auto";
  plans: Partial<Record<Tool, { id: string; name: string; usd_month: number | null }>>;
  created_at: string;
}

export function ensureHome(): void {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  ensureHome();
  if (existsSync(CONFIG_PATH)) {
    try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config; } catch { /* fallthrough */ }
  }
  const cfg: Config = {
    install_id: randomUUID(),
    server: process.env.NERFD_SERVER ?? 'http://localhost:8787',
    share: "never",
    plans: {},
    created_at: new Date().toISOString(),
  };
  saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

const LOG_MAX_BYTES = 256 * 1024;

export function log(msg: string): void {
  try {
    ensureHome();
    // Capped and truncated rather than rotated: nothing here is worth keeping
    // once it is a quarter of a megabyte old, and an unbounded log of error
    // text in $HOME is a liability of its own.
    try { if (statSync(LOG_PATH).size > LOG_MAX_BYTES) writeFileSync(LOG_PATH, '', { mode: 0o600 }); } catch { /* no log yet */ }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch { /* logging must never throw */ }
}
