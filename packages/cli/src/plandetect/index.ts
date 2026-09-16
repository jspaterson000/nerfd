// Subscription-plan auto-detection.
//
//   detectPlan('claude')  -> { plan_id, source, evidence, confidence }
//   detectAllPlans()      -> one of those per detectable tool
//
// Both are pure functions of a home directory and an environment, so the tests
// point them at fixtures instead of a real machine. Neither ever throws: a
// detector that fails for any reason returns `unknown`.
//
// See ./types.ts for the privacy rules every detector obeys and ./read.ts for
// the two gates that enforce them. docs/PLAN-DETECTION.md has the sources.

import { planById, type PlanSource, type Tool } from '@nerfd/core';
import { resolveOpts } from './read.ts';
import { DETECTABLE, normaliseTool, unknown, type Detection, type DetectOpts, type Detector } from './types.ts';
import { detectClaude } from './claude.ts';
import { detectCodex } from './codex.ts';
import { detectKimi } from './kimi.ts';
import { detectGemini } from './gemini.ts';
import { detectOpencode } from './opencode.ts';
import { detectCopilot } from './copilot.ts';
import { detectQwen, detectGoose, detectCrush, detectDroid } from './misc.ts';

export type { Detection, DetectOpts } from './types.ts';
export { DETECTABLE, normaliseTool } from './types.ts';

/**
 * Why a tool cannot be detected past a certain point, in one line each, so
 * `nerfd plan` can say so instead of showing a silent blank. Full reasoning and
 * sources are in docs/PLAN-DETECTION.md.
 */
export const WHY_NOT: Partial<Record<Tool, string>> = {
  'claude-code': 'on macOS the tier is in the login keychain, which nerfd will not open (it prompts); "max" does not say 5x or 20x',
  kimi: 'the membership tier is not stored on disk; reading it means sending a bearer token to Moonshot',
  gemini: 'the Code Assist tier is fetched live and never cached; only the auth method is on disk',
  copilot: 'copilot_plan comes from the GitHub API, not from ~/.copilot',
  qwen: 'oauth_creds.json holds tokens only; the free tier was never a field',
  crush: 'no tier field in the local config',
  droid: 'Factory plans are enforced server-side and not cached locally',
  goose: 'Goose has no subscription: the plan is api, or local when the provider is',
};

const DETECTORS: Partial<Record<Tool, Detector>> = {
  'claude-code': detectClaude,
  codex: detectCodex,
  kimi: detectKimi,
  gemini: detectGemini,
  opencode: detectOpencode,
  copilot: detectCopilot,
  qwen: detectQwen,
  goose: detectGoose,
  crush: detectCrush,
  droid: detectDroid,
};

/**
 * Detect the subscription plan for one tool. `tool` accepts the loose names
 * the CLI already takes ('claude', 'claude-code', 'codex', ...).
 *
 * Returns `{ plan_id: null, source: 'unknown' }` when the tool is unknown, is
 * not installed, or records nothing that identifies a plan. That is a normal
 * outcome, not an error - a declared plan covers it.
 */
export function detectPlan(tool: string, opts?: DetectOpts): Detection {
  try {
    const id = normaliseTool(tool);
    if (!id) return unknown();
    const fn = DETECTORS[id];
    if (!fn) return unknown();
    const out = fn(resolveOpts(opts));
    return sane(out);
  } catch {
    // A detector must never take the CLI down with it.
    return unknown();
  }
}

/** Every detectable tool, in one pass. Tools with nothing to go on are omitted. */
export function detectAllPlans(opts?: DetectOpts): Partial<Record<Tool, Detection>> {
  const resolved = resolveOpts(opts);
  const out: Partial<Record<Tool, Detection>> = {};
  for (const tool of DETECTABLE) {
    const fn = DETECTORS[tool];
    if (!fn) continue;
    let d: Detection;
    try { d = sane(fn(resolved)); } catch { continue; }
    if (d.source === 'detected' || d.evidence) out[tool] = d;
  }
  return out;
}

/**
 * Last line of defence. A detector should never build a Detection by hand that
 * violates the contract, but if one does, this is what the rest of the CLI
 * sees: a plan id that is a short enum token, or nothing.
 */
function sane(d: Detection): Detection {
  const id = typeof d.plan_id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(d.plan_id) ? d.plan_id : null;
  const confidence = d.confidence === 'high' || d.confidence === 'medium' ? d.confidence : 'low';
  const evidence = typeof d.evidence === 'string' && d.evidence.length <= 200 ? d.evidence : null;
  return id ? { plan_id: id, source: 'detected', evidence, confidence } : { plan_id: null, source: 'unknown', evidence, confidence: 'low' };
}

