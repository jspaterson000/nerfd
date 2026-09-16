import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, Turn } from '@nerfd/core';
import { wallOnlyWindow } from '../limits/wall.ts';
import { backfillSession } from './backfill.ts';
import { attachSignals, emptyLedger, isCanonicalEvent, type Adapter, type HookInput, type LedgerFacts, type NormalisedEvent } from './types.ts';
import {
  appendBlock, arrayAt, parseToml, removeBlock, stringAt, tableAt, tomlString, type TomlTable,
} from './kimi/toml.ts';

// Kimi Code CLI (`@moonshot-ai/kimi-code`; the Python `kimi-cli` is end of
// life and is not supported here).
//
// Two paths, as every adapter has:
//
//   Live      20 TOML hooks in `~/.kimi-code/config.toml`. The payload is
//             JSON on stdin with snake_case keys and no token counts.
//   Ledger    `~/.kimi-code/sessions/<workDirKey>/<sessionId>/` holding
//             `state.json` and `agents/main/wire.jsonl`, indexed by
//             `~/.kimi-code/session_index.jsonl`.
//
// The local REST server is deliberately NOT used. It only runs while `kimi
// web` is in the foreground, and every `/api/*` route except the liveness
// probe requires the bearer token from `~/.kimi-code/server.token`. Reading a
// user's token to read their own usage is exactly the thing docs/PRIVACY.md
// says this tool never does, so the API path is skipped and the quota numbers
// it would have provided are simply absent. See the note at PLAN_HINTS.
//
// Privacy notes specific to Kimi, all enforced below:
//   - every hook payload carries `session_title`, and `TurnStarted` carries
//     `prompt`. The title is dropped in `normalise`; the prompt is handled by
//     the same classify-then-discard path as every other tool.
//   - `state.json` holds `title` and `lastPrompt`. Neither is ever read.
//   - `wire.jsonl` is a full request trace, prompts and tool schemas
//     included. It is read for counters only; no text is returned from
//     `ledger`, and error text is classified into a fixed token, never kept.
//   - `config.toml` is parsed by a reader that drops credential-shaped keys
//     before they reach the returned object.

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');

/** Verified: `KIMI_CODE_HOME` relocates config, sessions, logs and credentials. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.KIMI_CODE_HOME ?? '').trim();
  return override || join(homedir(), '.kimi-code');
}

/** Verified: generic `.agents` resources stay under the real home even when KIMI_CODE_HOME is set. */
export function agentsSkillsDir(): string {
  return join(homedir(), '.agents', 'skills');
}

export const KIMI_CONFIG = (env?: NodeJS.ProcessEnv) => join(kimiHome(env), 'config.toml');
export const KIMI_SESSIONS = (env?: NodeJS.ProcessEnv) => join(kimiHome(env), 'sessions');
export const KIMI_INDEX = (env?: NodeJS.ProcessEnv) => join(kimiHome(env), 'session_index.jsonl');

/**
 * The events we install. `UserPromptSubmit` rather than `TurnStarted`,
 * because a turn also starts for a background task or a system trigger and
 * those are not prompts; `TurnStarted` is still understood by `normalise` for
 * anyone who wires it up themselves. `Interrupt` fires *in place of* `Stop`,
 * so installing both cannot double-count.
 */
export const KIMI_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'StopFailure', 'Interrupt', 'SessionEnd',
] as const;

// Kimi's own names on the left. Everything absent from this map is an event
// we do not score, and `normalise` returns null for it: SessionHeartbeat,
// UserPromptQueued, PreToolUse, Permission*, Subagent*, TaskStarted,
// Notification, and Pre/PostCompact (compaction has no canonical live event;
// it is counted from the wire log as a context-limit hit instead).
const EVENT_MAP: Record<string, NormalisedEvent['hook_event_name']> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  TurnStarted: 'UserPromptSubmit',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  Interrupt: 'Interrupt',
  SessionEnd: 'SessionEnd',
};

/**
 * Verified payload keys that carry human or model text nothing downstream
 * reads. `session_title` rides on every agent- and session-scoped event and is
 * generated from the conversation; `tool_output` is up to 2000 characters of
 * tool output; `error_message` and `response` are free text. All dropped here,
 * before the state machine ever sees them.
 */
const DROP_KEYS = [
  'session_title', 'origin_name', 'tool_output', 'error_message', 'response',
  'last_prompt', 'lastPrompt', 'title', 'body', 'display',
];

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * `[[hooks]]` accepts exactly four keys — event, matcher, command, timeout —
 * and the config fails to load if there is a fifth, so our marker cannot live
 * inside the table the way it does for Claude Code and Codex. It is a pair of
 * comments instead, and install/uninstall are pure text operations on the
 * region between them. Nothing else in the file is parsed, rewritten or
 * reformatted, so a config we do not fully understand cannot be damaged.
 */
