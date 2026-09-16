import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@nerfd/core';
import { CONTEXT_LIMIT_RE, TOOL_ARG_ERROR_RE } from '../transcript.ts';
import { backfillSession } from './backfill.ts';
import { emptyLedger, isCanonicalEvent, type Adapter, type HookInput, type LedgerFacts, type NormalisedEvent } from './types.ts';

// GitHub Copilot CLI has the richest hook surface of the four backfill tools —
// fourteen events — and the least documented store. Both halves are used: the
// hooks give session boundaries and tool calls live, and
// `~/.copilot/session-state/<id>/events.jsonl` gives the model and the token
// counts once the session has shut down.
//
// Two things about the hooks decide the shape of install():
//
//   1. Hooks are their own files. `~/.copilot/hooks/*.json` are each read
//      whole, so nerfd writes one file it owns entirely and never merges into
//      a file someone else is editing.
//   2. Each event has a camelCase name and a PascalCase alias, and the name
//      you register decides the payload casing: register `PostToolUse` and the
//      payload arrives as `{hook_event_name, session_id, tool_name,
//      tool_input}` — the Claude Code shape the rest of nerfd already speaks.
//      So the PascalCase aliases are registered, and normalise() accepts both.
//
// `preToolUse` is deliberately NOT registered: it is the one fail-closed event
// ("a non-zero exit denies the tool call"), and nothing nerfd measures is
// worth a chance of blocking someone's tool call.
//
// Verified against docs.github.com (2026-09-16):
//   /copilot/reference/hooks-reference                 the 14 events, payloads, exit codes
//   /copilot/how-tos/copilot-cli/customize-copilot/use-hooks       ~/.copilot/hooks/*.json
//   /copilot/reference/copilot-cli-reference/cli-config-dir-reference  session-state/, COPILOT_HOME
// The `events.jsonl` line schema is NOT documented by GitHub (github/copilot-cli#3551
// asks for it to be), so every field below is read defensively.

/** One line of a session, for the local `nerfd show --turns` view. */
export type AdapterTurn = {
  role: 'user' | 'assistant' | 'tool';
  ts: number;
  text?: string;
  tool?: string;
  path?: string;
  command?: string;
  ok?: boolean;
  interrupted?: boolean;
  thinking_tokens?: number;
  output_tokens?: number;
  model?: string;
  ends_with_question?: boolean;
};

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
const TAG = 'nerfd';

/** `$COPILOT_HOME`, else `~/.copilot`. There is no XDG override. */
export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

export const copilotHooksFile = (env?: NodeJS.ProcessEnv) => join(copilotHome(env), 'hooks', 'nerfd.json');
export const copilotSessionsDir = (env?: NodeJS.ProcessEnv) => join(copilotHome(env), 'session-state');

/**
 * The PascalCase aliases, which get the snake_case payloads. `PreToolUse` is
 * left out on purpose (see above), and so are the events with no canonical
 * meaning: `PreCompact` and `Notification` are not outcomes.
 */
export const COPILOT_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'ErrorOccurred', 'SessionEnd',
];

// Both spellings map onto the one vocabulary: whichever a person's own hook
// file registers, or a future Copilot build sends, is understood.
const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name']> = {
  SessionStart: 'SessionStart', sessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit', userPromptSubmitted: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse', postToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure', postToolUseFailure: 'PostToolUseFailure',
  Stop: 'Stop', agentStop: 'Stop',
  SubagentStop: 'Stop', subagentStop: 'Stop',
  ErrorOccurred: 'StopFailure', errorOccurred: 'StopFailure',
  SessionEnd: 'SessionEnd', sessionEnd: 'SessionEnd',
};