// ---------------------------------------------------------------------------
// Config storage.
//
// paths.ts is not ours to edit, so the extra key is added by widening the type
// here. `detected_plans` holds the last sweep and when it ran; detection is
// re-run at most once a day because these files change when a human changes a
// subscription, which is not an hourly event.
// ---------------------------------------------------------------------------

import type { Config } from '../paths.ts';

export interface DetectedPlans {
  checked_at: string;                          // ISO timestamp of the last sweep
  plans: Partial<Record<Tool, Detection>>;
}

/** paths.ts Config plus the key this module owns. */
export type ConfigWithDetections = Config & { detected_plans?: DetectedPlans };

export const DETECT_TTL_MS = 24 * 60 * 60 * 1000;

/** Widening cast, kept in one place so nothing else has to know about it. */
export function withDetections(cfg: Config): ConfigWithDetections {
  return cfg as ConfigWithDetections;
}

/** true when there is no sweep on record, or the last one is over a day old. */
export function detectionsStale(cfg: Config, now = Date.now()): boolean {
  const d = withDetections(cfg).detected_plans;
  if (!d || typeof d.checked_at !== 'string') return true;
  const at = Date.parse(d.checked_at);
  return !Number.isFinite(at) || now - at >= DETECT_TTL_MS || at > now + 60_000;
}

/** Run a sweep and write it into the config object. Caller saves. */
export function refreshDetections(cfg: Config, opts?: DetectOpts, now = new Date()): ConfigWithDetections {
  const c = withDetections(cfg);
  c.detected_plans = { checked_at: now.toISOString(), plans: detectAllPlans(opts) };
  return c;
}

/** Run a sweep only if the stored one is stale. Returns true if it ran. */
export function refreshDetectionsIfStale(cfg: Config, opts?: DetectOpts, now = new Date()): boolean {
  if (!detectionsStale(cfg, now.getTime())) return false;
  refreshDetections(cfg, opts, now);
  return true;
}

/**
 * A plan the person typed. `source: 'declared'` is stored next to it so that a
 * plan set by hand is never mistaken for one that was read off disk, and so it
 * survives a detection sweep that would otherwise look authoritative.
 */
export interface DeclaredPlan {
  id: string;
  name: string;
  usd_month: number | null;
  source: 'declared';
}

/** Record a plan the person declared. The cast is the widening paths.ts cannot do. */
export function declarePlan(cfg: Config, tool: Tool, p: { id: string; name: string; usd_month: number | null }): void {
  (cfg.plans as Record<string, DeclaredPlan>)[tool] = { ...p, source: 'declared' };
}

export interface EffectivePlan {
  plan_id: string | null;
  plan_source: PlanSource;
  /** Local display only. Never sent. */
  evidence: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
}

/**
 * The precedence rule, in one place: what a person declared beats what was
 * detected, and detected beats nothing. Only `plan_id` and `plan_source` are
 * ever stamped onto a session and shared.
 */
export function effectivePlan(cfg: Config, tool: Tool): EffectivePlan {
  const c = withDetections(cfg);
  const declared = c.plans[tool] ?? c.plans.other;
  if (declared?.id) {
    return { plan_id: declared.id, plan_source: 'declared', evidence: null, confidence: null };
  }
  const found = c.detected_plans?.plans?.[tool];
  if (found?.plan_id) {
    return { plan_id: found.plan_id, plan_source: 'detected', evidence: found.evidence, confidence: found.confidence };
  }
  return { plan_id: null, plan_source: 'unknown', evidence: found?.evidence ?? null, confidence: null };
}

/**
 * What gets stamped onto a session: the effective plan id, its price, and
 * where it came from. The price follows the same precedence - a declared plan
 * carries whatever the person typed (including a free-typed dollar amount,
 * which `toReport` drops), a detected one is priced from the published table.
 */
export function planStamp(cfg: Config, tool: Tool): { plan_id: string | null; plan_usd_month: number | null; plan_source: PlanSource } {
  const e = effectivePlan(cfg, tool);
  const declared = cfg.plans[tool] ?? cfg.plans.other;
  const usd = e.plan_source === 'declared' ? (declared?.usd_month ?? null) : (planById(e.plan_id)?.usd_month ?? null);
  return { plan_id: e.plan_id, plan_usd_month: usd, plan_source: e.plan_source };
}
