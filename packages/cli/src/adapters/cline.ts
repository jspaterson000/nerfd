import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@nerfd/core';
import { backfillSession } from './backfill.ts';
import { emptyLedger, type Adapter, type LedgerFacts, type NormalisedEvent } from './types.ts';

// Cline has no shell hooks at all, in either the CLI or the VS Code
// extension, so this adapter is scrape-only: it reads what Cline already
// wrote. The live path, when it is worth building, is the SDK's `onEvent`
// callback, whose `usage` event carries input, output, cache-read and
// cache-write tokens plus a running cost — a plugin like OpenCode's, not a
// hook. Nothing here installs anything.
//
// There are two storage layouts on disk and a machine can have both:
//
//   legacy (VS Code 3.x, still the majority of history)
//     <globalStorage>/saoudrizwan.claude-dev/tasks/<taskId>/
//       api_conversation_history.json, ui_messages.json, task_metadata.json
//   SDK sessions (the CLI, and VS Code 4.x)
//     ~/.cline/data/sessions/<id>/<id>.json  (manifest, with the totals)
//                                /<id>.messages.json
//
// Verified against cline/cline@82b8e1f (extension 4.1.18, CLI 3.0.62):
//   apps/vscode/src/core/storage/disk.ts                     GlobalFileNames, tasks/<id>/
//   apps/vscode/src/shared/ExtensionMessage.ts               ClineMessage, ClineApiReqInfo
//   apps/vscode/src/shared/getApiMetrics.ts                  which say types carry usage
//   apps/vscode/src/core/context/context-tracking/ContextTrackerTypes.ts  task_metadata.json
//   sdk/packages/shared/src/storage/paths.ts                 CLINE_DATA_DIR, sessions dir
//   sdk/packages/core/src/services/session-artifacts.ts      <id>.json, <id>.messages.json
//   sdk/packages/shared/src/agents/types.ts                  AgentUsageEvent (the future live path)
//
// Privacy: `ui_messages[].text` holds prompts, model output and file contents.
// The ledger parses it only for the JSON usage payloads and keeps only the
// numbers. `clineTurns` passes text, paths and commands to the signal
// detectors in memory, as `Turn` in packages/core/src/signals.ts is defined to
// take them; nothing here stores any of it. (docs/PRIVACY.md)

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

/** `$CLINE_DATA_DIR`, else `$CLINE_DIR/data`, else `~/.cline/data`. */
export function clineDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLINE_DATA_DIR?.trim()) return env.CLINE_DATA_DIR.trim();
  return join(env.CLINE_DIR?.trim() || join(homedir(), '.cline'), 'data');
}

export function clineSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLINE_SESSION_DATA_DIR?.trim()) return env.CLINE_SESSION_DATA_DIR.trim();
  return join(clineDataDir(env), 'sessions');
}

/** Where each VS Code flavour keeps extension global storage. */
function editorRoots(): string[] {
  const home = homedir();
  const names = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
  const bases = platform() === 'darwin'
    ? [join(home, 'Library', 'Application Support')]
    : platform() === 'win32'
      ? [process.env.APPDATA ?? join(home, 'AppData', 'Roaming')]
      : [process.env.XDG_CONFIG_HOME ?? join(home, '.config')];
  const out: string[] = [];
  for (const base of bases) for (const name of names) out.push(join(base, name, 'User', 'globalStorage', 'saoudrizwan.claude-dev'));
  return out;
}

export function clineTaskDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = env.CLINE_GLOBAL_STORAGE?.trim();
  const roots = extra ? [extra, ...editorRoots()] : editorRoots();
  return roots.map((r) => join(r, 'tasks')).filter((p) => existsSync(p));
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function n(v: unknown): number {
  const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
}

function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// --- legacy VS Code tasks ---------------------------------------------------

interface ClineMessage {
  ts?: number;
  type?: string;
  say?: string;
  ask?: string;
  text?: string;
  modelInfo?: { modelId?: string; providerId?: string; mode?: string };
}

/** The three say types Cline's own `getApiMetrics` sums. */
const USAGE_SAYS = new Set(['api_req_started', 'api_req_finished', 'deleted_api_reqs', 'subagent_usage']);

interface Usage { tokensIn: number; tokensOut: number; cacheWrites: number; cacheReads: number; cancelReason: string | null; hasTokens: boolean }

/**
 * `message.text` on a usage message is a JSON string. It also holds the
 * prompt on every other message type, which is why this only ever runs on the
 * four usage types and only ever returns numbers.
 */
function usageOf(text: string | undefined): Usage | null {
  if (!text) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const hasTokens = o.tokensIn != null || o.tokensOut != null || o.cacheReads != null || o.cacheWrites != null;
  return {
    tokensIn: n(o.tokensIn), tokensOut: n(o.tokensOut),
    cacheWrites: n(o.cacheWrites), cacheReads: n(o.cacheReads),
    cancelReason: s(o.cancelReason), hasTokens,
  };
}