function hookBlock(): string {
  const cmd = `${quote(process.execPath)} ${quote(CLI_PATH)} hook kimi`;
  const out: string[] = [
    '# nerfd session metrics. Managed by `nerfd init`; remove with `nerfd init --remove`.',
    '# Nothing here reads your prompts, your code or your credentials.',
  ];
  for (const ev of KIMI_EVENTS) {
    out.push('', '[[hooks]]', `event = ${tomlString(ev)}`, `command = ${tomlString(cmd)}`,
      `timeout = ${ev === 'SessionEnd' ? 30 : 10}`);
  }
  return out.join('\n');
}

/** Quote a path for a shell command string; both sh and cmd accept double quotes. */
function quote(p: string): string {
  return /^[A-Za-z0-9._/\\:-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`;
}

export function installKimi(remove = false, env: NodeJS.ProcessEnv = process.env): string {
  const path = installKimiHooks(remove, env);
  installKimiSkill(remove);
  return path;
}

/** The config.toml half of the install, on its own so a test can point it anywhere. */
export function installKimiHooks(remove = false, env: NodeJS.ProcessEnv = process.env): string {
  const path = KIMI_CONFIG(env);
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, 'utf8') : '';
  const after = remove ? removeBlock(before) : appendBlock(before, hookBlock());
  if (after !== before) {
    mkdirSync(dirname(path), { recursive: true });
    // The file holds api keys. Back it up beside itself, with the same
    // restrictive mode a fresh one would get.
    if (existed) copyFileSync(path, `${path}.bak-nerfd-${Date.now()}`);
    writeFileSync(path, after, existed ? undefined : { mode: 0o600 });
  }
  return path;
}

/**
 * `/nerfd` inside Kimi Code. Kimi invokes an Agent Skill as
 * `/skill:<name> <args>`, so this is `/skill:nerfd 4 kept "solid refactor"`,
 * and `$ARGUMENTS` is the raw argument string.
 */
export function installKimiSkill(remove = false, root: string = agentsSkillsDir()): string {
  const dir = join(root, 'nerfd');
  const path = join(dir, 'SKILL.md');
  if (remove) {
    try { rmSync(path, { force: true }); rmSync(dir, { recursive: false }); } catch { /* not ours to insist on */ }
    return path;
  }
  mkdirSync(dir, { recursive: true });
  const cmd = `${quote(process.execPath)} ${quote(CLI_PATH)} rate last $ARGUMENTS`;
  writeFileSync(path, [
    '---',
    'name: nerfd',
    'description: Rate this session for nerfd (e.g. /skill:nerfd 4 kept "solid refactor")',
    'type: prompt',
    'disableModelInvocation: true',
    '---',
    '',
    'Run exactly this shell command and show its one-line output, then stop:',
    '',
    '```sh',
    cmd,
    '```',
    '',
    'Do not edit any files. Do not do anything else.',
    '',
  ].join('\n'));
  return path;
}

/** True when our block is present in the config. Used by `nerfd doctor`. */
export function kimiHookInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  try { return readFileSync(KIMI_CONFIG(env), 'utf8').includes('nerfd session metrics'); } catch { return false; }
}

// ---------------------------------------------------------------------------
// normalise
// ---------------------------------------------------------------------------

const QUOTA_RE = /rate[ _-]?limit|429|too many requests|usage limit|hit your limit|(?<!context (window |length )?)limit reached|quota/i;
const OVERLOADED_RE = /overloaded|529|capacity|at capacity/i;
const TIMEOUT_RE = /timed? ?out|timeout|ETIMEDOUT|deadline exceeded|aborted by timeout/i;
const TOOL_ARG_RE = /input.?validation|invalid (tool )?(input|argument|parameter|schema)|does not match|failed to parse|unexpected token|is not valid json|required (property|parameter)|unrecognized (key|argument)|missing required|schema/i;
const CONTEXT_RE = /context (window|length|limit)|prompt is too long|exceeds? the (maximum )?context|too many tokens|compact/i;

/**
 * Error text from a tool or a failed turn can quote the prompt, a file path or
 * a command. It is never forwarded and never stored. What the state machine
 * actually needs is a classification, so that is computed here, from text that
 * is dropped on the next line, and the fixed tokens it returns are the only
 * thing that leaves this function. They are worded to match the regexes in
 * hooks/handler.ts so the existing counters keep working.
 */
export function classifyError(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : safeJson(raw);
  const out: string[] = [];
  if (QUOTA_RE.test(text)) out.push('rate limit');
  if (OVERLOADED_RE.test(text)) out.push('overloaded');
  if (TIMEOUT_RE.test(text)) out.push('timed out');
  if (TOOL_ARG_RE.test(text)) out.push('invalid tool input');
  if (CONTEXT_RE.test(text)) out.push('context limit');
  const name = errorName(raw);
  if (name) out.push(name);
  return out.join(' ') || 'error';
}

