// Shared record shapes. Everything the CLI stores locally and the server
// accepts publicly is defined here so the two can never drift apart.

import type { ModelRef } from './modelref.ts';
import type { Signals } from './signals.ts';

export const TOOLS = [
  'claude-code', 'codex', 'opencode', 'gemini', 'qwen', 'kimi', 'goose',
  'crush', 'cline', 'aider', 'copilot', 'droid', 'other',
] as const;
export type Tool = (typeof TOOLS)[number];

// Deliberately small. Categories are what people actually route on.
export const CATEGORIES = [
  'code',      // implement a feature / write new code
  'debug',     // find and fix a bug
  'refactor',  // restructure without behaviour change
  'review',    // review / audit / explain existing code
  'ux',        // UI, layout, styling, design
  'strategy',  // planning, architecture, product / business thinking
  'writing',   // docs, copy, prose
  'research',  // find out how something works, compare options
  'ops',       // infra, CI, deploy, shell wrangling
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SIZES = ['s', 'm', 'l'] as const;
export type Size = (typeof SIZES)[number];

export const KEPT = ['unknown', 'kept', 'partial', 'reverted', 'na'] as const;
export type Kept = (typeof KEPT)[number];

export const REPO_AGE = ['greenfield', 'established', 'unknown'] as const;
export type RepoAge = (typeof REPO_AGE)[number];

// Where the subscription plan on a session came from. A plan the person typed
// beats one read off this machine's tool config, which beats nothing. Only
// the id and this word are ever published; the file and field a detector read
// stay local. See docs/PLAN-DETECTION.md.
export const PLAN_SOURCES = ['detected', 'declared', 'unknown'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

/** Facts about the repo that affect how hard the task is. No identifying info. */
export interface RepoProfile {
  lang: string;        // 'ts' | 'py' | 'go' | 'rs' | 'swift' | 'mixed' | 'none' ...
  size: Size;          // by tracked file count
  age: RepoAge;
}

/** Objective, automatically collected. Nobody has to type these. */
export interface Metrics {
  prompts: number;          // human prompts submitted
  turns: number;            // assistant messages
  tool_calls: number;
  edits: number;            // file edit / write tool calls
  files_touched: number;
  tests_run: number;        // test-looking shell commands
  errors: number;           // tool errors + API errors
  rate_limit_hits: number;  // 429 / overloaded / "rate limit" seen
  timeouts: number;
  model_switches: number;   // user switched model mid-session (a strong "this was not working" signal)
  tool_call_errors: number; // tool calls whose arguments failed to parse or validate: the metric that differs most between hosts of the same weights
  context_limit_hits: number; // compaction or a context-length error. hosts differ by 14x on output limits
  interrupts: number;       // user hit escape mid-response; the AMD study found this 12x on degraded weeks
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  latency_p50_ms: number | null;  // model response latency after a prompt or tool result
  latency_p95_ms: number | null;
  limit_used_pct: number | null;   // subscription window used at session end, where the tool reports it (codex does)
  limit_window_min: number | null; // length of that window in minutes
}

/** What the human said afterwards. Optional, but this is where quality lives. */
export interface Outcome {
  rating: number | null;  // 1..5
  kept: Kept;
  note: string | null;    // local-only unless explicitly shared
  rated_at: string | null;
}

/** Did the code survive? Computed from git, not opinion. */
export interface Survival {
  lines_added: number;        // lines this session added (working tree delta)
  lines_surviving: number | null;
  ratio: number | null;       // surviving / added
  checked_at: string | null;
}

/** Full local record. Never leaves the machine as-is. */
export interface Session {
  id: string;
  tool: Tool;
  tool_version: string | null;
  model: string | null;
  model_ref: ModelRef;               // model plus provider plus quantisation: see modelref.ts
  effort: string | null;             // reasoning effort level if the tool reports it (harness changes hide here)
  plan_id: string | null;            // subscription plan snapshot at session start, see plans.ts
  plan_usd_month: number | null;
  plan_source: PlanSource;           // declared by the person, detected from the tool's own config, or neither
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  cwd: string | null;                // local only
  repo: RepoProfile;
  category: Category;
  category_source: 'inferred' | 'user';
  size: Size;                        // task size, inferred from effort then user-overridable
  first_prompt: string | null;       // local only, and only when NERFD_KEEP_PROMPTS=1
  metrics: Metrics;
  // Behavioural signals: how much the human had to fight the model, computed
  // locally from the transcript at session end. Counts, booleans and nulls
  // only - there is no string anywhere in `Signals` - so they are safe to
  // publish as-is. Optional because records written before the signals module
  // (and adapters that cannot produce turns) simply have none.
  signals?: Signals | null;
  signal_version?: number | null;   // which version of the detectors produced them
  outcome: Outcome;
  survival: Survival;
  line_hashes: string[] | null;      // local only, used by `nerfd check`
  touched_files: string[];           // local only, hashed: counts are the signal, paths are not
  transcript_path: string | null;    // local only
  shared_at: string | null;
  price_snapshot_date: string | null; // the models.dev snapshot this session was priced against
  source?: 'hook' | 'record' | 'backfill'; // local only: how the session got here
}

/** The redacted record that is sent to the public server. */
export interface Report {
  report_id: string;
  reporter_id: string;      // hash of a random per-install id, never an identity
  client_version: string;
  tool: Tool;
  tool_version: string | null;
  model: string;
  model_ref: ModelRef;
  effort: string | null;
  plan_id: string | null;
  plan_usd_month: number | null;
  plan_source: PlanSource;
  week: string;             // ISO week, e.g. 2026-W38
  ended_at: string;
  category: Category;
  size: Size;
  repo: RepoProfile;
  duration_s: number;
  metrics: Metrics;
  signals?: Signals | null;         // counts only; see signals.ts
  signal_version?: number | null;
  rating: number | null;
  kept: Kept;
  survival_ratio: number | null;
  evidence_url: string | null;  // optional public gist / PR link the user attached
}

export function emptyMetrics(): Metrics {
  return {
    prompts: 0, turns: 0, tool_calls: 0, edits: 0, files_touched: 0, tests_run: 0,
    errors: 0, rate_limit_hits: 0, timeouts: 0, model_switches: 0, interrupts: 0,
    tool_call_errors: 0, context_limit_hits: 0, tokens_in: 0, tokens_out: 0,
    tokens_cache_read: 0, latency_p50_ms: null, latency_p95_ms: null, limit_used_pct: null, limit_window_min: null,
  };
}

export function emptyOutcome(): Outcome {
  return { rating: null, kept: 'unknown', note: null, rated_at: null };
}

export function emptySurvival(): Survival {
  return { lines_added: 0, lines_surviving: null, ratio: null, checked_at: null };
}
