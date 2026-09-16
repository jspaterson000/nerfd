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
 * Gemini CLI.
 *
 * Two paths, as always: hooks for session shape, the JSONL chat file for
 * tokens and the model. Nothing here goes near Gemini CLI's OpenTelemetry
 * exporter: its common attributes include `user.email`, it is Google's
 * pipeline configured by Google's settings, and nerfd neither reads it nor
 * turns it on. `~/.gemini/google_accounts.json` and `oauth_creds.json` are
 * likewise never opened; the auth *type* comes from settings.json, which
 * holds no credential.
 */

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');

export const GEMINI_DIR = join(homedir(), '.gemini');
export const GEMINI_SETTINGS = join(GEMINI_DIR, 'settings.json');
export const GEMINI_CHATS_ROOT = join(GEMINI_DIR, 'tmp');
export const GEMINI_COMMAND = join(GEMINI_DIR, 'commands', 'nerfd.toml');

/**
 * Hooks landed in the 0.20 line (the hook documentation merged on 2025-12-03,
 * between 0.19.1 and 0.20.0) and are verified working on 0.41.2, where the
 * event names, the settings shape and the stdin payload were all read out of
 * the installed bundle. Below the gate the adapter is still useful: detect,
 * backfill and `nerfd record` work, there is simply nothing live to hook.
 */
export const GEMINI_HOOKS_MIN_VERSION = '0.20.0';

/**
 * Deliberately four events, not eleven.
 *
 * `BeforeModel` and `AfterModel` are not installed: their payloads carry the
 * whole request and the whole response — every prompt, every file the agent
 * read, every word it wrote — through our stdin on every model call. The
 * model id they carry is in the chat file anyway. `AfterAgent` would cost the
 * full assistant reply for an event the state machine does nothing with, and
 * `PreCompress` has no canonical counterpart that would not inflate the error
 * count. All four are still mapped by `normalise` for anyone who adds them.
 */
export const GEMINI_EVENTS = ['SessionStart', 'BeforeAgent', 'AfterTool', 'SessionEnd'];

export const geminiAdapter: Adapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  hookEvents: GEMINI_EVENTS,

  detect: () => existsSync(GEMINI_DIR) || onPath('gemini'),

  install(remove = false): string[] {
    const written: string[] = [];
    const version = binaryVersion('gemini');
    if (remove || atLeast(version, GEMINI_HOOKS_MIN_VERSION)) {
      written.push(installGeminiHooks(GEMINI_SETTINGS, remove));
    } else {
      written.push(`no live hooks: gemini ${version ?? 'version unknown'} predates the hook system (needs ${GEMINI_HOOKS_MIN_VERSION}+); \`nerfd backfill gemini\` still works`);
    }
    written.push(installGeminiCommand(GEMINI_COMMAND, remove));
    return written;
  },

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object') return null;
    const i = input as HookInput;
    const name = i.hook_event_name ?? '';

    switch (name) {
      case 'SessionStart':
      case 'SessionEnd':
        return { ...i, hook_event_name: name };

      // The prompt event. Gemini fires it once per user turn, before the loop.
      case 'BeforeAgent':
        return { ...i, hook_event_name: 'UserPromptSubmit' };

      case 'AfterTool': {
        const r = (i.tool_response ?? {}) as Record<string, unknown>;
        const failed = r.error != null || r.success === false;
        return {
          ...i,
          hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
          error: failed ? r.error : i.error,
        };
      }

      // Carries `llm_request.model`, which is the one thing worth taking from
      // it. Treated as a session-start update: idempotent, counts nothing.
      case 'BeforeModel': {
        const model = ((i.llm_request ?? {}) as Record<string, unknown>).model;
        if (typeof model !== 'string' || !model) return null;
        return { ...i, hook_event_name: 'SessionStart', model };
      }

      // Everything the response carries is either output text or a token count
      // the chat file already has, and one of those two is not ours to hold.
      case 'AfterModel':
      // Idle prompts, permission dialogs and auth messages are not session facts.
      case 'Notification':
      case 'BeforeTool':
      case 'BeforeToolSelection':
      case 'AfterAgent':
      case 'PreCompress':
        return null;

      default:
        return isCanonicalEvent(name) ? { ...i, hook_event_name: name } : null;
    }
  },

  ledger(session: Session): FamilyLedger | null {
    const path = session.transcript_path && existsSync(session.transcript_path)
      ? session.transcript_path
      : findFamilyChat([GEMINI_CHATS_ROOT], session.id);
    if (!path || !existsSync(path)) return null;
    const { facts } = parseGeminiFamilyChat(path, 'gemini');
    return { ...emptyLedger(), ...facts, ...geminiIdentity(facts.model) };
  },

  /** Text is read here and dropped when the signals are computed. */
  turns(session: Session): AdapterTurn[] {
    const path = session.transcript_path && existsSync(session.transcript_path)
      ? session.transcript_path
      : findFamilyChat([GEMINI_CHATS_ROOT], session.id);
    return path ? geminiTurns(path) : [];
  },

  backfill: (sinceIso: string): Session[] => geminiBackfill([GEMINI_CHATS_ROOT], sinceIso),
};

