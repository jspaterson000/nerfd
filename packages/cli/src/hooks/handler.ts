import { execFileSync } from 'node:child_process';
import {
  AUTO_REVIEW_MODEL_RE, classifyPrompt, costUsd, emptyMetrics, emptyModelRef, emptyOutcome,
  emptySurvival, hashPath, hostedEquivalentUsd, inferSize, isAutomatedSession, priceSnapshotDate,
  registerModelDeclarations, resolveModelRef,
  type Session, type Tool,
} from '@nerfd/core';
import { adapterFor } from '../adapters/registry.ts';
import { attachSignals, isUnattendedSource } from '../adapters/types.ts';
import type { Adapter, HookInput, LedgerFacts, NormalisedEvent } from '../adapters/types.ts';
import { getSession, putSession, transact } from '../db.ts';
import { addedLineHashes, repoProfile } from '../git.ts';
import { loadDeclarations } from '../models.ts';
import { loadConfig, log, saveConfig, type Config } from '../paths.ts';
import { planStamp, refreshDetectionsIfStale } from '../plandetect/index.ts';
import { noteWallHit } from '../limits/store.ts';
import { publishSession } from '../publish.ts';
import { latencyPercentiles } from '../transcript.ts';

// The state machine is the same for every tool: the adapter turns the tool's
// own payload into a canonical event, and nothing below this line knows which
// tool it came from. A hook must never fail the host tool: errors are
// swallowed into the log and the process exits 0.

export type { HookInput } from '../adapters/types.ts';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit', 'write', 'str_replace_editor', 'create_file']);
const TEST_CMD_RE = /\b(pytest|jest|vitest|mocha|rspec|phpunit|cargo test|go test|swift test|xcodebuild test|npm test|pnpm test|yarn test|bun test|node --test|mix test|dotnet test|gradle test|mvn test|make test|tox|nose2)\b/;
// Quota is the subscription wall; overload is the provider's fleet being
// busy. Same worded tokens the adapters emit, so both keep matching.
const QUOTA_RE = /rate[ _-]?limit|429|too many requests|usage limit|hit your limit|(?<!context (window |length )?)limit reached|quota/i;
const OVERLOADED_RE = /overloaded|529|capacity|at capacity/i;
const TIMEOUT_RE = /timed? ?out|ETIMEDOUT/i;
const TOOL_ARG_ERROR_RE = /input.?validation|invalid (tool )?(input|argument|parameter|schema)|does not match the (required )?schema|failed to parse|unexpected token|is not valid json|required (property|parameter)|unrecognized (key|argument)|missing required/i;
const CONTEXT_LIMIT_RE = /context (window|length|limit)|prompt is too long|exceeds? the (maximum )?context|too many tokens/i;

const BINARIES: Partial<Record<Tool, string>> = {
  'claude-code': 'claude', codex: 'codex', opencode: 'opencode', gemini: 'gemini',
  qwen: 'qwen', kimi: 'kimi', goose: 'goose', crush: 'crush', cline: 'cline',
  aider: 'aider', copilot: 'copilot', droid: 'droid',
};

/** Only a plain semver. Anything else is a build string that can carry a path. */
export function toolVersion(tool: Tool): string | null {
  try {
    const bin = BINARIES[tool];
    if (!bin) return null;
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

function newSession(tool: Tool, input: HookInput, cfg: Config): Session {
  const cwd = input.cwd ?? process.cwd();
  // Declared beats detected beats nothing, decided once in plandetect. The
  // evidence behind a detected plan stays in config.json and is never stamped
  // onto a session: only the id and the word 'detected' are shared.
  const plan = planStamp(cfg, tool);
  return {
    id: input.session_id ?? `${tool}-${Date.now()}`,
    tool,
    tool_version: toolVersion(tool),
    model: input.model ?? null,
    model_ref: emptyModelRef(),
    effort: effortOf(input),
    plan_id: plan.plan_id,
    plan_usd_month: plan.plan_usd_month,
    plan_source: plan.plan_source,
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_s: null,
    cwd,
    repo: repoProfile(cwd),
    category: 'other',
    category_source: 'inferred',
    size: 's',
    first_prompt: null,
    metrics: emptyMetrics(),
    limit_windows: [],
    outcome: emptyOutcome(),
    survival: emptySurvival(),
    line_hashes: null,
    touched_files: [],
    transcript_path: input.transcript_path ?? null,
    shared_at: null,
    price_snapshot_date: priceSnapshotDate(),
    source: 'hook',
    // Settled at SessionEnd, once the prompt count and the signals are in.
    automated: false,
  };
}

/** Claude Code sends { effort: { level } }; keep whatever string we get. */
function effortOf(input: HookInput): string | null {
  const e = input.effort as unknown;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { level?: unknown }).level === 'string') return (e as { level: string }).level;
  return null;
}

