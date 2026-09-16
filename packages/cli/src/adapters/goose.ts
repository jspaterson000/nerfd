import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Session, Turn } from '@nerfd/core';
import { backfillSession } from './backfill.ts';
import { readGooseConfig } from './goose/config.ts';
import { GOOSE_EVENTS, installGoose } from './goose/install.ts';
import { gooseConfigPath, gooseDbPath } from './goose/paths.ts';
import { gooseSessionFacts, gooseSessionTurns, listGooseSessions, withGooseDb, type AdapterTurn } from './goose/store.ts';
import { attachSignals, emptyLedger, type Adapter, type HookInput, type LedgerFacts, type NormalisedEvent } from './types.ts';

export type { AdapterTurn } from './goose/store.ts';

// Goose (Linux Foundation, formerly Block) splits the same way every other
// tool does: hooks give session boundaries and tool outcomes with no tokens in
// them, and `sessions.db` gives tokens, cost and the model that actually
// served each call. Its `usage_ledger` is the best of the two paths anywhere
// in this repo — one row per LLM call with model, token split, cost and cost
// provenance — which is exactly what a board comparing hosts of the same open
// weights needs.
//
// Everything here was verified against the source at github.com/aaif-goose/goose:
//   crates/goose/src/hooks/mod.rs                      event names, payload, matcher
//   crates/goose/src/agents/state_machine/ops_toolcalling.rs  which event fires when
//   crates/goose/src/session/session_manager.rs        schema v16
//   crates/goose/src/config/{paths,providers}.rs       where things live
//   documentation/docs/guides/context-engineering/hooks.md    payload and tool keys

export interface GooseLedgerFacts extends LedgerFacts {
  /** What Goose itself booked for the session. Kept for provenance; the handler re-prices. */
  ledger_cost_usd: number | null;
  /** "provider_reported" | "estimated" | "carried_forward". */
  ledger_cost_source: string | null;
}

// Goose's twelve events, mapped onto the nine this project scores.
//
// `AfterFileEdit` and `AfterShellExecution` are mapped but deliberately NOT
// subscribed to at install time: both fire *after* `PostToolUse` already fired
// for the same call, and only on success (ops_toolcalling.rs:277-297), so
// taking both would count one edit as two tool calls. The mapping exists
// because someone may add them to the plugin by hand, and a payload we asked
// for should not be scored while a payload we did not ask for is silently
// dropped.
const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name'] | null> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  Stop: 'Stop',
  SessionEnd: 'SessionEnd',
  AfterFileEdit: 'PostToolUse',
  AfterShellExecution: 'PostToolUse',
  // Observation-only or pre-flight: real events that carry no outcome.
  PreToolUse: null,
  PreToolUseResult: null,
  BeforeReadFile: null,
  BeforeShellExecution: null,
};

/** Goose namespaces tools as `extension__tool`; the local half is what it categorises on. */
function localToolName(name: string): string {
  const i = name.lastIndexOf('__');
  return i >= 0 ? name.slice(i + 2) : name;
}

const SHELL_TOOLS = new Set(['shell', 'bash', 'exec', 'run']);
const EDIT_TOOLS = new Set(['write', 'edit', 'patch', 'write_file', 'edit_file', 'create_file']);
const READ_TOOLS = new Set(['read', 'view', 'cat', 'read_file']);
/** `text_editor` subcommands that change a file. Anything else is a read. */
const EDITOR_WRITES = new Set(['write', 'create', 'str_replace', 'insert', 'undo_edit']);

function firstString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Map one Goose tool call onto the canonical `tool_name` / `tool_input` the
 * handler understands, keeping **only** the two fields it reads.
 *
 * This is a privacy boundary, not a convenience. `developer__write` carries
 * the whole file in `content` and `developer__edit` carries the before and
 * after text; those are source code, and source code must not reach the
 * session record, the log, or a stack trace. Everything but a path and a
 * command is dropped here, at the edge, before anything downstream sees it.
 */
function canonicalTool(name: string, input: Record<string, unknown>): { tool_name: string; tool_input: Record<string, unknown> } {
  const local = localToolName(name).toLowerCase();
  const path = firstString(input, ['path', 'file_path', 'file', 'filename']);
  const command = firstString(input, ['command', 'cmd']);

  if (SHELL_TOOLS.has(local)) return { tool_name: 'Bash', tool_input: command ? { command } : {} };
  if (EDIT_TOOLS.has(local)) return { tool_name: 'Edit', tool_input: path ? { file_path: path } : {} };
  if (READ_TOOLS.has(local)) return { tool_name: 'Read', tool_input: path ? { file_path: path } : {} };
  if (local === 'text_editor' || local === 'str_replace_editor') {
    // `command` here is an editor verb, not a shell command, and must never be
    // handed on as one.
    const write = command != null && EDITOR_WRITES.has(command.toLowerCase());
    return { tool_name: write ? 'Edit' : 'Read', tool_input: path ? { file_path: path } : {} };
  }
  const kept: Record<string, unknown> = {};
  if (path) kept.file_path = path;
  if (command) kept.command = command;
  return { tool_name: name, tool_input: kept };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** An exit code, wherever this event happened to put one. */
function exitCodeOf(i: HookInput): number | null {
  for (const src of [i, asRecord(i.tool_output), asRecord(i.tool_response)]) {
    for (const k of ['exit_code', 'exitCode', 'status', 'returncode']) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isInteger(v)) return v;
    }
  }
  return null;
}

/** Is `goose` on PATH? Checked by walking PATH rather than spawning anything. */
function gooseOnPath(): boolean {
  const path = process.env.PATH;
  if (!path) return false;
  return path.split(delimiter).some((dir) => dir && existsSync(join(dir, 'goose')));
}

