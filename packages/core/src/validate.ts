import { SERVING_MODES } from './modelref.ts';
import { CATEGORIES, KEPT, LIMIT_SCOPES, PLAN_SOURCES, REPO_AGE, SIZES, TOOLS, type Report } from './types.ts';

// A hand-written validator keeps the server dependency-free and makes the
// accepted shape explicit. Returns an error string or null.
export function validateReport(x: unknown): string | null {
  if (!x || typeof x !== 'object') return 'not an object';
  const r = x as Record<string, unknown>;
  const str = (k: string, opt = false) => {
    const v = r[k];
    if (v == null) return opt ? null : `${k} missing`;
    return typeof v === 'string' && v.length < 512 ? null : `${k} invalid`;
  };
  const num = (k: string, lo: number, hi: number, opt = false) => {
    const v = r[k];
    if (v == null) return opt ? null : `${k} missing`;
    return typeof v === 'number' && v >= lo && v <= hi ? null : `${k} out of range`;
  };
  const oneOf = (k: string, list: readonly string[]) =>
    list.includes(r[k] as string) ? null : `${k} must be one of ${list.join(',')}`;

  const checks = [
    str('report_id'), str('reporter_id'), str('client_version'), str('model'),
    str('tool_version', true), str('effort', true), str('plan_id', true), str('week'), str('ended_at'), str('evidence_url', true),
    oneOf('tool', TOOLS), oneOf('category', CATEGORIES), oneOf('size', SIZES), oneOf('kept', KEPT),
    num('duration_s', 0, 7 * 86400), num('plan_usd_month', 0, 100000, true), num('rating', 1, 5, true), num('survival_ratio', 0, 1, true),
  ];
  for (const c of checks) if (c) return c;

  // Added with plan auto-detection; a client that predates it sends nothing here.
  if (r.plan_source != null && !PLAN_SOURCES.includes(r.plan_source as never)) return `plan_source must be one of ${PLAN_SOURCES.join(',')}`;

  // Added with the automated-session split; a client that predates it sends
  // nothing here and its record is still valid, defaulting to "steered".
  if (r.automated != null && typeof r.automated !== 'boolean') return 'automated invalid';

  if (!/^\d{4}-W\d{2}$/.test(r.week as string)) return 'week format';
  if (Number.isNaN(Date.parse(r.ended_at as string))) return 'ended_at not a date';
  if (r.evidence_url && !/^https:\/\/(gist\.github\.com|github\.com)\//.test(r.evidence_url as string)) return 'evidence_url must be a github/gist link';

  const repo = r.repo as Record<string, unknown> | undefined;
  if (!repo || typeof repo.lang !== 'string' || !SIZES.includes(repo.size as never) || !REPO_AGE.includes(repo.age as never)) return 'repo invalid';

  const m = r.metrics as Record<string, unknown> | undefined;
  if (!m) return 'metrics missing';
  for (const k of ['prompts','turns','tool_calls','edits','files_touched','tests_run','errors','rate_limit_hits','timeouts','model_switches','interrupts','tokens_in','tokens_out','tokens_cache_read']) {
    const v = m[k];
    if (typeof v !== 'number' || v < 0 || v > 1e9) return `metrics.${k} invalid`;
  }
  for (const k of ['latency_p50_ms','latency_p95_ms','limit_used_pct','limit_window_min']) {
    const v = m[k];
    if (v != null && (typeof v !== 'number' || v < 0 || v > 1e7)) return `metrics.${k} invalid`;
  }
  // Active time is a duration, not an identity, and it is bounded by the same
  // seven days a session's wall-clock span is. Null when the tool's store
  // could not reconstruct turns, and absent on clients that predate it.
  if (m.active_s != null && (typeof m.active_s !== 'number' || m.active_s < 0 || m.active_s > 7 * 86400)) return 'metrics.active_s invalid';

  // Added with the adapter layer; a client that predates them is still valid.
  for (const k of ['tool_call_errors','context_limit_hits']) {
    const v = m[k];
    if (v != null && (typeof v !== 'number' || v < 0 || v > 1e9)) return `metrics.${k} invalid`;
  }

  // Provider overload, split out of rate_limit_hits. A client that predates
  // the split sends nothing here and its rate_limit_hits still validates.
  if (m.overloaded != null && (typeof m.overloaded !== 'number' || m.overloaded < 0 || m.overloaded > 1e6)) return 'metrics.overloaded invalid';

  // Signals arrived after the first clients; a record without them is valid.
  const sig = validateSignals(r.signals);
  if (sig) return sig;
  const ver = num('signal_version', 0, 1e6, true);
  if (ver) return ver;

  // Limit windows arrived later still; a client that predates them sends none.
  const lim = validateLimitWindows(r.limit_windows);
  if (lim) return lim;

  return validateModelRef(r.model_ref);
}

// A session sees a handful of windows: Codex reports at most two per limit id
// and Claude Code three. Anything past this is not a subscription, it is a
// payload.
const MAX_LIMIT_WINDOWS = 64;

/**
 * Limit windows are published raw, so the same rule as `signals` applies: the
 * only string allowed anywhere inside one is `scope`, and it must come from
 * the enum. Percentages go to 1000 because a spend limit can legitimately
 * exceed its cap; everything else is a count, a duration or a bucket index.
 */
export function validateLimitWindows(x: unknown): string | null {
  if (x == null) return null;
  if (!Array.isArray(x)) return 'limit_windows invalid';
  if (x.length > MAX_LIMIT_WINDOWS) return 'limit_windows too many';
  for (const w of x) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return 'limit_windows entry invalid';
    const e = w as Record<string, unknown>;
    for (const [k, v] of Object.entries(e)) {
      if (k !== 'scope' && typeof v === 'string') return `limit_windows.${k} must not be a string`;
    }
    if (!LIMIT_SCOPES.includes(e.scope as never)) return `limit_windows.scope must be one of ${LIMIT_SCOPES.join(',')}`;
    if (typeof e.wall_hit !== 'boolean') return 'limit_windows.wall_hit invalid';
    const n = (k: string, lo: number, hi: number, nullable: boolean, int = false) => {
      const v = e[k];
      if (v == null) return nullable ? null : `limit_windows.${k} invalid`;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return `limit_windows.${k} invalid`;
      return int && !Number.isInteger(v) ? `limit_windows.${k} invalid` : null;
    };
    const checks = [
      n('samples', 0, 1e6, false),
      n('used_pct_start', 0, 1000, true),
      n('used_pct_end', 0, 1000, true),
      n('window_min', 1, 1e6, true),
      n('resets_in_min_end', 0, 1e6, true),
      n('reset_bucket', 0, 1e12, true, true),
    ];
    for (const c of checks) if (c) return c;

    const t = e.tokens as Record<string, unknown> | undefined;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return 'limit_windows.tokens invalid';
    for (const k of ['total', 'uncached_in', 'out', 'cached_in']) {
      const v = t[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e12) return `limit_windows.tokens.${k} invalid`;
    }
  }
  return null;
}

