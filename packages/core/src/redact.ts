import { createHash } from 'node:crypto';
import { lookupModel } from './catalog.ts';
import { emptyModelRef, type ModelRef } from './modelref.ts';
import { planById } from './plans.ts';
import { normalisedFamily } from './pricing.ts';
import { SIGNAL_VERSION } from './signals.ts';
import { isoWeek } from './stats.ts';
import type { Report, RepoProfile, Session } from './types.ts';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Stable, short, non-reversible id for a path. */
export function hashPath(p: string): string {
  return sha256(p).slice(0, 16);
}

/**
 * Hash a single source line for survival tracking. The salt is the local
 * install id: without it the same line of a public file hashes identically on
 * every machine, which would make the hashes a membership oracle.
 */
export function hashLine(file: string, line: string, salt = ''): string {
  return sha256(salt + ' :: ' + file + ' :: ' + line.trim()).slice(0, 20);
}

// Languages the board knows. The detector falls back to "whichever file
// extension is most common", and an extension can be a product name, so
// anything off this list is reported as 'other'.
export const LANGS = [
  'ts', 'js', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'rb', 'php', 'cs', 'cpp', 'c', 'scala',
  'ex', 'erl', 'hs', 'clj', 'lua', 'sh', 'sql', 'html', 'css', 'md', 'yaml', 'json', 'tf',
  'dart', 'zig', 'nix', 'r', 'jl', 'mixed', 'none', 'other',
] as const;

function publicLang(repo: RepoProfile): RepoProfile {
  return { ...repo, lang: (LANGS as readonly string[]).includes(repo.lang) ? repo.lang : 'other' };
}

/**
 * The model id as the board may see it. A hosted id is a public product name
 * and goes out as-is; an id nobody has ever heard of was typed by the person
 * running the model and can say anything, so it is replaced by the identity
 * we derived from it.
 */
export function publicModelId(model: string, ref: ModelRef): string {
  const known = lookupModel(ref.provider ?? ref.raw_provider ?? null, model) != null || normalisedFamily(model) != null;
  if (known) return model.slice(0, 64);
  const bits = [
    ref.family ? (ref.size ? `${ref.family}:${ref.size}` : ref.family) : 'unknown',
    ref.serving_mode,
    ref.quant !== 'unknown' ? ref.quant : null,
  ].filter((x): x is string => x != null);
  return bits.join(' ').slice(0, 64);
}

/**
 * model_ref itself contains nothing identifying, but raw_provider is whatever
 * the person called their own endpoint in their own config ("work-vllm",
 * "daves-box"), so for anything served locally it is replaced by the label we
 * inferred. raw_id is kept, truncated, because it is the only way to tell two
 * quantisations of the same weights apart.
 */
export function publicModelRef(r: ModelRef): ModelRef {
  return {
    ...r,
    raw_id: r.raw_id ? r.raw_id.slice(0, 80) : null,
    raw_provider: r.serving_mode === 'local' ? r.provider : (r.raw_provider ? r.raw_provider.slice(0, 80) : null),
  };
}

/** ISO hour, UTC. A session end time to the second is close to a fingerprint. */
function hourBucket(iso: string): string {
  const t = Date.parse(iso);
  return (Number.isNaN(t) ? new Date() : new Date(t)).toISOString().slice(0, 13) + ':00:00.000Z';
}

/**
 * Turn a local session into the public record. Anything that could identify
 * the person, the project, or the prompt is dropped here, not "later".
 *
 * The reporter id rotates every ISO week: a per-reporter daily cap and
 * week-over-week aggregation both still work, but nobody can follow one
 * person's sessions across months.
 */
export function toReport(s: Session, installId: string, clientVersion: string, evidenceUrl: string | null = null): Report | null {
  if (!s.model || !s.ended_at) return null;
  const week = isoWeek(s.ended_at);
  const ref = s.model_ref ?? emptyModelRef();
  const plan = planById(s.plan_id);
  return {
    report_id: sha256(installId + " :: " + s.id).slice(0, 32),
    reporter_id: sha256(installId + " :: " + week).slice(0, 24),
    client_version: clientVersion,
    tool: s.tool,
    tool_version: s.tool_version,
    model: publicModelId(s.model, ref),
    model_ref: publicModelRef(ref),
    effort: s.effort,
    // A free-typed dollar amount is a detail about one person's billing, so
    // only prices that came from the published plan table are sent.
    plan_id: s.plan_id ? (plan ? plan.id : 'custom') : null,
    plan_usd_month: plan ? plan.usd_month : null,
    // How the plan was established. Two words at most, and the only thing
    // detection ever publishes; the file and field it read stay local.
    plan_source: s.plan_source ?? 'unknown',
    week,
    ended_at: hourBucket(s.ended_at),
    category: s.category,
    size: s.size,
    repo: publicLang(s.repo),
    duration_s: s.duration_s ?? 0,
    // Metrics pass through whole, `active_s` included: it is a duration, like
    // duration_s and the latencies, and says nothing about who or where.
    metrics: s.metrics,
    // Signals pass through untouched. There is nothing to redact: the type
    // has no string field, so what is here is counts, booleans and nulls.
    // See signals.ts and docs/SIGNALS.md.
    signals: s.signals ?? null,
    signal_version: s.signals ? (s.signal_version ?? SIGNAL_VERSION) : null,
    // Limit windows pass through untouched, for the same reason signals do:
    // by construction the only string in one is `scope`, which comes from an
    // allowlist, and the reset time is already an offset plus an hour bucket.
    // See docs/LIMITS.md.
    limit_windows: s.limit_windows ?? [],
    rating: s.outcome.rating,
    kept: s.outcome.kept,
    survival_ratio: s.survival.ratio,
    // A boolean about the session, not about the person: nobody prompted it.
    // Published so the board can rank steered work separately without
    // throwing away what the automated run cost.
    automated: s.automated ?? false,
    evidence_url: evidenceUrl,
  };
}