/** The backfill itself, with the search roots passed in so it can be tested. */
export function geminiBackfill(roots: string[], sinceIso: string): Session[] {
  const out: Session[] = [];
  const ids = geminiIdentity(null);
  for (const f of listFamilyChats(roots, sinceIso)) {
    // One parse for both: the facts and the turns come out together, so a
    // 100 MB chat file is read once rather than twice.
    const { facts, turns, session_id } = parseGeminiFamilyChat(f.path, 'gemini', { detail: true });
    const s = backfillSession('gemini', session_id ?? f.session_id, f.path, facts, {
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
export function geminiTurns(path: string): AdapterTurn[] {
  return parseGeminiFamilyChat(path, 'gemini', { detail: true }).turns;
}

/**
 * Which Google endpoint served this: the API, or Vertex. Read from
 * settings.json only — `selectedType` in the current nested shape,
 * `selectedAuthType` in the old flat one. No credential file is touched.
 */
export function geminiAuthType(settingsPath = GEMINI_SETTINGS): string | null {
  let settings: Record<string, unknown>;
  try { settings = readJsonFile(settingsPath); } catch { return null; }
  const security = (settings.security ?? {}) as Record<string, unknown>;
  const auth = (security.auth ?? {}) as Record<string, unknown>;
  const t = auth.selectedType ?? settings.selectedAuthType;
  return typeof t === 'string' && t ? t : null;
}

function geminiIdentity(model: string | null): { raw_model: string | null; raw_provider: string; base_url: string | null; declared_name: string | null; auth_type: string | null } {
  const auth = geminiAuthType();
  return {
    raw_model: model,
    // Vertex is a different provider with different prices, and the auth type
    // is the only local evidence of which one was used.
    raw_provider: auth === 'vertex-ai' ? 'google-vertex' : 'google',
    base_url: null,
    declared_name: null,
    auth_type: auth,
  };
}

// ---- install -------------------------------------------------------------

/** Merge our hook entries into settings.json, keeping everything already there. */
export function installGeminiHooks(path: string, remove = false): string {
  const settings = readJsonFile(path);
  const hooks = mergeHooks((settings.hooks as HooksMap) ?? {}, GEMINI_EVENTS, geminiHookEntry, remove);
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  writeJsonWithBackup(path, settings);
  return path;
}

function geminiHookEntry(event: string): HookEntry {
  return {
    // Every tool, so an AfterTool entry is not silently scoped to one of them.
    matcher: '*',
    hooks: [{
      name: `${HOOK_TAG}-${event.toLowerCase()}`,
      type: 'command',
      // Gemini runs this through `sh -c`, so both paths are quoted.
      command: shellCommand([process.execPath, CLI_PATH, 'hook', 'gemini']),
      description: 'nerfd session metrics (local; see nerfd privacy)',
      timeout: event === 'SessionEnd' ? 30_000 : 10_000, // milliseconds here
      [HOOK_TAG]: true,
    }],
  };
}

/** `/nerfd 4 kept "solid refactor"` inside Gemini CLI: a TOML custom command. */
export function installGeminiCommand(path: string, remove = false): string {
  if (remove) {
    try { if (existsSync(path)) writeFileSync(path, ''); } catch { /* ignore */ }
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  const cmd = shellCommand([process.execPath, CLI_PATH, 'rate', 'last']);
  writeFileSync(path, [
    'description = "Rate this session for nerfd (e.g. /nerfd 4 kept \\"solid refactor\\")"',
    'prompt = """',
    'Session rating recorded:',
    '',
    `!{${cmd} {{args}}}`,
    '',
    'Reply with one short line acknowledging the rating. Do not do anything else.',
    '"""',
    '',
  ].join('\n'));
  return path;
}

/** Are our hooks currently installed? Used by `nerfd check`-style output. */
export function geminiHookStatus(settingsPath = GEMINI_SETTINGS): boolean {
  try { return hasOurHooks(readJsonFile(settingsPath).hooks as HooksMap | undefined); }
  catch { return false; }
}
