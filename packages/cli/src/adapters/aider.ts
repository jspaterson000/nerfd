import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Session } from '@nerfd/core';
import { HOME, ensureHome } from '../paths.ts';
import { backfillSession } from './backfill.ts';
import { emptyLedger, type Adapter, type LedgerFacts, type NormalisedEvent } from './types.ts';

// Aider has no hooks, no plugin API and no session store. The one clean seam
// is its own analytics writer: `--analytics-log FILE` appends a JSONL line per
// event, and the log is written whether or not uploading is disabled
// (`Analytics.event` returns early only when there is no logfile *and* no
// upload client, and `disable()` clears only the clients). So the tool
// narrates itself to a local file and to nobody else.
//
// `install()` therefore installs no hook. It writes two keys into
// `~/.aider.conf.yml` and every later session lands in the log by itself.
// There is no live path and there will not be one: the repo's last commit was
// May 2026 and the last release February 2026.
//
// Verified against Aider-AI/aider@main (0.86.3.dev):
//   aider/analytics.py            `event()` log_entry = {event, properties, user_id, time}
//   aider/coders/base_coder.py    `self.event("message_send", ...)` in show_usage_report
//   aider/main.py                 config file search, `launched` / `cli session` / `exit`
//   aider/website/assets/sample.aider.conf.yml   the two key names

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

export const AIDER_CONF = join(homedir(), '.aider.conf.yml');
export const AIDER_DATA = join(homedir(), '.aider', 'analytics.json');
export const AIDER_LOG = join(HOME, 'aider-analytics.jsonl');
const MARK = '# nerfd';

/** A sitting is over when nothing has been logged for this long. */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** Aider's own words for "a run started". */
const START_EVENTS = new Set(['launched', 'cli session', 'gui session']);
/** The only event that carries a model and token counts. */
const SEND_EVENT = 'message_send';
/** The model raised; the message itself is never read, only counted. */
const SEND_FAILED = 'message_send_exception';

/** LiteLLM-style ids: `openrouter/qwen/qwen3-coder`, `ollama/…`, `gemini/…`. */
const PROVIDER_PREFIX: Record<string, string> = {
  openrouter: 'openrouter',
  ollama: 'ollama',
  ollama_chat: 'ollama',
  lm_studio: 'lmstudio',
  openai: 'openai',
  azure: 'azure',
  anthropic: 'anthropic',
  gemini: 'google',
  vertex_ai: 'vertex',
  bedrock: 'amazon-bedrock',
  deepseek: 'deepseek',
  groq: 'groq',
  cerebras: 'cerebras',
  mistral: 'mistral',
  xai: 'xai',
  together_ai: 'togetherai',
  fireworks_ai: 'fireworks-ai',
  deepinfra: 'deepinfra',
  moonshot: 'moonshotai',
};

/**
 * Aider redacts a model it cannot find in the LiteLLM price table down to
 * `provider/REDACTED`, so the prefix is often all there is. It is still the
 * provider, which is half of what the board keys on.
 */
export function providerFromModelId(id: string | null): string | null {
  if (!id) return null;
  const head = id.split('/')[0]!.toLowerCase();
  return PROVIDER_PREFIX[head] ?? null;
}

interface Ev {
  event: string;
  ts: number;                       // epoch ms
  uuid: string;                     // aider's install id, one per home directory
  props: Record<string, unknown>;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Aider stringifies every non-numeric property, so `None` arrives as "None". */
function str(v: unknown): string | null {
  return typeof v === 'string' && v && v !== 'None' ? v : null;
}

/**
 * One analytics line: `{event, properties, user_id, time}` with `time` in
 * epoch seconds. Flat properties are accepted too, because a format internal
 * to another tool is not a contract.
 */
function parseLine(line: string): Ev | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const event = str(o.event);
  if (!event) return null;
  const props = (o.properties && typeof o.properties === 'object' ? o.properties : o) as Record<string, unknown>;
  const raw = num(o.time ?? o.ts ?? o.timestamp);
  if (!raw) return null;
  const ts = raw < 1e11 ? raw * 1000 : raw;   // seconds, unless it is obviously already ms
  return { event, ts, uuid: str(o.user_id) ?? 'aider', props };
}