export function clineTaskFacts(dir: string): LedgerFacts {
  const f = emptyLedger();
  const messages = readJson<ClineMessage[]>(join(dir, 'ui_messages.json')) ?? [];
  let pendingStart = false;    // an api_req_started that carried no totals yet
  let lastUser: number | null = null;

  for (const m of messages) {
    const at = typeof m.ts === 'number' ? m.ts : null;
    if (at != null) { f.first_ts ??= new Date(at).toISOString(); f.last_ts = new Date(at).toISOString(); }
    if (m.modelInfo?.modelId) f.model = m.modelInfo.modelId;
    if (m.modelInfo?.providerId) f.raw_provider = m.modelInfo.providerId;

    const kind = m.say ?? m.ask ?? '';
    if (m.type === 'ask' && (kind === 'followup' || kind === 'resume_task')) { lastUser = at; continue; }
    if (kind === 'user_feedback' || kind === 'task') { lastUser = at; continue; }

    if (USAGE_SAYS.has(kind)) {
      const u = usageOf(m.text);
      if (kind === 'api_req_started') {
        f.turns++;
        if (at != null && lastUser != null && at > lastUser && at - lastUser < 30 * 60 * 1000) {
          f.latencies_ms.push(at - lastUser);
          lastUser = null;
        }
        pendingStart = !u?.hasTokens;
      }
      // An older transcript splits the request across started/finished; a
      // newer one updates the started message in place. Count each pair once.
      const counts = u?.hasTokens && (kind !== 'api_req_finished' || pendingStart);
      if (counts && u) {
        f.tokens_in += u.tokensIn + u.cacheWrites;
        f.tokens_out += u.tokensOut;
        f.tokens_cache_read += u.cacheReads;
        if (kind === 'api_req_finished') pendingStart = false;
      }
      if (u?.cancelReason === 'user_cancelled') f.interrupts++;
      else if (u?.cancelReason) f.api_errors++;
      continue;
    }

    if (kind === 'error' || kind === 'api_req_failed') f.api_errors++;
    if (kind === 'diff_error') f.tool_call_errors++;
    if (kind === 'compaction' || kind === 'condense' || kind === 'summarize_task') f.context_limit_hits++;
  }

  // task_metadata.json is the only place the provider id is stated outright.
  const meta = readJson<{ model_usage?: Array<{ ts?: number; model_id?: string; model_provider_id?: string }> }>(join(dir, 'task_metadata.json'));
  const last = meta?.model_usage?.at(-1);
  if (last?.model_id) f.model = last.model_id;
  if (last?.model_provider_id) f.raw_provider = last.model_provider_id;

  f.raw_model = f.model;
  return f;
}

// --- SDK sessions -----------------------------------------------------------

interface SessionManifest {
  session_id?: string;
  started_at?: string | number;
  ended_at?: string | number;
  status?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  messages_path?: string;
  metadata?: Record<string, unknown>;
}

export function clineSessionFacts(dir: string, id: string): LedgerFacts {
  const f = emptyLedger();
  const manifest = readJson<SessionManifest>(join(dir, `${id}.json`));
  if (!manifest) return f;
  const md = manifest.metadata ?? {};
  f.tokens_in = n(md.tokensIn) + n(md.cacheWrites);
  f.tokens_out = n(md.tokensOut);
  f.tokens_cache_read = n(md.cacheReads);
  f.model = s(manifest.model);
  f.raw_provider = s(manifest.provider);
  f.first_ts = iso(manifest.started_at);
  f.last_ts = iso(manifest.ended_at) ?? f.first_ts;

  const payload = readJson<{ messages?: Array<Record<string, unknown>> }>(join(dir, `${id}.messages.json`));
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const m of payload?.messages ?? []) {
    const role = s(m.role);
    if (role === 'assistant') f.turns++;
    const at = iso(m.ts);
    // The manifest's own start and end win; the messages only widen the span,
    // never narrow it.
    if (at) {
      if (!earliest || at < earliest) earliest = at;
      if (!latest || at > latest) latest = at;
    }
    const metrics = (m.metrics ?? {}) as { tokens?: Record<string, unknown> };
    if (!manifest.metadata && metrics.tokens) {
      f.tokens_in += n(metrics.tokens.prompt);
      f.tokens_out += n(metrics.tokens.completion);
      f.tokens_cache_read += n(metrics.tokens.cached);
    }
  }
  if (earliest && (!f.first_ts || earliest < f.first_ts)) f.first_ts = earliest;
  if (latest && (!f.last_ts || latest > f.last_ts)) f.last_ts = latest;
  if (manifest.status === 'aborted' || manifest.status === 'cancelled') f.interrupts++;
  f.raw_model = f.model;
  return f;
}