/** `Adapter`, with the ledger typed one step more precisely. */
export interface GooseAdapter extends Omit<Adapter, 'ledger'> {
  ledger(session: Session): GooseLedgerFacts | null;
}

export const gooseAdapter: GooseAdapter = {
  id: 'goose',
  label: 'Goose',
  hookEvents: GOOSE_EVENTS,

  detect: () => gooseConfigPath() != null || gooseDbPath() != null || gooseOnPath(),

  install: (remove = false) => installGoose(remove),

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const i = input as HookInput;
    // Goose names the field `event`; every other tool here names it
    // `hook_event_name`. Accept both so a fixture from either side works.
    const name = typeof i.event === 'string' ? i.event : (i.hook_event_name ?? '');
    if (!(name in EVENT_MAP)) return null;
    const mapped = EVENT_MAP[name];
    if (!mapped) return null;

    const out: NormalisedEvent = { ...i, hook_event_name: mapped };
    // `working_dir`, not `cwd` (hooks/mod.rs, HookContext).
    if (typeof i.working_dir === 'string' && !out.cwd) out.cwd = i.working_dir;
    // The prompt arrives as `message`. The handler classifies it into a
    // category and throws it away; it is only kept if the person opted in.
    if (mapped === 'UserPromptSubmit' && typeof i.message === 'string') out.prompt = i.message;
    // `matcher_context` is a copy of the tool name, file path, command or the
    // prompt itself. It is never needed downstream and the prompt copy must
    // not survive, so it goes.
    delete out.matcher_context;

    if (name === 'AfterFileEdit' || name === 'AfterShellExecution') {
      const shell = name === 'AfterShellExecution';
      // `matcher_context` is the path (AfterFileEdit) or the command
      // (AfterShellExecution); `tool_input` carries the same value under the
      // matched tool's own key.
      const ctx = typeof i.matcher_context === 'string' ? i.matcher_context : null;
      const args = asRecord(i.tool_input);
      const value = shell
        ? (firstString(args, ['command', 'cmd']) ?? ctx)
        : (firstString(args, ['path', 'file_path', 'file']) ?? ctx);
      out.tool_name = shell ? 'Bash' : 'Edit';
      out.tool_input = value ? (shell ? { command: value } : { file_path: value }) : {};
      const code = exitCodeOf(i);
      // These two only fire on success, but a non-zero code would mean the
      // tool reported one anyway, and that is a failure whatever fired it.
      if (code != null && code !== 0) out.hook_event_name = 'PostToolUseFailure';
      return out;
    }

    if (typeof i.tool_name === 'string' && i.tool_name) {
      const { tool_name, tool_input } = canonicalTool(i.tool_name, asRecord(i.tool_input));
      out.tool_name = tool_name;
      out.tool_input = tool_input;
      // Keep the namespaced original: `developer__shell` and `git__shell` are
      // not the same tool, and only this field can tell them apart later.
      out.tool_name_raw = i.tool_name;
    }
    if (mapped === 'PostToolUseFailure' && out.error === undefined && i.tool_output !== undefined) {
      // The handler reads `error` / `tool_response` to tell a rate limit from a
      // timeout from a malformed tool call.
      out.error = i.tool_output;
    }
    return out;
  },

  ledger(session: Session): GooseLedgerFacts | null {
    const facts = withGooseDb((db) => gooseSessionFacts(db, session.id));
    if (!facts) return null;
    const cfg = readGooseConfig();
    return {
      ...emptyLedger(),
      ...facts,
      // `sessions.provider_name` is what this session actually used; the config
      // is only a fallback for a row written before that column existed.
      raw_provider: facts.provider_name ?? cfg.provider,
      raw_model: facts.model ?? facts.config_model ?? cfg.model,
      // The endpoint is the difference between a local q4 and the same name on
      // a hosted GPU, so it is resolved even when nothing overrode it.
      base_url: cfg.baseUrl,
      declared_name: cfg.model,
      ledger_cost_usd: facts.ledger_cost_usd,
      ledger_cost_source: facts.ledger_cost_source,
    };
  },

  /**
   * The conversation, for the behavioural signals. The text, paths and
   * commands in here live only as long as the `computeSignals` call that
   * consumes them; nothing on this path is stored.
   */
  turns(session: Session): Turn[] {
    return gooseTurns(session);
  },

  backfill(sinceIso: string): Session[] {
    const cfg = readGooseConfig();
    return withGooseDb((db) => {
      const out: Session[] = [];
      for (const { id } of listGooseSessions(db, sinceIso)) {
        const facts = gooseSessionFacts(db, id);
        if (!facts) continue;
        const s = backfillSession('goose', id, '', facts, {
          raw_model: facts.model ?? facts.config_model,
          raw_provider: facts.provider_name ?? cfg.provider,
          base_url: cfg.baseUrl,
          declared_name: null,
        });
        if (!s) continue;
        // A backfilled session has no transcript file to point at: Goose keeps
        // everything in SQLite, and the path would be the same for all of them.
        s.transcript_path = null;
        // Backfilled sessions never pass through `finalise`, so the signals
        // are computed here instead, on turns that are dropped immediately.
        attachSignals(s, gooseSessionTurns(db, id));
        out.push(s);
      }
      return out;
    }) ?? [];
  },
};

/** Turn-by-turn view of one session, for anything that needs more than counts. */
export function gooseTurns(session: Session): AdapterTurn[] {
  return withGooseDb((db) => gooseSessionTurns(db, session.id)) ?? [];
}