const IDENT_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/** A bare identifier from an error object or string, or null. Never a message. */
function errorName(raw: unknown): string | null {
  const IDENT = IDENT_RE;
  if (raw && typeof raw === 'object') {
    for (const k of ['name', 'type', 'error_type', 'code', 'kind']) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'string' && IDENT.test(v)) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
  }
  if (typeof raw === 'string') {
    const head = raw.trim().split(/[\s:]/, 1)[0] ?? '';
    return IDENT.test(head) && /(error|exception|failure|timeout|limit)/i.test(head) ? head : null;
  }
  return null;
}

function safeJson(x: unknown): string {
  try { return JSON.stringify(x) ?? ''; } catch { return ''; }
}

export const kimiAdapter: Adapter = {
  id: 'kimi',
  label: 'Kimi Code',
  hookEvents: [...KIMI_EVENTS],

  detect: () => existsSync(kimiHome()) || onPath('kimi'),

  install: (remove = false) => [installKimi(remove)],

  normalise(input: unknown): NormalisedEvent | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const i = input as HookInput;
    const name = typeof i.hook_event_name === 'string' ? i.hook_event_name : '';
    const mapped = EVENT_MAP[name] ?? (isCanonicalEvent(name) ? name : null);
    if (!mapped) return null;

    // Verified failure shapes, read before anything is dropped:
    // `PostToolUseFailure` carries `error` as a KimiErrorPayload
    // ({ code, message, name, details, retryable, cause }) whose `message` is
    // the tool's own output; `StopFailure` carries the flat pair `error_type`
    // and `error_message`. Both go through the classifier, which returns a
    // fixed token, and the text itself never reaches `out`.
    const failure = mapped === 'PostToolUseFailure' || mapped === 'StopFailure'
      ? classifyError(i.error ?? i.tool_response ?? { name: i.error_type, message: i.error_message })
      : null;

    const out: HookInput = { ...i };
    for (const k of DROP_KEYS) delete out[k];

    // `TurnStarted` carries the prompt for a user-originated turn and a task
    // or system description otherwise. Either way it counts as one prompt;
    // only a real user turn contributes text to the classifier.
    if (name === 'TurnStarted' && out.origin_kind !== 'user') delete out.prompt;

    if (failure) {
      out.error = failure;
      out.tool_response = failure;
      if (typeof out.error_type !== 'string' || !IDENT_RE.test(out.error_type)) delete out.error_type;
    }
    if (mapped === 'Interrupt') {
      // Verified as the literal string "cancelled", but the schema says
      // string, so it is reduced the same way rather than trusted.
      if (out.reason != null) out.reason = classifyError(out.reason);
    }
    return { ...out, hook_event_name: mapped };
  },

  ledger(session: Session): LedgerFacts | null {
    const dir = findSessionDir(session.id, session.cwd ?? null);
    if (!dir) return null;
    return kimiLedgerFrom(dir);
  },

  /** Text is read here and dropped when the signals are computed. */
  turns: (session: Session): Turn[] => kimiTurns(session),

  backfill(sinceIso: string): Session[] {
    const since = Date.parse(sinceIso) || 0;
    const out: Session[] = [];
    for (const row of readSessionIndex()) {
      let mtime = 0;
      try { mtime = statSync(join(row.dir, 'agents', 'main', 'wire.jsonl')).mtimeMs; } catch { continue; }
      if (mtime < since) continue;
      const facts = kimiLedgerFrom(row.dir);
      if (!facts) continue;
      const s = backfillSession('kimi', row.id, join(row.dir, 'agents', 'main', 'wire.jsonl'), facts, {
        raw_model: facts.raw_model,
        raw_provider: facts.raw_provider,
        base_url: facts.base_url,
        declared_name: facts.declared_name,
      });
      if (!s) continue;
      s.limit_windows = facts.limit_windows;
      // Backfilled sessions never pass through `finalise`, so the signals are
      // computed here instead.
      attachSignals(s, kimiTurnsFrom(row.dir));
      out.push(s);
    }
    return out;
  },
};

