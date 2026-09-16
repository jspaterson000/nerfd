import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@nerfd/core';
import { backfillSession } from './backfill.ts';
import {
  atLeast, binaryVersion, findFamilyChat, hasOurHooks, HOOK_TAG, listFamilyChats, mergeHooks,
  onPath, parseGeminiFamilyChat, readJsonFile, shellCommand, writeJsonWithBackup,
  type AdapterTurn, type FamilyLedger, type HookEntry, type HooksMap,
} from './gemini-family.ts';
import { attachSignals, emptyLedger, isCanonicalEvent, type Adapter, type HookInput, type NormalisedEvent } from './types.ts';

/**
 * Qwen Code: a Gemini CLI fork that took Claude Code's hook vocabulary, so it
 * reads like Claude on the live side and like Gemini on the ledger side.
 *
 * Its transcripts are opened read-only and never written to, ever: Qwen Code
 * fences them with a writer lease, and a second writer breaks a live session.
 * The API key is not read either — only the *name* of the environment variable
 * that holds it, which is what the settings file stores.
 */

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');

/** `QWEN_HOME` moves the whole config; `QWEN_RUNTIME_DIR` moves only the state. */
export function qwenDir(): string {
  return process.env.QWEN_HOME || join(homedir(), '.qwen');
}

export function qwenRuntimeDir(): string {
  return process.env.QWEN_RUNTIME_DIR || qwenDir();
}

export const qwenSettingsPath = (): string => join(qwenDir(), 'settings.json');
export const qwenCommandPath = (): string => join(qwenDir(), 'commands', 'nerfd.md');

/** `<runtime>/projects/<sanitised cwd>/chats/<sessionId>.jsonl`, plus the older `tmp/` layout. */
export const qwenChatRoots = (): string[] => [join(qwenRuntimeDir(), 'projects'), join(qwenDir(), 'tmp')];

/**
 * The hook documentation merged on 2026-03-26, one day before 0.13.1; the gate
 * is the next full minor, so a version that is told it has hooks really does.
 * Below it the adapter still detects and still backfills.
 */
export const QWEN_HOOKS_MIN_VERSION = '0.14.0';

/**
 * Qwen Code fires 21 Claude-shaped events. These seven are the ones the state
 * machine scores; the rest (PreCompact, SubagentStart, TodoCreated, …) are
 * mapped to nothing rather than installed and ignored.
 */
export const QWEN_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'StopFailure', 'SessionEnd',
];

const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name']> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
};

// Fired, but not a session fact: they would either double-count something the
// scored events already carry or count nothing at all.
const IGNORED = new Set([
  'PreToolUse', 'PostToolBatch', 'UserPromptExpansion', 'SessionDelete', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Notification',
  'PermissionRequest', 'PermissionDenied', 'TodoCreated', 'TodoCompleted', 'InstructionsLoaded',
]);

export const qwenAdapter: Adapter = {
  id: 'qwen',
  label: 'Qwen Code',
  hookEvents: QWEN_EVENTS,

  detect: () => existsSync(qwenDir()) || onPath('qwen'),

  install(remove = false): string[] {
    const written: string[] = [];
    const version = binaryVersion('qwen');
    if (remove || atLeast(version, QWEN_HOOKS_MIN_VERSION)) {
      written.push(installQwenHooks(qwenSettingsPath(), remove));
    } else {
      written.push(`no live hooks: qwen ${version ?? 'version unknown'} predates the hook system (needs ${QWEN_HOOKS_MIN_VERSION}+); \`nerfd backfill qwen\` still works`);
    }
    written.push(installQwenCommand(qwenCommandPath(), remove));
    return written;
  },

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object') return null;
    const i = input as HookInput;
    const name = i.hook_event_name ?? '';
    if (IGNORED.has(name)) return null;

    const mapped = EVENT_MAP[name] ?? (isCanonicalEvent(name) ? name : null);
    if (!mapped) return null;

    // PostToolUse carries the result: a tool that reports an error is a
    // failure whichever event name it arrived under.
    if (mapped === 'PostToolUse') {
      const r = (i.tool_response ?? {}) as Record<string, unknown>;
      if (r.error != null || r.success === false || r.status === 'error') {
        return { ...i, hook_event_name: 'PostToolUseFailure', error: r.error ?? r };
      }
    }
    return { ...i, hook_event_name: mapped };
  },

  ledger(session: Session): FamilyLedger | null {
    const path = session.transcript_path && existsSync(session.transcript_path)
      ? session.transcript_path
      : findFamilyChat(qwenChatRoots(), session.id);
    if (!path || !existsSync(path)) return null;
    const { facts } = parseGeminiFamilyChat(path, 'qwen');
    return { ...emptyLedger(), ...facts, ...qwenIdentity(facts.model) };
  },

  /** Text is read here and dropped when the signals are computed. */
  turns(session: Session): AdapterTurn[] {
    const path = session.transcript_path && existsSync(session.transcript_path)
      ? session.transcript_path
      : findFamilyChat(qwenChatRoots(), session.id);
    return path ? qwenTurns(path) : [];
  },

  backfill: (sinceIso: string): Session[] => qwenBackfill(qwenChatRoots(), sinceIso),
};

/** The backfill itself, with the search roots passed in so it can be tested. */
export function qwenBackfill(roots: string[], sinceIso: string): Session[] {
  const out: Session[] = [];
  const ids = qwenIdentity(null);
  for (const f of listFamilyChats(roots, sinceIso)) {
    const { facts, turns, session_id } = parseGeminiFamilyChat(f.path, 'qwen', { detail: true });
    const s = backfillSession('qwen', session_id ?? f.session_id, f.path, facts, {
      ...ids,
      raw_model: facts.model,
    });
    if (!s) continue;
    // Backfilled sessions never pass through `finalise`, so the signals are
    // computed here instead.
    attachSignals(s, turns);
    out.push(s);
  }
  return out;
}