/** Lines already dirty before the session started; subtracted at the end. */
function stashBaseline(s: Session): void {
  if (!s.cwd) return;
  s.line_hashes = addedLineHashes(s.cwd, loadConfig().install_id);
}

/**
 * At most once a day, and only at the start of a session, re-read the plan off
 * the tools' own config. Cheap, fail-safe, and it means a person who changes
 * their subscription does not have to tell nerfd twice.
 */
function refreshDetections(cfg: Config): void {
  try {
    if (refreshDetectionsIfStale(cfg)) saveConfig(cfg);
  } catch (e) {
    log(`plan detect: ${(e as Error).name}`);
  }
}

export async function handleHook(adapterId: string, rawInput: unknown): Promise<void> {
  const adapter = adapterFor(adapterId);
  if (!adapter) { log(`hook: unknown adapter ${String(adapterId).slice(0, 32)}`); return; }
  const event = adapter.normalise(rawInput);
  if (!event) return;                       // an event we do not score
  const id = event.session_id;
  if (!id) { log(`${adapter.id} ${event.hook_event_name}: no session_id`); return; }

  const cfg = loadConfig();
  if (event.hook_event_name === 'SessionStart') refreshDetections(cfg);

  // Every hook delivery is a read-modify-write of one row, and several of them
  // arrive at once: Claude Code runs hooks with async:true, and OpenCode's
  // plugin fires tool and message events in parallel. Without a lock held
  // across the read and the write, the last writer wins and its sibling's
  // increment is lost. BEGIN IMMEDIATE serialises the deliveries instead.
  //
  // Building a session shells out to git and `<tool> --version`, so it happens
  // before the lock is taken and is thrown away if a sibling got there first.
  const fresh = getSession(id) ? null : newSession(adapter.id, event, cfg);
  if (fresh && event.hook_event_name === 'SessionStart') stashBaseline(fresh);

  const ended = transact(() => {
    const s = getSession(id) ?? fresh ?? newSession(adapter.id, event, cfg);
    if (event.transcript_path && !s.transcript_path) s.transcript_path = event.transcript_path;
    const effort = effortOf(event);
    if (effort) s.effort = effort;

    apply(s, event);
    if (event.hook_event_name === 'SessionEnd') finalise(s, adapter);
    putSession(s);
    return event.hook_event_name === 'SessionEnd' ? s : null;
  });

  // Autonomous reporting, outside the transaction: only when the person turned
  // it on; only the redacted record; and never with the write lock held, so a
  // slow network cannot stall the next hook.
  if (ended && cfg.share === 'auto') {
    const r = await publishSession(ended, cfg);
    if (!r.ok) log(`auto-share: ${r.reason}`);
  }
}