/** Is there a `kimi` on PATH? Checked without spawning anything. */
function onPath(bin: string): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of (process.env.PATH ?? '').split(sep)) {
    if (!d) continue;
    for (const e of exts) {
      try { if (statSync(join(d, bin + e)).isFile()) return true; } catch { /* next */ }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// session lookup
// ---------------------------------------------------------------------------

export interface KimiIndexRow { id: string; dir: string }

/**
 * `session_index.jsonl`: one record per line with `sessionId`, `sessionDir`
 * and `workDir`. `workDir` is a path, so it is read only to resolve a
 * relative `sessionDir` and is never returned.
 */
export function readSessionIndex(env: NodeJS.ProcessEnv = process.env): KimiIndexRow[] {
  const out: KimiIndexRow[] = [];
  let text: string;
  try { text = readFileSync(KIMI_INDEX(env), 'utf8'); } catch { return out; }
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const id = str(row.sessionId ?? row.session_id ?? row.id);
    if (!id) continue;
    // Deletion is a tombstone line, `{ sessionId, deleted: true }`.
    if (row.deleted === true) {
      const at = out.findIndex((r) => r.id === id);
      if (at >= 0) out.splice(at, 1);
      seen.delete(id);
      continue;
    }
    const raw = str(row.sessionDir ?? row.session_dir ?? row.dir);
    if (!raw) continue;
    // Absolute in a real index; resolved against the data root when relative,
    // which is what a copied or relocated index looks like.
    const dir = isAbsolute(raw) ? raw : join(kimiHome(env), raw);
    // Later lines win: the index is append-only and a session is re-indexed.
    if (seen.has(id)) {
      const at = out.findIndex((r) => r.id === id);
      if (at >= 0) out.splice(at, 1);
    }
    seen.add(id);
    out.push({ id, dir });
  }
  return out;
}

/** The directory for one session: the index first, then a bounded scan. */
export function findSessionDir(sessionId: string, _cwd: string | null = null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!sessionId) return null;
  const hit = readSessionIndex(env).find((r) => r.id === sessionId);
  if (hit && existsSync(hit.dir)) return hit.dir;
  const base = KIMI_SESSIONS(env);
  let buckets: string[] = [];
  try { buckets = readdirSync(base); } catch { return null; }
  for (const b of buckets) {
    const p = join(base, b, sessionId);
    try { if (statSync(p).isDirectory()) return p; } catch { /* next bucket */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface KimiModelConfig {
  alias: string | null;      // the `[models."<alias>"]` key, e.g. kimi-code/k3
  model: string | null;      // the id sent on the wire, e.g. k3
  provider_id: string | null;// the `[providers."<id>"]` key, e.g. managed:kimi-code
  provider_type: string | null; // kimi | anthropic | openai | openai_responses | google-genai | vertexai
  base_url: string | null;
  display_name: string | null;
  max_context_size: number | null;
}

/** Read config.toml. Credential-shaped keys never survive the parse. */
export function readKimiConfig(env: NodeJS.ProcessEnv = process.env): TomlTable | null {
  try { return parseToml(readFileSync(KIMI_CONFIG(env), 'utf8')); } catch { return null; }
}

/**
 * Resolve a model alias against the config's `[models.*]` registry and the
 * `[providers.*]` table. Returns ids and a base URL; never an api key.
 */
export function resolveKimiModel(cfg: TomlTable | null, alias: string | null): KimiModelConfig {
  const out: KimiModelConfig = {
    alias: null, model: null, provider_id: null, provider_type: null,
    base_url: null, display_name: null, max_context_size: null,
  };
  if (!cfg) { out.alias = alias; out.model = alias; return out; }
  const want = alias ?? stringAt(cfg, 'default_model');
  const models = tableAt(cfg, 'models');
  // The alias is the table key; a bare model id may also match a table whose
  // `model` field is that id, which is how a wire record's model resolves.
  let key: string | null = null;
  if (want && models) {
    if (models[want]) key = want;
    else {
      for (const [k, v] of Object.entries(models)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && (v as TomlTable).model === want) { key = k; break; }
      }
    }
  }
  const entry = key && models ? tableAt(models, key) : null;
  out.alias = key ?? want ?? null;
  out.model = stringAt(entry, 'model') ?? (want ? want.slice(want.lastIndexOf('/') + 1) : null);
  out.display_name = stringAt(entry, 'display_name');
  const ctx = entry?.max_context_size;
  out.max_context_size = typeof ctx === 'number' ? ctx : null;
  out.provider_id = stringAt(entry, 'provider') ?? stringAt(cfg, 'default_provider');
  const prov = out.provider_id ? tableAt(cfg, 'providers', out.provider_id) : null;
  out.provider_type = stringAt(prov, 'type');
  out.base_url = stringAt(prov, 'base_url');
  return out;
}

/**
 * The tool's own provider id, in the form the model resolver understands.
 * `managed:kimi-code` is Moonshot's coding-plan provider; the prefix is a
 * namespace, not part of the id.
 */
export function providerIdFor(cfg: KimiModelConfig): string | null {
  const id = cfg.provider_id?.replace(/^managed:/, '') ?? null;
  if (id) return id;
  // No provider table: the wire type is the only thing left to go on.
  return cfg.provider_type === 'kimi' ? 'kimi-code' : cfg.provider_type;
}

/**
 * A plan *family*, never a tier and never a credential. Moonshot's managed
 * provider means a Kimi Code membership, but which of the four tiers is only
 * knowable from `GET /api/v1/oauth/usage`, which needs the bearer token in
 * `~/.kimi-code/server.token` and a running `kimi web`. We do not read tokens,
 * so the tier stays unknown and the user resolves it with `nerfd plan`.
 */
const PLAN_HINTS: Record<string, string> = {
  'kimi-code': 'kimi-code',
  'kimi-for-coding': 'kimi-code',
  moonshot: 'api',
  moonshotai: 'api',
};

export function planHint(cfg: KimiModelConfig): string | null {
  const id = providerIdFor(cfg);
  if (!id) return null;
  if (PLAN_HINTS[id]) return PLAN_HINTS[id]!;
  if (/kimi[-_]?(code|for[-_]?coding)/i.test(id)) return 'kimi-code';
  return null;
}

// ---------------------------------------------------------------------------
// wire.jsonl
//
// Verified against the shipped bundle (`@moonshot-ai/kimi-code` 0.43.1,
// dist/main.mjs). Every durable event serialises as
//
//     { "type": "<dotted.name>", ...payload (camelCase), "time": <epoch ms> }
//
// with one exception: the first line is always
// `{"type":"metadata","protocol_version":"1.5","created_at":<epoch ms>}`.
//
// The records this reader cares about:
//
//   usage.record             { agentId, model, usage, usageScope }
//                            usage = { inputOther, output, inputCacheRead,
//                                      inputCacheCreation }. `model` is the
//                            ALIAS (`kimi-code/k3`), not the wire id, and
//                            inputOther EXCLUDES the two cache figures.
//   llm.request              { agentId, kind, provider, model, modelAlias?,
//                              turnStep?, ... } - the real wire model id.
//   turn.ended               { agentId, turnId, reason, error?, durationMs? }
//   turn.step.interrupted    { errorName, errorMessage, statusCode?, ... }
//   turn.step.retrying       { errorName, errorMessage, statusCode?, ... }
//   context.apply_compaction { tokensBefore?, tokensAfter?, ... }
//   context.append_loop_event{ agentId, event } - event.type is one of
//                            step.begin | content.part | tool.call |
//                            tool.result | step.end.
//
// `turn.started` is observable but NOT durable, so it never appears here.
//
// A format this specific will change. Every field is probed rather than
// assumed, and if not one known record type is recognised the reader falls
// back to a shape-agnostic scan so a renamed event costs counters, not a
// crash.
// ---------------------------------------------------------------------------

export interface KimiLedgerFacts extends LedgerFacts {
  /** Plan family only. Never a tier, never read from a credential. */
  plan_hint: string | null;
}

interface Usage { input: number; output: number; cache_read: number; cache_write: number; thinking: number }

const MODEL_KEYS = ['model', 'model_id', 'modelId', 'model_name', 'modelName'];
const PROVIDER_KEYS = ['provider', 'provider_id', 'providerId'];

function str(x: unknown): string | null {
  return typeof x === 'string' && x.trim() ? x.trim() : null;
}
function numOf(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}
function rec(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

/** Epoch ms from `time`, `created_at`, or any of the usual spellings. */
function tsOf(r: Record<string, unknown>): number | null {
  for (const k of ['time', 'created_at', 'ts', 'timestamp', 'createdAt', 'startedAt', 'at']) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    if (typeof v === 'string') { const p = Date.parse(v); if (Number.isFinite(p)) return p; }
  }
  return null;
}

function pick(r: Record<string, unknown>, keys: string[]): string | null {
  const details = rec(r.details);
  for (const k of keys) {
    const v = str(r[k]) ?? (details ? str(details[k]) : null);
    if (v) return v;
  }
  return null;
}

/**
 * Kimi's four counters, plus the OpenAI and Anthropic spellings as a fallback
 * for a future format. Returns null when nothing token-shaped is present.
 */
function usageOf(raw: unknown): Usage | null {
  const u = rec(raw);
  if (!u) return null;
  const n = (...keys: string[]) => {
    for (const k of keys) if (u[k] != null) return numOf(u[k]);
    return 0;
  };
  const out: Usage = {
    input: n('inputOther', 'input_tokens', 'inputTokens', 'prompt_tokens'),
    output: n('output', 'output_tokens', 'outputTokens', 'completion_tokens'),
    cache_read: n('inputCacheRead', 'cache_read_tokens', 'cache_read_input_tokens', 'cached_tokens'),
    cache_write: n('inputCacheCreation', 'cache_creation_tokens', 'cache_creation_input_tokens'),
    thinking: n('reasoning_tokens', 'reasoningTokens', 'thinking_tokens', 'thinkingTokens'),
  };
  return out.input || out.output || out.cache_read || out.cache_write ? out : null;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = rec(JSON.parse(line));
      if (v) out.push(v);
    } catch { /* a partial trailing line while the session is live */ }
  }
  return out;
}

