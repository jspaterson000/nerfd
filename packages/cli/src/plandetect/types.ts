// Shared vocabulary for plan detection.
//
// Detection answers one question per tool: "which subscription plan id from
// packages/core/src/plans.ts is this machine on?" It answers it by opening a
// file the tool already wrote and reading ONE named, non-secret enum field.
//
// The rules every detector in this directory obeys, enforced by read.ts:
//
//   1. A detector may open a credentials or config file only to extract one
//      named field whose value is a plan/tier/type enum.
//   2. The value must match a short-token shape AND be in a known enum set.
//      Anything else is discarded without being returned, logged or stored.
//      A token, key, email, account id or org name cannot survive that test,
//      so a mis-specified field path cannot leak one.
//   3. Raw file contents are never returned, written, logged or retained.
//      read.ts holds the parsed object inside one function call and drops it.
//   4. Every result records WHICH file and WHICH field it read, in `evidence`,
//      so `nerfd privacy` can show the user exactly what was opened.
//   5. Nothing here ever throws. Every read is wrapped; failure is `unknown`.
//   6. The macOS keychain is never touched. Invoking `security` raises a
//      system prompt, which is a worse privacy event than the one it solves.
//
// Only `plan_id` and `plan_source` ever leave the machine. `evidence` and
// `confidence` are local-only display fields.

import type { Tool } from '@nerfd/core';

/** What a detector returns. Only `plan_id` is ever published, with the word
 * `detected`, `assumed` or `declared` beside it. Everything else here -
 * evidence, confidence, and the two dates - is local. */
export interface Detection {
  plan_id: string | null;
  source: 'detected' | 'unknown';
  /** "<file> <dotted.field>" - the only record of what was opened. Local only. */
  evidence: string | null;
  confidence: 'high' | 'medium' | 'low';
  /**
   * When this subscription started and, where the tool says so, when it runs
   * out: an ISO timestamp each, and the only non-enum values any detector
   * reads. They exist so imported history can be priced - a session that ended
   * inside this window was on this plan - and they never leave the machine.
   * Null where the tool writes nothing, and `active_until` is null for an
   * open-ended subscription, which means "still running".
   */
  active_from?: string | null;
  active_until?: string | null;
}

export interface DetectOpts {
  /** Home directory to resolve tool config paths against. Tests point this at fixtures. */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedOpts {
  home: string;
  env: NodeJS.ProcessEnv;
}

/** A detector is a pure function of (home, env) -> Detection. It never throws. */
export type Detector = (opts: ResolvedOpts) => Detection;

export const UNKNOWN: Detection = Object.freeze({
  plan_id: null,
  source: 'unknown',
  evidence: null,
  confidence: 'low',
});

export function unknown(evidence?: string): Detection {
  return { plan_id: null, source: 'unknown', evidence: evidence ?? null, confidence: 'low' };
}

export function detected(
  plan_id: string,
  evidence: string,
  confidence: 'high' | 'medium' | 'low',
): Detection {
  return { plan_id, source: 'detected', evidence, confidence };
}

/**
 * The tools this module can detect a plan for. A superset of the ones with
 * adapters, because a plan can be known before a hook ever runs.
 */
export const DETECTABLE: readonly Tool[] = [
  'claude-code', 'codex', 'kimi', 'gemini', 'opencode', 'copilot', 'qwen', 'goose', 'crush', 'droid',
] as const;

const ALIASES: Record<string, Tool> = {
  claude: 'claude-code', 'claude-code': 'claude-code', claudecode: 'claude-code', anthropic: 'claude-code',
  codex: 'codex', openai: 'codex', chatgpt: 'codex',
  kimi: 'kimi', 'kimi-code': 'kimi', moonshot: 'kimi',
  gemini: 'gemini', 'gemini-cli': 'gemini', google: 'gemini',
  opencode: 'opencode',
  copilot: 'copilot', 'github-copilot': 'copilot',
  qwen: 'qwen', 'qwen-code': 'qwen',
  goose: 'goose',
  crush: 'crush',
  droid: 'droid', factory: 'droid',
};

/** Loose tool name -> canonical Tool. Returns null for anything unrecognised. */
export function normaliseTool(tool: string | null | undefined): Tool | null {
  if (!tool) return null;
  return ALIASES[tool.trim().toLowerCase()] ?? null;
}