export function readAiderLog(path: string): Ev[] {
  if (!existsSync(path)) return [];
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out: Ev[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = parseLine(line);
    if (e) out.push(e);
  }
  // `time` is whole seconds, so ties are common; a stable sort keeps the file
  // order, which is the order the events happened in.
  return out.sort((a, b) => a.ts - b.ts);
}

export interface AiderRun {
  id: string;
  uuid: string;
  first_ts: number;
  last_ts: number;
  events: Ev[];
}

/**
 * Aider logs no session id, so a session has to be inferred. Three signals,
 * in order: it says `launched` when a run starts, it says `exit` when one
 * ends (unless it was killed), and a new install id is certainly a new
 * session. A half-hour of silence closes the gap the `exit` line would have
 * closed if the process had been allowed to write one.
 */
export function groupAiderRuns(events: Ev[]): AiderRun[] {
  const runs: AiderRun[] = [];
  let cur: AiderRun | null = null;
  let closed = false;
  let opening = false;   // the current run has seen only start events so far
  for (const e of events) {
    const starts = START_EVENTS.has(e.event);
    // A run announces itself twice — `launched`, then `cli session` a moment
    // later — so a second announcement inside the opening seconds joins the
    // run it is announcing rather than starting another.
    const boundary = !cur || closed || e.uuid !== cur.uuid ||
      e.ts - cur.last_ts > SESSION_GAP_MS ||
      (starts && !(opening && e.ts - cur.first_ts <= 60_000));
    if (boundary) {
      cur = { id: runId(e.uuid, e.ts), uuid: e.uuid, first_ts: e.ts, last_ts: e.ts, events: [e] };
      runs.push(cur);
      opening = starts;
    } else {
      cur!.events.push(e);
      cur!.last_ts = e.ts;
      opening = opening && starts;
    }
    closed = e.event === 'exit';
  }
  return runs;
}

/** Deterministic, so a second backfill adds nothing and changes nothing. */
function runId(uuid: string, firstTs: number): string {
  return `aider-${uuid.replace(/[^0-9a-z]/gi, '').slice(0, 12)}-${Math.floor(firstTs / 1000)}`;
}

export function aiderFacts(run: AiderRun): LedgerFacts {
  const f = emptyLedger();
  let sends = 0;
  for (const e of run.events) {
    if (e.event === SEND_FAILED) {
      // The exception text is in `properties.exception` and may quote the
      // prompt or a file. It is counted, never read. (docs/PRIVACY.md)
      f.api_errors++;
      continue;
    }
    if (e.event === 'exit') {
      // The only reasons aider writes are fixed strings from its own source.
      if (str(e.props.reason) === 'Control-C') f.interrupts++;
      continue;
    }
    if (e.event !== SEND_EVENT) continue;
    sends++;
    const p = e.props;
    f.tokens_in += num(p.prompt_tokens);
    f.tokens_out += num(p.completion_tokens);
    const model = str(p.main_model);
    if (model) f.model = model;
  }
  f.turns = sends;
  f.first_ts = new Date(run.first_ts).toISOString();
  f.last_ts = new Date(run.last_ts).toISOString();
  f.raw_model = f.model;
  f.raw_provider = providerFromModelId(f.model);
  // Aider never puts its version in the log: the version rides on the PostHog
  // super-properties, which the file writer does not see.
  return f;
}

/** The log aider is actually writing to: whatever the config says, else ours. */
export function aiderLogPath(confPath = AIDER_CONF): string {
  const declared = readConfKey(confPath, 'analytics-log');
  if (!declared) return AIDER_LOG;
  return declared.startsWith('~') ? join(homedir(), declared.slice(1)) : declared;
}

function readConfKey(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
    if (!m) continue;
    return m[1]!.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '') || null;
  }
  return null;
}