/**
 * `state.json` holds `title` and `lastPrompt` next to the timestamps. Only
 * `createdAt` and `updatedAt` (epoch ms) are read; the two text fields are
 * deliberately not touched, and `lastTurnReason` is read because it says how
 * the session finished without saying anything about what it was about.
 */
export function readKimiState(dir: string): { first_ts: string | null; last_ts: string | null; last_turn_reason: string | null } {
  const iso = (x: unknown): string | null => {
    if (typeof x === 'number' && Number.isFinite(x) && x > 0) return new Date(x < 1e12 ? x * 1000 : x).toISOString();
    if (typeof x === 'string') { const p = Date.parse(x); if (Number.isFinite(p)) return new Date(p).toISOString(); }
    return null;
  };
  for (const p of [join(dir, 'state.json'), join(dir, 'session-meta', 'state.json')]) {
    try {
      const raw = rec(JSON.parse(readFileSync(p, 'utf8')));
      if (!raw) continue;
      return {
        first_ts: iso(raw.createdAt ?? raw.created_at),
        last_ts: iso(raw.updatedAt ?? raw.updated_at),
        last_turn_reason: str(raw.lastTurnReason ?? raw.last_turn_reason),
      };
    } catch { /* legacy location next */ }
  }
  return { first_ts: null, last_ts: null, last_turn_reason: null };
}