function apply(s: Session, event: NormalisedEvent): void {
  switch (event.hook_event_name) {
    case 'SessionStart': {
      if (event.model) s.model = event.model;
      if (s.line_hashes == null) stashBaseline(s);
      break;
    }
    case 'UserPromptSubmit': {
      s.metrics.prompts++;
      if (s.category_source === 'inferred' && s.metrics.prompts === 1 && typeof event.prompt === 'string') {
        // Classify, then discard. The prompt itself is only kept when the
        // person explicitly asks for it, for their own debugging.
        s.category = classifyPrompt(event.prompt);
        if (process.env.NERFD_KEEP_PROMPTS === '1') s.first_prompt = event.prompt.slice(0, 300);
      }
      break;
    }
    case 'PostToolUse': {
      s.metrics.tool_calls++;
      const name = event.tool_name ?? '';
      const ti = event.tool_input ?? {};
      if (EDIT_TOOLS.has(name)) {
        s.metrics.edits++;
        const fp = String(ti.file_path ?? ti.path ?? ti.notebook_path ?? '');
        if (fp) {
          const h = hashPath(fp);
          if (!s.touched_files.includes(h)) s.touched_files.push(h);
          s.metrics.files_touched = s.touched_files.length;
        }
      }
      const cmd = String(ti.command ?? ti.cmd ?? '');
      if ((name === 'Bash' || name === 'exec' || name === 'shell' || name === 'exec_command') && TEST_CMD_RE.test(cmd)) s.metrics.tests_run++;
      break;
    }
    case 'PostToolUseFailure': {
      s.metrics.errors++;
      const text = JSON.stringify(event.error ?? event.tool_response ?? '');
      if (QUOTA_RE.test(text)) s.metrics.rate_limit_hits++;
      if (OVERLOADED_RE.test(text)) s.metrics.overloaded++;
      if (TIMEOUT_RE.test(text)) s.metrics.timeouts++;
      if (TOOL_ARG_ERROR_RE.test(text)) s.metrics.tool_call_errors++;
      if (CONTEXT_LIMIT_RE.test(text)) s.metrics.context_limit_hits++;
      break;
    }
    case 'PostModelSwitch': {
      s.metrics.model_switches++;
      if (typeof event.to_model === 'string') s.model = event.to_model;
      break;
    }
    case 'Interrupt': {
      // The user hit escape. The AMD study found this 12x on degraded weeks.
      s.metrics.interrupts++;
      break;
    }
    case 'StopFailure': {
      // The model failed to finish a turn. error_type is the most reliable
      // capacity signal we get without touching a transcript.
      s.metrics.errors++;
      const kind = String(event.error_type ?? '') + ' ' + JSON.stringify(event.error ?? '');
      // A 529 is not the wall: the fleet was busy, the quota was not spent.
      if (OVERLOADED_RE.test(kind)) s.metrics.overloaded++;
      if (QUOTA_RE.test(kind)) {
        s.metrics.rate_limit_hits++;
        // The wall, as Claude Code saw it. Noted beside the status-line
        // samples so the ledger can stamp it onto the window at session end,
        // in a later process than this one. Every other tool reports the wall
        // in its own transcript, which the ledger reads directly.
        if (s.tool === 'claude-code') noteWallHit(s.id);
      }
      if (TIMEOUT_RE.test(kind)) s.metrics.timeouts++;
      if (CONTEXT_LIMIT_RE.test(kind)) s.metrics.context_limit_hits++;
      break;
    }
    case 'Stop':
    case 'SessionEnd':
      break;
  }
}

/** Called once at SessionEnd. Idempotent: safe to run again from `nerfd show --refresh`. */
export function finalise(s: Session, adapter: Adapter | null = adapterFor(s.tool)): void {
  const now = new Date().toISOString();
  s.ended_at = now;
  s.duration_s = Math.max(0, Math.round((Date.parse(now) - Date.parse(s.started_at)) / 1000));

  let facts: LedgerFacts | null = null;
  try {
    facts = adapter?.ledger(s) ?? null;
  } catch (e) {
    log(`finalise ledger: ${(e as Error).name}`);
  }
  if (facts) mergeLedger(s, facts);

  // Behavioural signals, where the adapter can reconstruct the conversation.
  // The turns hold prompt text; `attachSignals` reduces them to counts and
  // nothing else survives this block. Errors cost the signals, not the
  // session, and only the error's name is logged.
  try {
    const turns = adapter?.turns?.(s) ?? [];
    attachSignals(s, turns, (name) => log(`finalise signals: ${name}`));
  } catch (e) {
    log(`finalise signals: ${(e as Error).name}`);
  }

  try {
    if (s.cwd) {
      const before = new Set(s.line_hashes ?? []);
      const after = addedLineHashes(s.cwd, loadConfig().install_id);
      const added = after.filter((h) => !before.has(h));
      s.line_hashes = added;
      s.survival.lines_added = added.length;
      if (added.length === 0) s.outcome.kept = s.outcome.kept === 'unknown' ? 'na' : s.outcome.kept;
    }
  } catch (e) {
    log(`finalise git: ${(e as Error).name}`);
  }

  s.size = inferSize(s.duration_s, s.metrics.tool_calls, s.metrics.edits);
  resolveModel(s, facts);
  // Decided last, because it reads both the hook's prompt count and the user
  // turns the signals just produced. A model id a tool reserves for its own
  // unattended reviewer settles it on its own.
  s.automated = isAutomatedSession(s)
    || AUTO_REVIEW_MODEL_RE.test(s.model ?? '')
    || isUnattendedSource(facts?.meta_source);
}