/** Turns in order, with prompt text, paths and commands. Local use only. */
export function qwenTurns(path: string): AdapterTurn[] {
  return parseGeminiFamilyChat(path, 'qwen', { detail: true }).turns;
}

// ---- who served it -------------------------------------------------------

// Qwen Code points at anything OpenAI-compatible, so the endpoint is the only
// honest evidence of who served the weights. Hosts that are a known provider
// are named; anything else is left to the resolver, which knows a private
// address from a public one.
const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)dashscope[-a-z]*\.aliyuncs\.com$/i, 'alibaba'],
  [/(^|\.)portal\.qwen\.ai$/i, 'alibaba'],
  [/(^|\.)openrouter\.ai$/i, 'openrouter'],
  [/(^|\.)moonshot\.(cn|ai)$/i, 'moonshotai'],
  [/(^|\.)bigmodel\.cn$/i, 'zai'],
  [/(^|\.)z\.ai$/i, 'zai'],
  [/(^|\.)deepseek\.com$/i, 'deepseek'],
  [/(^|\.)minimaxi?\.(com|chat)$/i, 'minimax'],
  [/(^|\.)openai\.com$/i, 'openai'],
];

export function providerFromUrl(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  let host: string;
  try { host = new URL(/^[a-z]+:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).hostname; } catch { return null; }
  return HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
}

export interface QwenConfig {
  auth_type: string | null;
  base_url: string | null;
  declared_name: string | null;
}

/**
 * Read the endpoint and the auth type out of settings.json. Never the key:
 * `apiKey` and `envKey` are not touched, and `envKey` only names an
 * environment variable anyway.
 */
export function qwenConfig(settingsPath = qwenSettingsPath()): QwenConfig {
  let settings: Record<string, unknown> = {};
  try { settings = readJsonFile(settingsPath); } catch { /* unparseable config is not a session error */ }

  const security = (settings.security ?? {}) as Record<string, unknown>;
  const auth = (security.auth ?? {}) as Record<string, unknown>;
  const authType = (auth.selectedType ?? settings.selectedAuthType) as unknown;

  const providers = (settings.modelProviders ?? {}) as Record<string, unknown>;
  const openaiEntries = (providers.openai as Array<Record<string, unknown>>) ?? [];
  const entry = Array.isArray(openaiEntries) ? openaiEntries[0] : undefined;

  const pick = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

  return {
    auth_type: pick(authType),
    base_url: pick(auth.baseUrl) ?? pick(entry?.baseUrl) ?? pick(process.env.OPENAI_BASE_URL),
    declared_name: pick(process.env.OPENAI_MODEL) ?? pick(entry?.name) ?? pick(entry?.id),
  };
}

export function qwenIdentity(model: string | null, cfg: QwenConfig = qwenConfig()): { raw_model: string | null; raw_provider: string | null; base_url: string | null; declared_name: string | null; auth_type: string | null } {
  const byAuth =
    cfg.auth_type === 'qwen-oauth' ? 'alibaba'
    : cfg.auth_type === 'gemini' ? 'google'
    : cfg.auth_type === 'vertex-ai' ? 'google-vertex'
    : cfg.auth_type === 'anthropic' ? 'anthropic'
    : null;
  return {
    raw_model: model,
    raw_provider: providerFromUrl(cfg.base_url) ?? byAuth,
    base_url: cfg.base_url,
    declared_name: cfg.declared_name,
    auth_type: cfg.auth_type,
  };
}

// ---- install -------------------------------------------------------------

export function installQwenHooks(path: string, remove = false): string {
  const settings = readJsonFile(path);
  const hooks = mergeHooks((settings.hooks as HooksMap) ?? {}, QWEN_EVENTS, qwenHookEntry, remove);
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  writeJsonWithBackup(path, settings);
  return path;
}

function qwenHookEntry(event: string): HookEntry {
  return {
    matcher: '*',
    hooks: [{
      name: `${HOOK_TAG}-${event.toLowerCase()}`,
      // `http` would POST straight to an endpoint; a local metric never leaves
      // the machine, so this is a local command like every other adapter's.
      type: 'command',
      command: shellCommand([process.execPath, CLI_PATH, 'hook', 'qwen']),
      description: 'nerfd session metrics (local; see nerfd privacy)',
      timeout: event === 'SessionEnd' ? 30 : 10, // seconds here, unlike Gemini
      [HOOK_TAG]: true,
    }],
  };
}

/** `/nerfd 4 kept "solid refactor"` inside Qwen Code: a markdown custom command. */
export function installQwenCommand(path: string, remove = false): string {
  if (remove) {
    try { if (existsSync(path)) writeFileSync(path, ''); } catch { /* ignore */ }
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  const cmd = shellCommand([process.execPath, CLI_PATH, 'rate', 'last']);
  writeFileSync(path, [
    '---',
    'description: Rate this session for nerfd (e.g. /nerfd 4 kept "solid refactor")',
    '---',
    '',
    'Session rating recorded:',
    '',
    `!{${cmd} {{args}}}`,
    '',
    'Reply with one short line acknowledging the rating. Do not do anything else.',
    '',
  ].join('\n'));
  return path;
}

export function qwenHookStatus(settingsPath = qwenSettingsPath()): boolean {
  try { return hasOurHooks(readJsonFile(settingsPath).hooks as HooksMap | undefined); }
  catch { return false; }
}