const MAIN_WIRE = join('agents', 'main', 'wire.jsonl');

/**
 * Everything the ledger knows about one finished Kimi session. Best effort:
 * a file it cannot make sense of yields the hook-derived counters unchanged
 * rather than an error, and no text from the wire log is ever returned.
 */
export function kimiLedgerFrom(dir: string, env: NodeJS.ProcessEnv = process.env): KimiLedgerFacts {
  const facts: KimiLedgerFacts = { ...emptyLedger(), plan_hint: null };

  const state = readKimiState(dir);
  facts.first_ts = state.first_ts;
  facts.last_ts = state.last_ts;
  if (state.last_turn_reason === 'cancelled') facts.interrupts++;

  const records = readJsonl(join(dir, MAIN_WIRE));
  let wireModel: string | null = null;
  let wireProvider: string | null = null;
  let modelAlias: string | null = null;
  let known = 0;
  let waitingSince: number | null = null;
  const totals: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, thinking: 0 };

  // Kimi caches no window state, so the wall is all there is to record: an
  // error kind of rate_limit or quota_exhausted means the subscription
  // refused the request. See docs/LIMITS.md.
  let wallHit = false;
  const note = (kind: string) => {
    // Overload is the fleet, not the wall: it never sets wallHit.
    if (/overloaded/i.test(kind)) facts.overloaded++;
    if (/rate limit|quota[ _-]?exhausted/i.test(kind)) { facts.rate_limit_hits++; wallHit = true; }
    if (/timed out/.test(kind)) facts.timeouts++;
    if (/context limit/.test(kind)) facts.context_limit_hits++;
  };

  for (const r of records) {
    const type = str(r.type) ?? '';
    const ts = tsOf(r);
    if (ts != null) {
      const iso = new Date(ts).toISOString();
      if (!facts.first_ts || iso < facts.first_ts) facts.first_ts = iso;
      if (!facts.last_ts || iso > facts.last_ts) facts.last_ts = iso;
    }

    switch (type) {
      case 'metadata':
        known++;
        continue;

      case 'usage.record': {
        known++;
        const u = usageOf(r.usage);
        if (u) {
          totals.input += u.input; totals.output += u.output;
          totals.cache_read += u.cache_read; totals.cache_write += u.cache_write;
        }
        modelAlias ??= str(r.model);
        continue;
      }

      case 'llm.request': {
        known++;
        // One request is one assistant call, which is what `turns` counts
        // everywhere else. A compaction request is bookkeeping, not a turn.
        if (str(r.kind) !== 'compaction') facts.turns++;
        wireModel = str(r.model) ?? wireModel;
        wireProvider = str(r.provider) ?? wireProvider;
        modelAlias = str(r.modelAlias) ?? modelAlias;
        continue;
      }

      case 'profile.bind':
      case 'config.update':
        known++;
        modelAlias = str(r.modelAlias) ?? modelAlias;
        continue;

      case 'turn.prompt':
        known++;
        if (ts != null) waitingSince = ts;
        continue;

      case 'turn.ended': {
        known++;
        const reason = str(r.reason);
        if (reason === 'cancelled') facts.interrupts++;
        if (reason === 'failed') {
          facts.api_errors++;
          note(classifyError(r.error));
        }
        const d = numOf(r.durationMs);
        if (d > 0 && d < 30 * 60 * 1000) facts.latencies_ms.push(d);
        else if (waitingSince != null && ts != null && ts - waitingSince > 0 && ts - waitingSince < 30 * 60 * 1000) {
          facts.latencies_ms.push(ts - waitingSince);
        }
        waitingSince = null;
        continue;
      }

      case 'turn.step.interrupted':
      case 'turn.step.retrying': {
        known++;
        // errorName and statusCode are enum-shaped; errorMessage can quote the
        // prompt, so it is classified here and dropped on the next line.
        note(classifyError({ name: str(r.errorName), code: numOf(r.statusCode) || undefined, message: r.errorMessage }));
        continue;
      }

      case 'context.apply_compaction':
        known++;
        facts.context_limit_hits++;
        continue;

      case 'context.append_loop_event': {
        known++;
        const inner = rec(r.event);
        if (!inner) continue;
        const it = str(inner.type) ?? '';
        if (it === 'tool.result' && (inner.isError === true || inner.is_error === true)) {
          const kind = classifyError(inner.error ?? inner.output ?? inner.content);
          if (/invalid tool input/.test(kind)) facts.tool_call_errors++;
          note(kind);
        }
        continue;
      }

      default:
        continue;
    }
  }

  if (known === 0 && records.length > 0) scanUnknownWire(records, facts, totals);

  facts.tokens_in = totals.input + totals.cache_write;
  facts.tokens_out = totals.output;
  facts.tokens_cache_read = totals.cache_read;
  if (wallHit) {
    facts.limit_windows = [wallOnlyWindow('primary')];
    facts.rate_limit_hits = Math.max(facts.rate_limit_hits, 1);
  }

  const cfg = readKimiConfig(env);
  const model = resolveKimiModel(cfg, modelAlias ?? wireModel);
  facts.model = wireModel ?? model.model ?? modelAlias;
  facts.raw_model = facts.model;
  facts.raw_provider = (wireProvider ?? model.provider_id)?.replace(/^managed:/, '') ?? providerIdFor(model);
  facts.base_url = model.base_url;
  facts.declared_name = model.display_name;
  facts.plan_hint = planHint(model);
  facts.tool_version = kimiVersion();
  return facts;
}