// Every count in `Signals`, and every field that may be null instead of a
// number. Both lists are exhaustive on purpose: a field added to the shape
// without a rule here fails the "nothing but numbers" check below anyway.
const SIGNAL_COUNTS = [
  'corrections', 'reprompts', 'frustration', 'pushback', 'clarifications',
  'edits_without_read', 'edit_tool_calls', 'retries', 'user_turns', 'assistant_turns',
] as const;
const SIGNAL_NULLABLE = [
  'test_failures_before_pass', 'turns_to_first_success', 'steering_ratio', 'thinking_ratio',
] as const;

/**
 * Signals are counts, and the whole privacy argument for publishing them is
 * that the type has no string field. So the first rule is mechanical: a
 * string anywhere inside `signals` is a transcript leak, and the record is
 * rejected rather than sanitised. 1e6 is far above any real session and well
 * below the point where a number stops being a count.
 */
export function validateSignals(x: unknown): string | null {
  if (x == null) return null;
  if (typeof x !== 'object' || Array.isArray(x)) return 'signals invalid';
  const s = x as Record<string, unknown>;
  const count = (k: string, v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e6 ? null : `signals.${k} invalid`;

  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'string') return `signals.${k} must not be a string`;
    if (v != null && typeof v !== 'number' && typeof v !== 'boolean') return `signals.${k} invalid`;
  }
  for (const k of SIGNAL_COUNTS) { const e = count(k, s[k]); if (e) return e; }
  for (const k of SIGNAL_NULLABLE) { if (s[k] != null) { const e = count(k, s[k]); if (e) return e; } }
  if (typeof s.abandoned !== 'boolean') return 'signals.abandoned invalid';
  return null;
}

/**
 * model_ref carries nothing identifying: normalised family, size, quant, who
 * served it. The length caps exist because raw_id and raw_provider are
 * user-typed strings and a public record is not a place for free text.
 */
export function validateModelRef(x: unknown): string | null {
  // Older clients do not send one at all; the board treats those as unknown.
  if (x == null) return null;
  if (typeof x !== 'object') return 'model_ref invalid';
  const r = x as Record<string, unknown>;
  for (const k of ['raw_id', 'raw_provider', 'family', 'version', 'size', 'provider', 'variant']) {
    const v = r[k];
    if (v == null) continue;
    if (typeof v !== 'string' || v.length > 80) return `model_ref.${k} invalid`;
  }
  if (typeof r.quant !== 'string' || r.quant.length === 0 || r.quant.length > 40) return 'model_ref.quant invalid';
  if (!SERVING_MODES.includes(r.serving_mode as never)) return `model_ref.serving_mode must be one of ${SERVING_MODES.join(',')}`;
  if (typeof r.modified !== 'boolean') return 'model_ref.modified invalid';
  return null;
}

export function isReport(x: unknown): x is Report {
  return validateReport(x) === null;
}
