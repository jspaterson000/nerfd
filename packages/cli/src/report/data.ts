import {
  CATEGORIES, aggregate, costUsd, drift, economics, hostedEquivalentUsd, isSuccess,
  planById, reporterWeeks, steeringRate, weekly,
  type Category, type Group, type ModelRef, type Row, type Session, type Tool,
} from '@nerfd/core';
import { listSessions } from '../db.ts';
import { loadConfig } from '../paths.ts';
import { effectivePlan } from '../plandetect/index.ts';
import { localRows } from '../rows.ts';
import type {
  Logo, ReportData, ReportDrift, ReportMatrixCell, ReportModelEconomics, ReportPlan,
  ReportPlanEconomics, ReportRankedModel, ReportRoughSession, ReportTroubleModel, ReportWeekTrouble,
} from './types.ts';

// Builds the whole report from the local database and nothing else. Every
// number here comes from the shared aggregator, so a figure in the report is
// the same figure `nerfd stats`, `nerfd cost` and the public board would give.
//
// Two rules the renderer relies on:
//   - no text from a session ever reaches this object. Labels are model
//     identities; `project` is a folder basename and only with --projects.
//   - the output is deterministic: every list has an explicit total order, so
//     two runs over the same database produce byte-identical JSON.

const MS_WEEK = 7 * 86_400_000;

export interface ReportOpts { weeks: number; projects: boolean; now?: Date }

// ---- labels and logos ---------------------------------------------------

// Same mapping as the board's `logoFor`, so the personal report and nerfd.ai
// put the same mark next to the same weights.
const LOGOS: Array<[RegExp, Logo]> = [
  [/^(claude|anthropic)/, 'anthropic'],
  [/^(gpt|o1|o3|o4|openai|codex|chatgpt)/, 'openai'],
  [/^(gemini|gemma|google|vertex)/, 'google'],
  [/^(kimi|moonshot)/, 'moonshotai'],
  [/^(glm|zai|zhipu)/, 'zai'],
  [/^deepseek/, 'deepseek'],
  [/^(qwen|qwq|alibaba|dashscope)/, 'alibaba'],
  [/^minimax/, 'minimax'],
  [/^(llama|muse|meta)/, 'meta'],
  [/^(mistral|devstral|codestral|ministral|magistral|mixtral)/, 'mistral'],
  [/^(grok|xai)/, 'xai'],
  [/^openrouter/, 'openrouter'],
  [/^groq/, 'groq'],
  [/^cerebras/, 'cerebras'],
  [/^together/, 'together'],
  [/^fireworks/, 'fireworks'],
  [/^deepinfra/, 'deepinfra'],
  [/^ollama/, 'ollama'],
  [/^lm[ -]?studio/, 'lmstudio'],
  [/^opencode/, 'opencode'],
  [/^(github|copilot)/, 'github'],
];

/** The logo file a family, vendor or provider id maps to, or '' for none. */
export function logoFor(id: string | null | undefined): Logo {
  const key = String(id ?? '').toLowerCase().split('/').pop() ?? '';
  return LOGOS.find(([re]) => re.test(key))?.[1] ?? '';
}

/**
 * What a person would call this thing: the family, plus the version when the
 * version says something the family name does not, plus the host when the
 * host is not the family's own vendor, plus size and quant when the weights
 * ran on this machine. "claude-opus-5", "kimi-k2.7-code via groq",
 * "qwen3-coder-2507 30B-A3B q4_K_M local".
 */
export function labelFor(model: string, ref: ModelRef | null | undefined): string {
  const family = ref?.family ?? null;
  let base = family ?? model ?? 'unknown';
  const version = ref?.version ?? null;
  if (family && version && !family.toLowerCase().includes(version.toLowerCase())) {
    // `gpt-codex` + `5-codex` is `gpt-5-codex`, not `gpt-codex-5-codex`: when
    // the version restates the tail of the family, it replaces it.
    const tail = family.slice(family.lastIndexOf('-') + 1);
    base = tail.length >= 2 && version.toLowerCase().includes(tail.toLowerCase())
      ? family.slice(0, family.length - tail.length) + version
      : `${family}-${version}`;
  }
  if (ref?.serving_mode === 'local') {
    const bits = [ref.size, ref.quant && ref.quant !== 'unknown' ? ref.quant : null].filter((x): x is string => !!x);
    return [base, ...bits, 'local'].join(' ');
  }
  const provider = ref?.provider ?? null;
  if (provider && logoFor(provider) !== logoFor(family ?? base)) return `${base} via ${provider}`;
  return base;
}