/**
 * The version gate. If a release renames every record type this recognises,
 * the reader stops guessing at structure and just looks for token-shaped
 * objects and error-shaped records anywhere in the file. Counters degrade;
 * nothing throws and nothing is invented.
 */
function scanUnknownWire(records: Array<Record<string, unknown>>, facts: KimiLedgerFacts, totals: Usage): void {
  for (const r of records) {
    const type = (str(r.type) ?? str(r.event) ?? str(r.kind) ?? '').toLowerCase();
    for (const key of ['usage', 'token_usage', 'tokenUsage', 'tokens']) {
      const u = usageOf(r[key]);
      if (u) {
        totals.input += u.input; totals.output += u.output;
        totals.cache_read += u.cache_read; totals.cache_write += u.cache_write;
        facts.turns++;
        break;
      }
    }
    if (/compact/.test(type)) facts.context_limit_hits++;
    if (/interrupt|cancel|abort/.test(type)) facts.interrupts++;
    if (/error|fail/.test(type) || r.error != null) {
      facts.api_errors++;
      const kind = classifyError(r.error ?? type);
      if (/rate limit/.test(kind)) facts.rate_limit_hits++;
      if (/overloaded/.test(kind)) facts.overloaded++;
      if (/timed out/.test(kind)) facts.timeouts++;
      if (/context limit/.test(kind)) facts.context_limit_hits++;
    }
  }
}

let versionCache: string | null | undefined;