/**
 * Minimal YAML surgery. Aider's config is a flat map of its long option names
 * (configargparse with a YAML parser), so two lines are added or removed and
 * every other byte is left exactly as it was. The file is backed up first and
 * the lines carry a marker, so uninstall removes what install wrote and
 * nothing a person typed.
 *
 * `analytics-disable: true` also persists `permanently_disable` into
 * `~/.aider/analytics.json`, which uninstall cannot undo. That is a one-way
 * door in the direction of less telemetry, so it is the right way round, but
 * it is worth saying out loud.
 */
export function installAider(remove = false, confPath = AIDER_CONF, logPath = AIDER_LOG): string {
  const had = existsSync(confPath);
  const before = had ? readFileSync(confPath, 'utf8') : '';
  const kept = before.split('\n').filter((l) => !(l.includes(MARK) && /^(analytics-log|analytics-disable)\s*:/.test(l.trim())));
  // Never overwrite a log path the person chose for themselves.
  const theirs = kept.some((l) => /^analytics-log\s*:/.test(l.trim()));

  let lines = kept;
  if (!remove && !theirs) {
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    lines = [
      ...lines,
      `analytics-disable: true  ${MARK}`,
      `analytics-log: ${logPath}  ${MARK}`,
    ];
  }
  const after = lines.join('\n').replace(/\n*$/, '\n');
  if (!had && remove) return confPath;        // nothing of ours to take out
  if (after !== before) {
    if (had) copyFileSync(confPath, `${confPath}.bak-nerfd-${Date.now()}`);
    if (!remove) ensureHome();
    writeFileSync(confPath, after);
  }
  return confPath;
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

export const aiderAdapter: Adapter = {
  id: 'aider',
  label: 'Aider',
  // No hooks exist. Stated explicitly so `nerfd doctor` cannot imply otherwise.
  hookEvents: [],

  detect: () =>
    onPath('aider') ||
    existsSync(AIDER_CONF) ||
    existsSync(AIDER_DATA) ||
    existsSync(join(homedir(), '.aider.input.history')) ||
    existsSync(join(homedir(), '.aider.chat.history.md')),

  install: (remove = false) => [installAider(remove)],

  // Aider emits nothing live: no hook, no plugin, no socket. Anything claiming
  // to be an aider event is not one, so nothing is scored.
  normalise: (): NormalisedEvent | null => null,

  ledger(session: Session): LedgerFacts | null {
    const run = findRun(session.id);
    return run ? aiderFacts(run) : null;
  },

  backfill(sinceIso: string): Session[] {
    const since = Date.parse(sinceIso) || 0;
    const path = aiderLogPath();
    const out: Session[] = [];
    for (const run of groupAiderRuns(readAiderLog(path))) {
      if (run.last_ts < since) continue;
      const facts = aiderFacts(run);
      const s = backfillSession('aider', run.id, path, facts, {
        raw_model: facts.raw_model,
        raw_provider: facts.raw_provider,
        base_url: null,
        declared_name: null,
      });
      if (s) out.push(s);
    }
    return out;
  },
};

function findRun(id: string): AiderRun | null {
  return groupAiderRuns(readAiderLog(aiderLogPath())).find((r) => r.id === id) ?? null;
}

/**
 * Turns, as far as an analytics log can give them: one exchange per
 * `message_send`, from the timestamp and the token counts. The log holds no
 * text, no tool name and no path, and nothing here goes looking for any.
 */
export function aiderTurns(session: Session): AdapterTurn[] {
  const run = findRun(session.id);
  if (!run) return [];
  const turns: AdapterTurn[] = [];
  for (const e of run.events) {
    if (e.event !== SEND_EVENT) continue;
    const model = str(e.props.main_model) ?? undefined;
    // The line is written when the reply lands, so the prompt came first; the
    // moment it was typed is not recorded anywhere.
    turns.push({ role: 'user', ts: e.ts });
    turns.push({ role: 'assistant', ts: e.ts, model, output_tokens: num(e.props.completion_tokens) });
  }
  return turns;
}