// ---- model identity -----------------------------------------------------
//
// A local q4 and a hosted fp8 of the same weights are not the same row, so
// the grouping key is the id plus who served it plus at what precision. This
// is exactly `aggregate(rows, IDENTITY)`; `identityId` reproduces the key the
// aggregator builds so a group can be looked up from a row.

const IDENTITY = ['model', 'provider', 'quant', 'serving_mode'] as const;

function identityId(r: Row): string {
  const router = r.model_ref?.serving_mode === 'router';
  return [
    r.model,
    router ? '-' : (r.model_ref?.provider ?? '-'),
    r.model_ref?.quant ?? 'unknown',
    r.model_ref?.serving_mode ?? '-',
  ].join(' | ');
}

function groupId(g: Group): string {
  return IDENTITY.map((b) => g.key[b] ?? '-').join(' | ');
}

interface Identity { id: string; label: string; logo: Logo; group: Group; rows: Row[] }

function identities(rows: Row[]): Identity[] {
  const byId = new Map<string, Row[]>();
  for (const r of rows) {
    const id = identityId(r);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(r);
  }
  return aggregate(rows, [...IDENTITY])
    .map((g) => {
      const id = groupId(g);
      const mine = byId.get(id) ?? [];
      const ref = mine[0]?.model_ref ?? null;
      const label = labelFor(g.key.model ?? 'unknown', ref);
      return { id, label, logo: logoFor(ref?.family) || logoFor(g.key.model) || logoFor(ref?.provider), group: g, rows: mine };
    })
    // aggregate already orders by score then n; the label breaks the last tie
    // so two runs cannot disagree.
    .sort((a, b) => (b.group.score ?? -1) - (a.group.score ?? -1) || b.group.n - a.group.n || a.label.localeCompare(b.label));
}

// ---- small helpers ------------------------------------------------------