/** `kimi --version` prints the version number and exits. Plain semver only. */
export function kimiVersion(): string | null {
  if (versionCache !== undefined) return versionCache;
  try {
    const out = execFileSync('kimi', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    versionCache = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    versionCache = null;
  }
  return versionCache;
}

// ---------------------------------------------------------------------------
// turns
// ---------------------------------------------------------------------------

/**
 * One row per conversational move. Declared locally, as every other adapter
 * declares it, and structurally identical to `Turn` in
 * packages/core/src/signals.ts, which is what consumes it.
 *
 * `text`, `path` and `command` are the session's own content. They exist so a
 * caller can classify a turn in memory; nothing in this package writes them to
 * disk or sends them anywhere, and a caller that needs to persist a path must
 * hash it first (`hashPath` in @nerfd/core), as hooks/handler.ts does.
 */
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

export function kimiTurns(session: Session): AdapterTurn[] {
  const dir = findSessionDir(session.id, session.cwd ?? null);
  return dir ? kimiTurnsFrom(dir) : [];
}

/** Flatten a message content field, which may be a string or a part array. */
function textOf(x: unknown): string | null {
  if (typeof x === 'string') return x.trim() || null;
  if (Array.isArray(x)) {
    const parts = x.map((p) => (typeof p === 'string' ? p : str(rec(p)?.text) ?? ''));
    return parts.filter(Boolean).join('\n').trim() || null;
  }
  const r = rec(x);
  return r ? textOf(r.content ?? r.text ?? r.input) : null;
}

/**
 * Rebuild the conversation from the wire log.
 *
 * Verified record shapes: a user turn is `turn.prompt` ({ input, origin });
 * assistant output and tool activity arrive as `context.append_loop_event`
 * with an inner `event.type` of `content.part`, `tool.call`, `tool.result` or
 * `step.end`; `context.append_message` covers messages appended outside the
 * loop. Assistant text accumulates across `content.part` records and is
 * flushed at the first `tool.call` or `step.end` that follows, which is where
 * one assistant message actually ends.
 */
export function kimiTurnsFrom(dir: string): AdapterTurn[] {
  const out: AdapterTurn[] = [];
  let model: string | null = null;
  let buffer: string[] = [];
  let bufferTs = 0;
  let lastAssistant = -1;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join('').trim();
    buffer = [];
    if (!text) return;
    const turn: AdapterTurn = { role: 'assistant', ts: bufferTs, text, ends_with_question: /\?["'`)\]]*\s*$/.test(text) };
    if (model) turn.model = model;
    lastAssistant = out.push(turn) - 1;
  };

  for (const r of readJsonl(join(dir, MAIN_WIRE))) {
    const type = str(r.type) ?? '';
    const ts = tsOf(r) ?? 0;

    if (type === 'llm.request') { model = str(r.model) ?? model; continue; }
    if (type === 'profile.bind' || type === 'config.update') { model = str(r.modelAlias) ?? model; continue; }

    if (type === 'usage.record') {
      // Usage lands after the step it belongs to; attach it to the assistant
      // message that step produced, if that message has none yet.
      const u = usageOf(r.usage);
      const t = lastAssistant >= 0 ? out[lastAssistant] : undefined;
      if (u && t && t.output_tokens == null) {
        t.output_tokens = u.output;
        if (u.thinking) t.thinking_tokens = u.thinking;
      }
      continue;
    }

    if (type === 'turn.prompt') {
      flush();
      const text = textOf(r.input);
      out.push(text ? { role: 'user', ts, text } : { role: 'user', ts });
      continue;
    }

    if (type === 'turn.ended') {
      flush();
      if (str(r.reason) === 'cancelled' && lastAssistant >= 0) out[lastAssistant]!.interrupted = true;
      continue;
    }

    if (type === 'context.append_message') {
      flush();
      const m = rec(r.message);
      const role = str(m?.role);
      if (role === 'user' || role === 'assistant') {
        const text = textOf(m?.content);
        const turn: AdapterTurn = { role, ts };
        if (text) turn.text = text;
        if (role === 'assistant') {
          if (model) turn.model = model;
          turn.ends_with_question = /\?["'`)\]]*\s*$/.test(text ?? '');
          lastAssistant = out.length;
        }
        out.push(turn);
      }
      continue;
    }

    if (type !== 'context.append_loop_event') continue;
    const inner = rec(r.event);
    if (!inner) continue;
    const it = str(inner.type) ?? '';

    if (it === 'content.part') {
      const text = textOf(inner.text ?? inner.content ?? inner.part);
      if (text) { if (!buffer.length) bufferTs = ts; buffer.push(text); }
      continue;
    }
    if (it === 'step.end' || it === 'step.begin') { flush(); continue; }

    if (it === 'tool.call') {
      flush();
      const turn: AdapterTurn = { role: 'tool', ts };
      const name = str(inner.name ?? inner.toolName ?? inner.tool_name);
      if (name) turn.tool = name;
      const args = rec(inner.args ?? inner.arguments ?? inner.input ?? inner.toolInput);
      const path = args ? str(args.file_path ?? args.path ?? args.filePath ?? args.notebook_path) : null;
      if (path) turn.path = path;
      const command = args ? str(args.command ?? args.cmd ?? args.script) : null;
      if (command) turn.command = command;
      out.push(turn);
      continue;
    }
    if (it === 'tool.result') {
      const ok = !(inner.isError === true || inner.is_error === true);
      // Attach the outcome to the call it answers rather than adding a row.
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k]!.role === 'tool' && out[k]!.ok === undefined) { out[k]!.ok = ok; break; }
      }
      continue;
    }
  }
  flush();
  return out;
}