function mergeLedger(s: Session, facts: LedgerFacts): void {
  if (facts.model && !s.model) s.model = facts.model;
  if (!s.tool_version && /^\d+\.\d+\.\d+$/.test(facts.tool_version ?? '')) s.tool_version = facts.tool_version;
  s.metrics.turns = Math.max(s.metrics.turns, facts.turns);
  s.metrics.tokens_in = facts.tokens_in;
  s.metrics.tokens_out = facts.tokens_out;
  s.metrics.tokens_cache_read = facts.tokens_cache_read;
  s.metrics.errors += facts.api_errors;
  s.metrics.rate_limit_hits += facts.rate_limit_hits;
  s.metrics.timeouts += facts.timeouts;
  s.metrics.interrupts = Math.max(s.metrics.interrupts, facts.interrupts);
  s.metrics.tool_call_errors = Math.max(s.metrics.tool_call_errors, facts.tool_call_errors);
  s.metrics.context_limit_hits = Math.max(s.metrics.context_limit_hits, facts.context_limit_hits);
  if (facts.rate_limit_used_pct != null) s.metrics.limit_used_pct = facts.rate_limit_used_pct;
  if (facts.rate_limit_window_min != null) s.metrics.limit_window_min = facts.rate_limit_window_min;
  // How much of each subscription window this session consumed. The ledger
  // is the only source: a window is per-account state, not per-event.
  if (facts.limit_windows.length) s.limit_windows = facts.limit_windows;
  if (s.limit_windows?.some((w) => w.wall_hit)) s.metrics.rate_limit_hits = Math.max(s.metrics.rate_limit_hits, 1);
  const lat = latencyPercentiles(facts.latencies_ms);
  s.metrics.latency_p50_ms = lat.p50;
  s.metrics.latency_p95_ms = lat.p95;
  if (facts.first_ts && facts.last_ts) {
    const span = Math.round((Date.parse(facts.last_ts) - Date.parse(facts.first_ts)) / 1000);
    if (span > 0) s.duration_s = Math.max(s.duration_s ?? 0, span);
  }
}

/**
 * Model identity and price, resolved at session end against the snapshot that
 * shipped with this client, so a later price change never rewrites history.
 */
export function resolveModel(s: Session, facts: LedgerFacts | null = null): void {
  try {
    registerModelDeclarations(loadDeclarations());
    s.model_ref = resolveModelRef(s.model ?? facts?.raw_model ?? null, facts?.raw_provider ?? null, {
      baseUrl: facts?.base_url ?? undefined,
      declaredName: facts?.declared_name ?? undefined,
    });
    if (!s.model && s.model_ref.raw_id) s.model = s.model_ref.raw_id;
    s.price_snapshot_date = priceSnapshotDate();
    // Priced here only so a failure is logged once, at capture, rather than
    // silently every time the board is rendered.
    void costUsd(s.model_ref, s.metrics);
    void hostedEquivalentUsd(s.model_ref, s.metrics);
  } catch (e) {
    log(`resolve model: ${(e as Error).name}`);
  }
}