function s(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function n(v: unknown): number {
  const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
}

/** Copilot times events either as epoch millis or as an ISO string. */
function ts(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

// --- hooks ------------------------------------------------------------------

/**
 * One file, owned outright. `{"version":1,"hooks":{...}}` with an `exec` and
 * `args` entry, which is the Copilot-CLI-only form that needs no shell and so
 * no quoting. Uninstall removes the file, after backing it up if it somehow
 * is not the one we wrote.
 */
export function installCopilot(remove = false, path = copilotHooksFile()): string {
  if (remove) {
    if (existsSync(path)) {
      copyFileSync(path, `${path}.bak-${TAG}-${Date.now()}`);
      rmSync(path, { force: true });
    }
    return path;
  }
  const hooks: Record<string, unknown[]> = {};
  for (const ev of COPILOT_EVENTS) {
    hooks[ev] = [{
      type: 'command',
      exec: process.execPath,
      args: [CLI_PATH, 'hook', 'copilot'],
      timeoutSec: ev === 'SessionEnd' ? 30 : 10,
      [TAG]: true,
    }];
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${TAG}-${Date.now()}`);
  writeFileSync(path, JSON.stringify({ version: 1, hooks }, null, 2) + '\n');
  return path;
}

/** Are our hooks installed? Used by `nerfd doctor`. */
export function copilotHookInstalled(path = copilotHooksFile()): boolean {
  if (!existsSync(path)) return false;
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown[]> };
    return Object.values(f.hooks ?? {}).some((list) => Array.isArray(list) && list.length > 0);
  } catch {
    return false;
  }
}

// --- the event log ----------------------------------------------------------

interface LogEvent { type: string; ts: number | null; data: Record<string, unknown> }

export function readCopilotEvents(path: string): LogEvent[] {
  if (!existsSync(path)) return [];
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out: LogEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    // Copilot has open bugs about raw newlines and U+2028 breaking its own
    // parse of this file; a line that will not parse is skipped, not fatal.
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = s(o.type) ?? s(o.event);
    if (!type) continue;
    const data = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
    out.push({ type, ts: ts(o.timestamp ?? o.ts ?? data.timestamp), data });
  }
  return out;
}

interface ModelUsage { model: string; tokens_in: number; tokens_out: number; cache_read: number }

/**
 * `session.shutdown` carries `data.modelMetrics[modelId].usage`, and its
 * `inputTokens` is inclusive of the cached tokens, so the cache is subtracted
 * back out to match how every other adapter splits the three numbers.
 */
function modelMetrics(data: Record<string, unknown>): ModelUsage[] {
  const raw = (data.modelMetrics ?? data.model_metrics) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return [];
  const out: ModelUsage[] = [];
  for (const [model, v] of Object.entries(raw)) {
    const usage = ((v as any)?.usage ?? v) as Record<string, unknown>;
    if (!usage || typeof usage !== 'object') continue;
    const cacheRead = n(usage.cacheReadTokens ?? usage.cache_read_tokens);
    const input = n(usage.inputTokens ?? usage.input_tokens);
    out.push({
      model,
      tokens_in: Math.max(0, input - cacheRead),
      tokens_out: n(usage.outputTokens ?? usage.output_tokens),
      cache_read: cacheRead,
    });
  }
  return out;
}

export function copilotFacts(path: string): LedgerFacts {
  const f = emptyLedger();
  const events = readCopilotEvents(path);
  let usage: ModelUsage[] = [];
  let lastPrompt: number | null = null;

  for (const e of events) {
    if (e.ts != null) { f.first_ts ??= new Date(e.ts).toISOString(); f.last_ts = new Date(e.ts).toISOString(); }
    switch (e.type) {
      case 'session.start':
        f.model ??= s(e.data.model) ?? s(e.data.modelId);
        f.tool_version ??= s(e.data.version) ?? s(e.data.cliVersion);
        break;
      case 'session.model_change':
        f.model = s(e.data.model) ?? s(e.data.to) ?? f.model;
        break;
      case 'user.message':
        lastPrompt = e.ts;
        break;
      case 'assistant.turn_end':
      case 'assistant.message':
        f.turns++;
        if (lastPrompt != null && e.ts != null && e.ts > lastPrompt && e.ts - lastPrompt < 30 * 60 * 1000) {
          f.latencies_ms.push(e.ts - lastPrompt);
          lastPrompt = null;
        }
        break;
      case 'session.compaction_start':
      case 'session.compaction_complete':
        f.context_limit_hits++;
        break;
      case 'abort':
        f.interrupts++;
        break;
      case 'tool.execution_complete': {
        // Counted by shape; the text itself is not kept anywhere.
        const text = `${s(e.data.error) ?? ''} ${s(e.data.status) ?? ''}`;
        if (e.data.success === false || s(e.data.status) === 'error' || e.data.error) {
          if (TOOL_ARG_ERROR_RE.test(text)) f.tool_call_errors++;
          if (CONTEXT_LIMIT_RE.test(text)) f.context_limit_hits++;
        }
        break;
      }
      case 'session.shutdown': {
        const found = modelMetrics(e.data);
        if (found.length) usage = found;
        break;
      }
      default:
        if (/error/i.test(e.type)) f.api_errors++;
    }
  }

  if (usage.length) {
    for (const u of usage) {
      f.tokens_in += u.tokens_in;
      f.tokens_out += u.tokens_out;
      f.tokens_cache_read += u.cache_read;
    }
    // Several models in one session is normal (a subagent runs a cheaper one).
    // The session is attributed to whichever did the most work.
    f.model = usage.slice().sort((a, b) => (b.tokens_in + b.tokens_out) - (a.tokens_in + a.tokens_out))[0]!.model;
  }
  f.raw_model = f.model;
  // Copilot bills through the subscription and no model choice changes that.
  // BYOK exists in the CLI (providers.json), but the event log names only the
  // model, so a BYOK session is attributed here and corrected by the resolver
  // when the id is not one GitHub serves.
  f.raw_provider = 'github-copilot';
  return f;
}

export const copilotEventsPath = (id: string, env?: NodeJS.ProcessEnv) =>
  join(copilotSessionsDir(env), id, 'events.jsonl');

/** Whatever this event calls the visible text, if it carries any. */
function text(data: Record<string, unknown>): string | undefined {
  return s(data.text) ?? s(data.content) ?? s(data.message) ?? s(data.prompt) ?? undefined;
}

function sessionDirs(sinceMs: number): Array<{ id: string; path: string }> {
  const base = copilotSessionsDir();
  let entries: string[] = [];
  try { entries = readdirSync(base); } catch { return []; }
  const out: Array<{ id: string; path: string }> = [];
  for (const id of entries) {
    const path = join(base, id, 'events.jsonl');
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.mtimeMs < sinceMs) continue;
    out.push({ id, path });
  }
  return out;
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

export const copilotAdapter: Adapter = {
  id: 'copilot',
  label: 'Copilot CLI',
  hookEvents: COPILOT_EVENTS,

  detect: () => existsSync(copilotHome()) || onPath('copilot'),

  install: (remove = false) => [installCopilot(remove)],

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object') return null;
    const i = input as HookInput & Record<string, unknown>;
    const name = s(i.hook_event_name) ?? s(i.hookEventName) ?? s(i.eventName) ?? s(i.event) ?? '';
    const mapped = EVENT_MAP[name] ?? (isCanonicalEvent(name) ? name : null);
    if (!mapped) return null;
    // A camelCase registration sends camelCase fields; rename them so the
    // state machine never has to know which spelling arrived.
    const out: NormalisedEvent = { ...i, hook_event_name: mapped };
    out.session_id ??= s(i.sessionId) ?? undefined;
    out.tool_name ??= s(i.toolName) ?? undefined;
    out.transcript_path ??= s(i.transcriptPath) ?? undefined;
    if (!out.tool_input && i.toolArgs && typeof i.toolArgs === 'object') out.tool_input = i.toolArgs as Record<string, unknown>;
    if (!out.error && i.error) out.error = i.error;
    return out;
  },

  ledger(session: Session): LedgerFacts | null {
    const path = copilotEventsPath(session.id);
    if (!existsSync(path)) return null;
    return copilotFacts(path);
  },

  backfill(sinceIso: string): Session[] {
    const since = Date.parse(sinceIso) || 0;
    const out: Session[] = [];
    for (const dir of sessionDirs(since)) {
      const facts = copilotFacts(dir.path);
      const s2 = backfillSession('copilot', dir.id, dir.path, facts, {
        raw_model: facts.raw_model,
        raw_provider: facts.raw_provider,
        base_url: null,
        declared_name: null,
      });
      if (s2) out.push(s2);
    }
    return out;
  },
};

/**
 * Turns from the event log, in the shape `Signals` consumes (`Turn` in
 * packages/core/src/signals.ts). Text, paths and commands are handed to the
 * detectors in memory and stored by nothing here.
 */
export function copilotTurns(session: Session): AdapterTurn[] {
  const events = readCopilotEvents(copilotEventsPath(session.id));
  const out: AdapterTurn[] = [];
  for (const e of events) {
    const at = e.ts ?? 0;
    if (e.type === 'user.message') { out.push({ role: 'user', ts: at, text: text(e.data) }); continue; }
    if (e.type === 'assistant.message' || e.type === 'assistant.turn_end') {
      const body = text(e.data);
      out.push({
        role: 'assistant', ts: at, text: body,
        model: s(e.data.model) ?? s(e.data.modelId) ?? undefined,
        ends_with_question: body ? body.trim().endsWith('?') : undefined,
      });
      continue;
    }
    if (e.type === 'tool.execution_complete' || e.type === 'tool.execution_start') {
      const args = (e.data.toolArgs ?? e.data.arguments ?? e.data.input) as Record<string, unknown> | undefined;
      const path = args ? s(args.path) ?? s(args.file_path) : null;
      const command = args ? s(args.command) ?? undefined : undefined;
      out.push({
        role: 'tool',
        ts: at,
        tool: s(e.data.toolName) ?? s(e.data.tool) ?? undefined,
        path: path ?? undefined,
        command,
        ok: e.type === 'tool.execution_complete' ? e.data.success !== false && !e.data.error : undefined,
      });
      continue;
    }
    if (e.type === 'abort') out.push({ role: 'assistant', ts: at, interrupted: true });
  }
  return out;
}
