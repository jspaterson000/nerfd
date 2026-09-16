import {
  AUTO_REVIEW_MODEL_RE, classifyPrompt, emptyMetrics, emptyOutcome, emptySurvival, inferSize,
  priceSnapshotDate, resolveModelRef, type Session, type Tool,
} from '@nerfd/core';
import type { TranscriptFacts } from '../transcript.ts';
import { latencyPercentiles } from '../transcript.ts';

/**
 * A session reconstructed from a tool's own store, for history that predates
 * the install. Backfill matters: a new user gets a populated scorecard the
 * minute they install, and the public board gets months of open-model history
 * on day one.
 *
 * What a transcript cannot give us is marked as such rather than guessed: no
 * repo profile, no survival (the working tree moved on long ago), no prompt
 * counts beyond what the turns imply.
 */
export function backfillSession(
  tool: Tool,
  sessionId: string,
  path: string,
  facts: TranscriptFacts,
  ids: { raw_model: string | null; raw_provider: string | null; base_url: string | null; declared_name: string | null },
): Session | null {
  if (!facts.first_ts || !facts.last_ts) return null;
  if (facts.turns === 0) return null; // opened and closed; nothing happened

  const duration = Math.max(0, Math.round((Date.parse(facts.last_ts) - Date.parse(facts.first_ts)) / 1000));
  const lat = latencyPercentiles(facts.latencies_ms);
  const metrics = {
    ...emptyMetrics(),
    turns: facts.turns,
    tokens_in: facts.tokens_in,
    tokens_out: facts.tokens_out,
    tokens_cache_read: facts.tokens_cache_read,
    errors: facts.api_errors,
    rate_limit_hits: facts.rate_limit_hits,
    overloaded: facts.overloaded,
    timeouts: facts.timeouts,
    interrupts: facts.interrupts,
    tool_call_errors: facts.tool_call_errors,
    context_limit_hits: facts.context_limit_hits,
    latency_p50_ms: lat.p50,
    latency_p95_ms: lat.p95,
    limit_used_pct: facts.rate_limit_used_pct,
    limit_window_min: facts.rate_limit_window_min,
  };

  return {
    id: sessionId,
    tool,
    tool_version: /^\d+\.\d+\.\d+$/.test(facts.tool_version ?? '') ? facts.tool_version : null,
    model: ids.raw_model,
    model_ref: resolveModelRef(ids.raw_model, ids.raw_provider, {
      baseUrl: ids.base_url ?? undefined,
      declaredName: ids.declared_name ?? undefined,
    }),
    effort: null,
    plan_id: null,
    plan_usd_month: null,
    // History predates the install, so which plan was in force at the time is
    // not knowable. Guessing today's plan would misprice months of sessions.
    plan_source: 'unknown',
    started_at: facts.first_ts,
    ended_at: facts.last_ts,
    duration_s: duration,
    cwd: null,
    repo: { lang: 'none', size: 's', age: 'unknown' },
    category: classifyPrompt(null),
    category_source: 'inferred',
    size: inferSize(duration, 0, 0),
    first_prompt: null,
    metrics,
    outcome: emptyOutcome(),
    survival: emptySurvival(),
    line_hashes: null,
    touched_files: [],
    transcript_path: path,
    shared_at: null,
    price_snapshot_date: priceSnapshotDate(),
    source: 'backfill',
    // A transcript has no prompt counter, so this is provisional: every
    // backfill path calls `attachSignals` next, and that settles it from the
    // user turns. Only a model id reserved for an unattended reviewer is
    // decided here, because no turn count can overturn it.
    automated: AUTO_REVIEW_MODEL_RE.test(ids.raw_model ?? ''),
  };
}