const round = (v: number | null | undefined, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function totalCost(rows: Row[]): number | null {
  const priced = rows.map((r) => costUsd(r.model_ref ?? r.model, r.metrics)).filter((x): x is number => x != null);
  return priced.length ? sum(priced) : null;
}

function hours(rows: Row[]): number {
  return sum(rows.map((r) => r.duration_s)) / 3600;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const money = (v: number) => (v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

// ---- the build ----------------------------------------------------------

export function buildReportData(opts: ReportOpts): ReportData {
  const weeks = Math.max(1, Math.round(opts.weeks));
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - weeks * MS_WEEK);
  const fromIso = from.toISOString();
  const toIso = now.toISOString();

  // localRows windows on wall-clock time; when a caller pins `now` the window
  // is widened to cover it and then cut to the period exactly.
  const span = Math.max(weeks, Math.ceil((Date.now() - from.getTime()) / MS_WEEK) + 1);
  const rows = localRows({ weeks: span }).filter((r) => r.ended_at >= fromIso && r.ended_at <= toIso);

  const ids = identities(rows);
  const labelOf = new Map(ids.map((i) => [i.id, i.label]));

  const tools = [...new Set(rows.map((r) => r.tool))].sort();
  const base: Pick<ReportData, 'generated_at' | 'weeks' | 'period'> = {
    generated_at: toIso,
    weeks,
    period: { from: fromIso, to: toIso },
  };

  const plans = declaredAndDetectedPlans(tools);

  if (rows.length === 0) {
    const sentence = `No finished sessions in the last ${plural(weeks, 'week')}. Run \`nerfd init\`, then use your coding tool as usual.`;
    return {
      ...base,
      identity: { tools, models: [], plans },
      glance: { sessions: 0, hours: 0, successes: 0, success_rate: null, api_equiv_usd: null, sentence },
      economics: { plans: [], models: [] },
      ranking: { models: [], matrix: { categories: [], models: [], cells: [] }, which: [] },
      trouble: { by_model: [], weekly: [], roughest: [] },
      drift: [],
      share: {
        headline: 'No AI sessions on record yet',
        lines: ['nerfd is installed and watching; the first finished session lands here.'],
        caption: 'Measuring my own AI coding from today. compare on nerfd.ai',
      },
      empty: true,
    };
  }

  const planEconomics = buildPlanEconomics(rows);
  const ranked = ids.map(toRanked);
  const matrix = buildMatrix(rows, ids, labelOf);
  const glance = buildGlance(rows, weeks, tools, planEconomics);

  return {
    ...base,
    identity: { tools, models: ids.map((i) => i.label), plans },
    glance,
    economics: { plans: planEconomics, models: ids.map(toModelEconomics) },
    ranking: { models: ranked, matrix: matrix.matrix, which: matrix.which },
    trouble: {
      by_model: ids.map(toTrouble),
      weekly: weeklyTrouble(rows),
      roughest: roughestSessions(fromIso, toIso, opts.projects),
    },
    drift: buildDrift(ids),
    share: buildShare(glance, ranked, planEconomics, rows, weeks),
    empty: false,
  };
}

// ---- identity.plans -----------------------------------------------------

/**
 * What the person is paying, per tool they actually used: a plan they typed
 * beats one read off this machine's config, which beats nothing. The file a
 * detector opened never leaves `plandetect`; only the id and the word.
 */
function declaredAndDetectedPlans(tools: Tool[]): ReportPlan[] {
  const cfg = loadConfig();
  const out: ReportPlan[] = [];
  for (const tool of tools) {
    const e = effectivePlan(cfg, tool);
    if (!e.plan_id) continue;
    const declared = cfg.plans[tool] ?? cfg.plans.other;
    const known = planById(e.plan_id);
    const declaredHere = e.plan_source === 'declared' && declared?.id === e.plan_id;
    out.push({
      tool,
      plan_id: e.plan_id,
      name: (declaredHere ? declared?.name : known?.name) ?? known?.name ?? e.plan_id,
      usd_month: declaredHere ? (declared?.usd_month ?? null) : (known?.usd_month ?? null),
      source: e.plan_source === 'declared' || e.plan_source === 'detected' ? e.plan_source : 'unknown',
    });
  }
  return out.sort((a, b) => a.tool.localeCompare(b.tool) || a.plan_id.localeCompare(b.plan_id));
}

// ---- glance -------------------------------------------------------------

function buildGlance(rows: Row[], weeks: number, tools: Tool[], plans: ReportPlanEconomics[]): ReportData['glance'] {
  const judged = rows.map(isSuccess).filter((x): x is boolean => x != null);
  const successes = rows.filter((r) => isSuccess(r) === true).length;
  const success_rate = judged.length ? judged.filter(Boolean).length / judged.length : null;
  const api = totalCost(rows);
  const hrs = hours(rows);

  const parts = [
    `You ran ${plural(rows.length, 'session')} across ${plural(tools.length, 'tool')} in the last ${plural(weeks, 'week')}, ${hrs.toFixed(1)} hours of work.`,
    // "0 succeeded" would be a verdict on work nobody has judged yet.
    success_rate == null
      ? 'None of them are rated or measured yet, so there is no success rate: `nerfd rate last 4 kept` takes two seconds.'
      : `${successes} succeeded (${pct(success_rate)}).`,
  ];
  // The plan sentence is the one people quote, so it names the plan that paid
  // for the most sessions rather than the best-value one.
  const paid = [...plans].filter((p) => p.api_equiv_usd != null && p.usd_month).sort((a, b) => b.sessions - a.sessions)[0];
  if (paid) parts.push(`Your ${paid.name} bought about ${money(paid.api_equiv_usd!)} of API-equivalent work.`);
  else if (api != null && api > 0) parts.push(`That is about ${money(api)} of API-equivalent work.`);
  const saved = sum(plans.map((p) => p.hosted_equiv_saved_usd ?? 0));
  if (saved > 0) parts.push(`${money(saved)} of it ran on your own hardware.`);

  return {
    sessions: rows.length,
    hours: round(hrs, 2) ?? 0,
    successes,
    success_rate: round(success_rate, 4),
    api_equiv_usd: round(api, 2),
    sentence: parts.join(' '),
  };
}

// ---- economics ----------------------------------------------------------

/**
 * One row per tool and plan. The plan price is pro-rated to the weeks the
 * plan actually saw sessions, because a report over four weeks of which two
 * were a holiday should not claim a month's price bought nothing.
 */
function buildPlanEconomics(rows: Row[]): ReportPlanEconomics[] {
  const rws = reporterWeeks(rows);
  const byPlan = new Map<string, typeof rws>();
  for (const rw of rws) {
    const key = `${rw.tool} | ${rw.plan_id}`;
    if (!byPlan.has(key)) byPlan.set(key, []);
    byPlan.get(key)!.push(rw);
  }
  const out: ReportPlanEconomics[] = [];
  for (const [, list] of byPlan) {
    const f = list[0]!;
    const mine = rows.filter((r) => r.tool === f.tool && r.plan_id === f.plan_id);
    const weeks = list.length;
    const prorata = f.plan_usd_week == null ? null : f.plan_usd_week * weeks;
    const api = list.map((x) => x.api_equiv_usd).filter((x): x is number => x != null);
    const api_equiv_usd = api.length ? sum(api) : null;
    const successes = sum(list.map((x) => x.successes));
    const peaks = list.map((x) => x.limit_peak_pct).filter((x): x is number => x != null);
    const known = planById(f.plan_id);
    const saved = sum(mine.map((r) => hostedEquivalentUsd(r.model_ref ?? null, r.metrics) ?? 0));
    out.push({
      tool: f.tool,
      plan_id: f.plan_id,
      name: known?.name ?? f.plan_id,
      usd_month: f.plan_usd_month ?? null,
      weeks,
      sessions: sum(list.map((x) => x.sessions)),
      successes,
      hours: round(sum(list.map((x) => x.hours)), 2) ?? 0,
      api_equiv_usd: round(api_equiv_usd, 2),
      multiple: prorata && prorata > 0 && api_equiv_usd != null ? round(api_equiv_usd / prorata, 2) : null,
      cost_per_success: prorata && successes > 0 ? round(prorata / successes, 2) : null,
      waste_share: round(economics(mine).waste_share, 4),
      limit_hits: sum(list.map((x) => x.limit_hits)),
      limit_peak_pct: peaks.length ? round(Math.max(...peaks), 1) : null,
      hosted_equiv_saved_usd: saved > 0 ? round(saved, 2) : null,
    });
  }
  return out.sort((a, b) => (b.multiple ?? -1) - (a.multiple ?? -1) || b.sessions - a.sessions || a.tool.localeCompare(b.tool) || a.plan_id.localeCompare(b.plan_id));
}

function toModelEconomics(i: Identity): ReportModelEconomics {
  const g = i.group;
  return {
    label: i.label,
    logo: i.logo,
    serving_mode: g.key.serving_mode ?? '-',
    n: g.n,
    cost_mean: round(g.cost_mean, 4),
    cost_per_success: round(g.cost_per_success, 4),
    waste_share: round(g.waste_share, 4),
  };
}

// ---- ranking ------------------------------------------------------------

function toRanked(i: Identity): ReportRankedModel {
  const g = i.group;
  const ref = i.rows[0]?.model_ref ?? null;
  return {
    label: i.label,
    logo: i.logo,
    family: ref?.family ?? null,
    provider: g.key.provider === '-' ? null : (g.key.provider ?? null),
    quant: g.key.quant ?? 'unknown',
    serving_mode: g.key.serving_mode ?? '-',
    n: g.n,
    score: g.score,
    rating_mean: round(g.rating_mean, 2),
    success_rate: round(g.success_rate, 4),
    survival_mean: round(g.survival_mean, 4),
    friction_free: round(g.friction_free, 4) ?? 0,
    steering: round(steeringRate(g), 4),
    latency_p50_ms: g.latency_p50_ms == null ? null : Math.round(g.latency_p50_ms),
    cost_per_success: round(g.cost_per_success, 4),
  };
}

/**
 * `nerfd which` as a picture: every category against every model, with the
 * n behind each cell. A cell with fewer than three sessions carries its n and
 * no score, because three sessions is where `scoreGroup` starts answering.
 */
function buildMatrix(rows: Row[], ids: Identity[], labelOf: Map<string, string>) {
  const categories = (CATEGORIES as readonly Category[]).filter((c) => rows.some((r) => r.category === c));
  const models = ids.map((i) => i.label);
  const cells: ReportMatrixCell[] = [];
  for (const category of categories) {
    const inCat = rows.filter((r) => r.category === category);
    for (const g of aggregate(inCat, [...IDENTITY])) {
      const model = labelOf.get(groupId(g));
      if (!model) continue;
      cells.push({ category, model, n: g.n, score: g.n >= 3 ? g.score : null });
    }
  }
  cells.sort((a, b) => categories.indexOf(a.category as Category) - categories.indexOf(b.category as Category)
    || models.indexOf(a.model) - models.indexOf(b.model));

  const which = categories.map((category) => {
    const eligible = cells.filter((c) => c.category === category && c.n >= 3 && c.score != null);
    const best = eligible.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.n - a.n || a.model.localeCompare(b.model))[0];
    return {
      category,
      best: best?.model ?? null,
      n: best?.n ?? rows.filter((r) => r.category === category).length,
    };
  });

  return { matrix: { categories: [...categories], models, cells }, which };
}

// ---- trouble ------------------------------------------------------------

function toTrouble(i: Identity): ReportTroubleModel {
  const g = i.group;
  const m = (f: (x: Row) => number) => sum(i.rows.map(f));
  return {
    label: i.label,
    logo: i.logo,
    n: g.n,
    errors: m((r) => r.metrics.errors),
    rate_limits: m((r) => r.metrics.rate_limit_hits),
    timeouts: m((r) => r.metrics.timeouts),
    context_limit_hits: m((r) => r.metrics.context_limit_hits),
    tool_call_errors: m((r) => r.metrics.tool_call_errors),
    correction_rate: round(g.correction_rate, 4),
    reprompt_rate: round(g.reprompt_rate, 4),
    pushback_rate: round(g.pushback_rate, 4),
    frustration_rate: round(g.frustration_rate, 4),
    clarification_rate: round(g.clarification_rate, 4),
    edit_without_read_rate: round(g.edit_without_read_rate, 4),
    abandoned_rate: round(g.abandoned_rate, 4),
  };
}

function weeklyTrouble(rows: Row[]): ReportWeekTrouble[] {
  const byWeek = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week)!.push(r);
  }
  return [...byWeek.entries()]
    .map(([week, list]) => ({
      week,
      sessions: list.length,
      errors: sum(list.map((r) => r.metrics.errors)),
      rate_limits: sum(list.map((r) => r.metrics.rate_limit_hits)),
      interrupts: sum(list.map((r) => r.metrics.interrupts)),
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

const troubleScore = (s: Session): number =>
  s.metrics.errors + s.metrics.rate_limit_hits + s.metrics.interrupts
  + (s.signals?.corrections ?? 0) + (s.signals?.reprompts ?? 0);

/**
 * The eight sessions that went worst, so a week can be remembered rather than
 * only counted. Counts, a timestamp and a model identity: no prompt, no path.
 * `project` is the folder's basename, which the person asked for with
 * --projects and which never leaves this file.
 */
function roughestSessions(fromIso: string, toIso: string, projects: boolean): ReportRoughSession[] {
  const sessions = listSessions({ sinceIso: fromIso, endedOnly: true })
    .filter((s) => s.ended_at != null && s.ended_at >= fromIso && s.ended_at <= toIso)
    // The same noise filter localRows applies: opened-and-closed is not a session.
    .filter((s) => s.metrics.prompts > 0 || (s.duration_s ?? 0) >= 60)
    .filter((s) => troubleScore(s) > 0);

  return sessions
    .sort((a, b) =>
      troubleScore(b) - troubleScore(a)
      || (a.outcome.rating ?? Number.POSITIVE_INFINITY) - (b.outcome.rating ?? Number.POSITIVE_INFINITY)
      || (b.ended_at ?? '').localeCompare(a.ended_at ?? '')
      || a.id.localeCompare(b.id))
    .slice(0, 8)
    .map((s) => {
      const out: ReportRoughSession = {
        ended_at: s.ended_at!,
        tool: s.tool,
        label: labelFor(s.model ?? 'unknown', s.model_ref),
        logo: logoFor(s.model_ref?.family) || logoFor(s.model) || logoFor(s.model_ref?.provider),
        category: s.category,
        duration_s: s.duration_s ?? 0,
        errors: s.metrics.errors,
        rate_limits: s.metrics.rate_limit_hits,
        interrupts: s.metrics.interrupts,
        corrections: s.signals?.corrections ?? 0,
        reprompts: s.signals?.reprompts ?? 0,
        rating: s.outcome.rating,
      };
      const project = projects ? basename(s.cwd) : null;
      if (project) out.project = project;
      return out;
    });
}

/** Last path segment only. A folder name is not a path and not a repo remote. */
function basename(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/[/\\]+$/, '').split(/[/\\]/);
  const last = parts[parts.length - 1];
  return last && last !== '.' && last !== '..' ? last : null;
}

// ---- drift --------------------------------------------------------------

/** Week-over-week per model, for models seen in at least two of the weeks. */
function buildDrift(ids: Identity[]): ReportDrift[] {
  const out: ReportDrift[] = [];
  for (const i of ids) {
    const series = weekly(i.rows);
    if (series.length < 2) continue;
    const model = i.rows[0]!.model;
    // The rows are already one identity, so `drift`'s own model filter is a
    // no-op and a local q4 cannot be compared against its hosted twin.
    const d = drift(i.rows, model);
    out.push({
      label: i.label,
      logo: i.logo,
      weekly: series.map((w) => ({ week: w.week, n: w.n, score: w.score })),
      flag: d?.flag ?? 'n/a',
      rating_z: round(d?.rating_z ?? null, 2),
      friction_z: round(d?.friction_z ?? null, 2),
      steering_z: round(d?.steering_z ?? null, 2),
    });
  }
  return out.sort((a, b) => b.weekly.length - a.weekly.length || a.label.localeCompare(b.label));
}

// ---- share card ---------------------------------------------------------

/**
 * The card is meant to be posted, so it carries model names, scores and
 * dollars and nothing else: no tool of yours, no folder, no week you were
 * offline. Everything here is already in `glance` and `ranking`.
 */
function buildShare(
  glance: ReportData['glance'], ranked: ReportRankedModel[], plans: ReportPlanEconomics[], rows: Row[], weeks: number,
): ReportData['share'] {
  const top = ranked.find((m) => m.score != null) ?? null;
  const lines: string[] = [];
  lines.push(`${plural(glance.sessions, 'session')} over ${plural(weeks, 'week')}, ${glance.hours.toFixed(1)} hours`);
  if (glance.success_rate != null) lines.push(`${pct(glance.success_rate)} of them succeeded`);
  if (top) lines.push(`Best model: ${top.label}, score ${top.score} over ${plural(top.n, 'session')}`);
  const value = plans.find((p) => p.multiple != null);
  if (value) lines.push(`${value.name}: ${value.multiple}x the plan price in API-equivalent work`);
  if (glance.api_equiv_usd != null && glance.api_equiv_usd > 0) lines.push(`${money(glance.api_equiv_usd)} of API-equivalent tokens`);
  const clean = rows.filter((r) => r.metrics.errors === 0 && r.metrics.rate_limit_hits === 0 && r.metrics.interrupts === 0).length;
  lines.push(`${pct(clean / rows.length)} of sessions ran with no errors, rate limits or interrupts`);

  const headline = top
    ? `${plural(weeks, 'week')} of AI coding: ${top.label} led on ${plural(top.n, 'session')}`
    : `${plural(weeks, 'week')} of AI coding, measured`;
  const caption = top
    ? `${plural(weeks, 'week')} of my own AI coding, measured: ${top.label} scored ${top.score} over ${plural(top.n, 'session')}. compare on nerfd.ai`
    : `${plural(weeks, 'week')} of my own AI coding, measured: ${plural(glance.sessions, 'session')} scored against each other. compare on nerfd.ai`;

  return { headline, lines, caption };
}