// --- discovery --------------------------------------------------------------

export interface ClineRecord { id: string; dir: string; kind: 'task' | 'session'; mtime: number }

export function listClineRecords(sinceMs = 0): ClineRecord[] {
  const out: ClineRecord[] = [];
  const add = (base: string, kind: 'task' | 'session') => {
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { return; }
    for (const id of entries) {
      const dir = join(base, id);
      let st;
      try { st = statSync(dir); } catch { continue; }
      if (!st.isDirectory() || st.mtimeMs < sinceMs) continue;
      const marker = kind === 'task' ? join(dir, 'ui_messages.json') : join(dir, `${id}.json`);
      if (!existsSync(marker)) continue;
      out.push({ id, dir, kind, mtime: st.mtimeMs });
    }
  };
  add(clineSessionsDir(), 'session');
  for (const tasks of clineTaskDirs()) add(tasks, 'task');
  return out.sort((a, b) => b.mtime - a.mtime);
}

function findRecord(id: string): ClineRecord | null {
  return listClineRecords().find((r) => r.id === id) ?? null;
}

function facts(r: ClineRecord): LedgerFacts {
  return r.kind === 'task' ? clineTaskFacts(r.dir) : clineSessionFacts(r.dir, r.id);
}

export const clineAdapter: Adapter = {
  id: 'cline',
  label: 'Cline',
  // Cline has no shell hooks in either surface. The SDK's `onEvent` is the
  // live path when one is built; it is a plugin, not a hook.
  hookEvents: [],

  detect: () => existsSync(clineDataDir()) || clineTaskDirs().length > 0,

  install: () => [],

  normalise: (): NormalisedEvent | null => null,

  ledger(session: Session): LedgerFacts | null {
    const r = findRecord(session.id);
    return r ? facts(r) : null;
  },

  backfill(sinceIso: string): Session[] {
    const since = Date.parse(sinceIso) || 0;
    const out: Session[] = [];
    for (const r of listClineRecords(since)) {
      const f = facts(r);
      const s2 = backfillSession('cline', r.id, r.dir, f, {
        raw_model: f.raw_model,
        raw_provider: f.raw_provider,
        base_url: null,
        declared_name: null,
      });
      if (s2) out.push(s2);
    }
    return out;
  },
};

/**
 * Turns, in the shape `Signals` consumes. The `tool` say carries a JSON payload
 * with the tool name and the file it touched; the path is taken and the rest of
 * the payload — which contains the diff — is dropped.
 */
export function clineTurns(session: Session): AdapterTurn[] {
  const r = findRecord(session.id);
  if (!r) return [];
  if (r.kind === 'session') return sdkTurns(r);

  const out: AdapterTurn[] = [];
  const messages = readJson<ClineMessage[]>(join(r.dir, 'ui_messages.json')) ?? [];
  for (const m of messages) {
    const at = typeof m.ts === 'number' ? m.ts : 0;
    const kind = m.say ?? m.ask ?? '';
    if (kind === 'task' || kind === 'user_feedback') { out.push({ role: 'user', ts: at, text: m.text }); continue; }
    if (kind === 'text' && m.type === 'say') {
      out.push({
        role: 'assistant', ts: at, text: m.text, model: m.modelInfo?.modelId,
        ends_with_question: (m.text ?? '').trim().endsWith('?'),
      });
      continue;
    }
    if (kind === 'api_req_started') {
      const u = usageOf(m.text);
      if (u?.cancelReason === 'user_cancelled') out.push({ role: 'assistant', ts: at, interrupted: true });
      continue;
    }
    if (kind === 'tool' || kind === 'command') {
      const payload = safeObject(m.text);
      const path = s(payload.path) ?? s(payload.file_path);
      out.push({
        role: 'tool',
        ts: at,
        tool: s(payload.tool) ?? (kind === 'command' ? 'command' : undefined) ?? undefined,
        path: path ?? undefined,
        command: kind === 'command' ? (m.text || undefined) : undefined,
      });
      continue;
    }
    if (kind === 'error' || kind === 'diff_error') out.push({ role: 'tool', ts: at, ok: false });
  }
  return out;
}

function sdkTurns(r: ClineRecord): AdapterTurn[] {
  const payload = readJson<{ messages?: Array<Record<string, unknown>> }>(join(r.dir, `${r.id}.messages.json`));
  const out: AdapterTurn[] = [];
  for (const m of payload?.messages ?? []) {
    const role = s(m.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const at = typeof m.ts === 'number' ? m.ts : 0;
    const info = (m.modelInfo ?? {}) as { modelId?: string };
    out.push({ role, ts: at, model: role === 'assistant' ? info.modelId : undefined });
  }
  return out;
}

function safeObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const o = JSON.parse(text) as unknown;
    return o && typeof o === 'object' ? o as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
