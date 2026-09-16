import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIGNAL_VERSION, emptyMetrics, emptySignals, emptySurvival, resolveModelRef,
  type Category, type Kept, type Metrics, type Session, type Signals, type Tool,
} from '@nerfd/core';

// A whole month of synthetic work in its own NERFD_HOME: three model
// identities (one of them served locally), two tools, three plans, ratings,
// signals and a fixed spread of weeks. Everything the report claims is
// asserted against numbers written here, and the two strings that must never
// reach the page - a prompt and an absolute path - are planted in every
// session that could carry them.

const HOME = mkdtempSync(join(tmpdir(), 'nerfd-report-'));
process.env.NERFD_HOME = HOME;

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

// Distinctive on purpose: a substring search for either of these in the
// report is a privacy regression, not a coincidence.
const PROMPT = 'ZZ-SECRET-PROMPT artichoke parliament refactor the billing gateway';
const CWD = '/Users/tester/dev/quokka-secret-project';
const PROJECT = 'quokka-secret-project';

writeFileSync(join(HOME, 'config.json'), JSON.stringify({
  install_id: '00000000-0000-4000-8000-000000000000',
  server: 'http://localhost:8787',
  share: 'never',
  created_at: '2026-08-01T00:00:00.000Z',
  plans: { 'claude-code': { id: 'claude-max-20x', name: 'Claude Max 20x', usd_month: 200, source: 'declared' } },
  detected_plans: {
    checked_at: new Date().toISOString(),
    plans: { opencode: { plan_id: 'opencode-go', source: 'detected', evidence: null, confidence: 'medium' } },
  },
}, null, 2) + '\n', { mode: 0o600 });

const { listSessions, putSession } = await import('../src/db.ts');
const { buildReportData, labelFor, logoFor } = await import('../src/report/data.ts');
const { renderFallback } = await import('../src/report/fallback.ts');
const { renderReport } = await import('../src/report/html.ts');

const REFS = {
  opus: resolveModelRef('claude-opus-5', 'anthropic', {}),
  kimi: resolveModelRef('kimi-k2.7-code', 'groq', {}),
  qwen: resolveModelRef('qwen3-coder:30b-a3b-q4_K_M', 'ollama', { baseUrl: 'http://127.0.0.1:11434' }),
};

const LABELS = {
  opus: labelFor('claude-opus-5', REFS.opus),
  kimi: labelFor('kimi-k2.7-code', REFS.kimi),
  qwen: labelFor('qwen3-coder:30b-a3b-q4_K_M', REFS.qwen),
};

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

interface Spec {
  id: string; which: keyof typeof REFS; tool: Tool; plan: [string, number | null];
  days: number; category: Category; rating: number | null; kept: Kept; survival: number | null;
  errors?: number; rate_limits?: number; interrupts?: number; corrections?: number; reprompts?: number;
}

// 5 Opus on Claude Code, 4 Kimi and 3 local Qwen on OpenCode. `code` has
// three Opus sessions, `debug` three Kimi, `refactor` three local Qwen, so
// each of the three has exactly one category it can win.
const MAX20: [string, number | null] = ['claude-max-20x', 200];
const ALLEGRO: [string, number | null] = ['kimi-allegro', 99];
const LOCAL: [string, number | null] = ['local', 0];

const SPECS: Spec[] = [
  { id: 's01', which: 'opus', tool: 'claude-code', plan: MAX20, days: 1, category: 'code', rating: 5, kept: 'kept', survival: 0.9 },
  { id: 's02', which: 'opus', tool: 'claude-code', plan: MAX20, days: 2, category: 'code', rating: 4, kept: 'kept', survival: 0.8, interrupts: 1 },
  { id: 's03', which: 'opus', tool: 'claude-code', plan: MAX20, days: 3, category: 'code', rating: 4, kept: 'kept', survival: 0.75 },
  { id: 's04', which: 'opus', tool: 'claude-code', plan: MAX20, days: 8, category: 'debug', rating: 5, kept: 'kept', survival: 0.7 },
  { id: 's05', which: 'opus', tool: 'claude-code', plan: MAX20, days: 15, category: 'debug', rating: 3, kept: 'partial', survival: 0.4, errors: 2, corrections: 1 },

  { id: 's06', which: 'kimi', tool: 'opencode', plan: ALLEGRO, days: 4, category: 'code', rating: 4, kept: 'kept', survival: 0.7 },
  { id: 's07', which: 'kimi', tool: 'opencode', plan: ALLEGRO, days: 9, category: 'debug', rating: 4, kept: 'kept', survival: 0.65 },
  { id: 's08', which: 'kimi', tool: 'opencode', plan: ALLEGRO, days: 10, category: 'debug', rating: 3, kept: 'partial', survival: 0.5, rate_limits: 3, reprompts: 2 },
  // The roughest session by a distance: nine friction events against a 1.
  { id: 's09', which: 'kimi', tool: 'opencode', plan: ALLEGRO, days: 16, category: 'debug', rating: 1, kept: 'reverted', survival: 0.05, errors: 4, rate_limits: 2, interrupts: 1, corrections: 1, reprompts: 1 },

  { id: 's10', which: 'qwen', tool: 'opencode', plan: LOCAL, days: 5, category: 'refactor', rating: 4, kept: 'kept', survival: 0.8 },
  { id: 's11', which: 'qwen', tool: 'opencode', plan: LOCAL, days: 11, category: 'refactor', rating: 3, kept: 'partial', survival: 0.55, errors: 1 },
  { id: 's12', which: 'qwen', tool: 'opencode', plan: LOCAL, days: 17, category: 'refactor', rating: 2, kept: 'reverted', survival: 0.2, errors: 2, interrupts: 2, corrections: 2 },
];

function metrics(s: Spec): Metrics {
  return {
    ...emptyMetrics(),
    prompts: 6, turns: 14, tool_calls: 20, edits: 5, files_touched: 3, tests_run: 2,
    errors: s.errors ?? 0, rate_limit_hits: s.rate_limits ?? 0, interrupts: s.interrupts ?? 0,
    tool_call_errors: s.errors ?? 0, context_limit_hits: 0,
    tokens_in: 400_000, tokens_out: 30_000, tokens_cache_read: 200_000,
    latency_p50_ms: 2_000, latency_p95_ms: 6_000,
    limit_used_pct: s.rate_limits ? 96 : 40, limit_window_min: 300,
  };
}

function signals(s: Spec): Signals {
  return {
    ...emptySignals(),
    corrections: s.corrections ?? 0, reprompts: s.reprompts ?? 0,
    pushback: 0, clarifications: 1, edits_without_read: 0, edit_tool_calls: 5,
    abandoned: (s.errors ?? 0) >= 4, user_turns: 6, assistant_turns: 14,
  };
}

function session(s: Spec): Session {
  const ended = ago(s.days);
  return {
    id: s.id,
    tool: s.tool,
    tool_version: '1.0.0',
    model: REFS[s.which].raw_id,
    model_ref: REFS[s.which],
    effort: null,
    plan_id: s.plan[0],
    plan_usd_month: s.plan[1],
    plan_source: 'declared',
    started_at: new Date(Date.parse(ended) - 1800_000).toISOString(),
    ended_at: ended,
    duration_s: 1800,
    cwd: CWD,
    repo: { lang: 'ts', size: 'm', age: 'established' },
    category: s.category,
    category_source: 'inferred',
    size: 'm',
    first_prompt: PROMPT,
    metrics: metrics(s),
    signals: signals(s),
    signal_version: SIGNAL_VERSION,
    outcome: { rating: s.rating, kept: s.kept, note: PROMPT, rated_at: ended },
    survival: { ...emptySurvival(), lines_added: 100, lines_surviving: 60, ratio: s.survival, checked_at: ended },
    line_hashes: null,
    touched_files: [`${CWD}/src/billing.ts`],
    transcript_path: `${CWD}/.transcript.jsonl`,
    shared_at: null,
    price_snapshot_date: null,
    source: 'record',
  };
}

for (const s of SPECS) putSession(session(s));

// A session resumed across three days: 72 hours of wall clock, half an hour
// of work. Deliberately outside the four-week window every assertion below
// uses, so only the eight-week report sees it.
const RESUMED = session({ id: 's13', which: 'opus', tool: 'claude-code', plan: MAX20, days: 40, category: 'code', rating: null, kept: 'unknown', survival: null });
RESUMED.duration_s = 3 * 86_400;
RESUMED.metrics = { ...RESUMED.metrics, active_s: 1800 };
putSession(RESUMED);

const data = buildReportData({ weeks: 4, projects: false });

// ---------------------------------------------------------------------------

test('labels carry family, version, host and local quantisation', () => {
  assert.equal(LABELS.opus, 'claude-opus-5');
  assert.equal(LABELS.kimi, 'kimi-k2.7-code via groq');
  assert.match(LABELS.qwen, /^qwen3-coder.* 30B-A3B q4_K_M local$/);
  // The mark follows the weights' vendor, not whoever served them.
  assert.equal(logoFor('claude-opus'), 'anthropic');
  assert.equal(logoFor('kimi-k2'), 'moonshotai');
  assert.equal(logoFor('qwen3-coder'), 'alibaba');
  assert.equal(logoFor('groq'), 'groq');
  assert.equal(logoFor('something-nobody-has-heard-of'), '');
});

test('the glance counts every finished session in the period', () => {
  assert.equal(data.empty, false);
  assert.equal(data.glance.sessions, 12);
  // Rated 4 or better: s01-s04, s06, s07, s10.
  assert.equal(data.glance.successes, 7);
  assert.equal(data.glance.success_rate, 0.5833);   // rounded, so the JSON is stable
  assert.equal(data.glance.hours, 6);
  assert.ok((data.glance.api_equiv_usd ?? 0) > 0, 'nine hosted sessions have a list price');
  assert.match(data.glance.sentence, /^You ran 12 sessions across 2 tools in the last 4 weeks/);
  assert.match(data.glance.sentence, /7 succeeded \(58%\)/);
  assert.deepEqual(data.identity.tools, ['claude-code', 'opencode']);
  assert.equal(data.identity.models.length, 3);
});

test('plans come from what was declared and what was detected', () => {
  assert.deepEqual(data.identity.plans, [
    { tool: 'claude-code', plan_id: 'claude-max-20x', name: 'Claude Max 20x', usd_month: 200, source: 'declared' },
    { tool: 'opencode', plan_id: 'opencode-go', name: 'OpenCode Go', usd_month: null, source: 'detected' },
  ]);
});

test('ranking scores every identity separately and picks a winner per category', () => {
  assert.deepEqual([...data.ranking.models].map((m) => m.label).sort(), [LABELS.kimi, LABELS.opus, LABELS.qwen].sort());
  const opus = data.ranking.models.find((m) => m.label === LABELS.opus)!;
  assert.equal(opus.n, 5);
  assert.equal(opus.family, 'claude-opus');
  assert.equal(opus.provider, 'anthropic');
  assert.ok(opus.score != null && opus.score > 0);

  const qwen = data.ranking.models.find((m) => m.label === LABELS.qwen)!;
  assert.equal(qwen.serving_mode, 'local');
  assert.equal(qwen.quant, 'q4_K_M');
  assert.equal(qwen.cost_per_success, null, 'local weights are never priced as spend');

  const which = new Map(data.ranking.which.map((w) => [w.category, w]));
  assert.equal(which.get('code')!.best, LABELS.opus);
  assert.equal(which.get('code')!.n, 3);
  assert.equal(which.get('debug')!.best, LABELS.kimi);
  assert.equal(which.get('refactor')!.best, LABELS.qwen);
});

test('the matrix scores a cell only once it has three sessions', () => {
  const { categories, models, cells } = data.ranking.matrix;
  assert.deepEqual(categories, ['code', 'debug', 'refactor']);
  assert.equal(models.length, 3);
  const at = (c: string, m: string) => cells.find((x) => x.category === c && x.model === m);
  assert.equal(at('code', LABELS.opus)!.n, 3);
  assert.ok(at('code', LABELS.opus)!.score != null);
  // One Kimi session in `code`: the n is shown, the score is withheld.
  assert.equal(at('code', LABELS.kimi)!.n, 1);
  assert.equal(at('code', LABELS.kimi)!.score, null);
  assert.equal(at('refactor', LABELS.opus), undefined);
});

test('economics pro-rates the plan price over the weeks it was used', () => {
  const plans = new Map(data.economics.plans.map((p) => [p.plan_id, p]));
  assert.deepEqual([...plans.keys()].sort(), ['claude-max-20x', 'kimi-allegro', 'local']);

  const max = plans.get('claude-max-20x')!;
  assert.equal(max.tool, 'claude-code');
  assert.equal(max.name, 'Claude Max 20x');
  assert.equal(max.usd_month, 200);
  assert.equal(max.sessions, 5);
  assert.equal(max.successes, 4);
  assert.ok(max.weeks >= 2 && max.weeks <= 4);
  assert.ok((max.api_equiv_usd ?? 0) > 0 && max.multiple != null && max.cost_per_success != null);

  const kimi = plans.get('kimi-allegro')!;
  assert.equal(kimi.limit_hits, 2, 's08 and s09 hit a limit');
  assert.equal(kimi.limit_peak_pct, 96);
  assert.ok((kimi.waste_share ?? 0) > 0, 's09 was reverted and rated 1');

  // Locally served weights are billed at zero and credited with what the same
  // tokens would have cost hosted.
  const local = plans.get('local')!;
  assert.equal(local.api_equiv_usd, null);
  assert.ok((local.hosted_equiv_saved_usd ?? 0) > 0);
  assert.equal(max.hosted_equiv_saved_usd, null);
});

test('the roughest sessions are ordered by friction, then by how badly they were rated', () => {
  const rough = data.trouble.roughest;
  assert.ok(rough.length > 0 && rough.length <= 8);
  const score = (r: (typeof rough)[number]) => r.errors + r.rate_limits + r.interrupts + r.corrections + r.reprompts;
  for (let i = 1; i < rough.length; i++) {
    const a = rough[i - 1]!;
    const b = rough[i]!;
    assert.ok(score(a) > score(b) || (score(a) === score(b) && (a.rating ?? 99) <= (b.rating ?? 99)),
      `${a.label} ${score(a)} should not sort after ${b.label} ${score(b)}`);
  }
  // s09: 4 errors + 2 rate limits + 1 interrupt + 1 correction + 1 reprompt.
  assert.equal(score(rough[0]!), 9);
  assert.equal(rough[0]!.label, LABELS.kimi);
  assert.equal(rough[0]!.rating, 1);
  assert.equal(rough[0]!.project, undefined, 'no folder name without --projects');
  assert.ok(rough.every((r) => r.duration_s === 1800));
});

test('trouble is counted per model and per week', () => {
  const by = new Map(data.trouble.by_model.map((t) => [t.label, t]));
  assert.equal(by.get(LABELS.kimi)!.errors, 4);
  assert.equal(by.get(LABELS.kimi)!.rate_limits, 5);
  assert.equal(by.get(LABELS.qwen)!.errors, 3);
  assert.equal(by.get(LABELS.opus)!.errors, 2);
  const weeks = data.trouble.weekly;
  assert.ok(weeks.length >= 2);
  assert.deepEqual([...weeks].map((w) => w.week).sort(), weeks.map((w) => w.week));
  assert.equal(weeks.reduce((a, w) => a + w.sessions, 0), 12);
});

test('drift only reports a model seen in two or more weeks', () => {
  assert.ok(data.drift.length >= 1);
  for (const d of data.drift) {
    assert.ok(d.weekly.length >= 2);
    assert.ok(['none', 'watch', 'alert', 'n/a'].includes(d.flag));
  }
  assert.ok(data.drift.some((d) => d.label === LABELS.opus));
});

test('the share card carries models and money and no identity', () => {
  assert.ok(data.share.headline.length > 0);
  assert.ok(data.share.lines.length >= 3);
  assert.ok(data.share.caption.endsWith('compare on nerfd.ai'));
  const blob = [data.share.headline, data.share.caption, ...data.share.lines].join(' ');
  assert.ok(!blob.includes(PROMPT) && !blob.includes(CWD) && !blob.includes(PROJECT));
  assert.ok(!blob.includes('claude-code') && !blob.includes('opencode'), 'the card is about models, not your setup');
});

test('an empty period says so instead of rendering nothing', () => {
  const none = buildReportData({ weeks: 1, projects: false, now: new Date(NOW.getTime() - 400 * DAY) });
  assert.equal(none.empty, true);
  assert.equal(none.glance.sessions, 0);
  assert.deepEqual(none.ranking.models, []);
  assert.match(none.glance.sentence, /No finished sessions/);
  assert.ok(renderFallback(none).includes('<!doctype html>'));
});

// ---- privacy ---------------------------------------------------------------

const clean = (s: string) => !s.includes(PROMPT) && !s.includes(CWD) && !s.includes('/Users/tester');

test('neither the data nor the page carries a prompt or a path', () => {
  const json = JSON.stringify(data);
  assert.ok(clean(json), 'ReportData leaked a prompt or a path');
  assert.ok(!json.includes(PROJECT), 'a folder name needs --projects');
  const html = renderFallback(data);
  assert.ok(clean(html), 'the fallback page leaked a prompt or a path');
  assert.ok(!html.includes(PROJECT));
  assert.ok(html.includes(LABELS.opus) && html.includes('Claude Max 20x'));
});

test('--projects adds the folder name and nothing else from the path', () => {
  const withProjects = buildReportData({ weeks: 4, projects: true });
  const json = JSON.stringify(withProjects);
  assert.ok(clean(json));
  assert.ok(json.includes(PROJECT), '--projects labels sessions by folder');
  assert.ok(withProjects.trouble.roughest.every((r) => r.project === PROJECT));
  const html = renderFallback(withProjects);
  assert.ok(clean(html));
  assert.ok(html.includes(PROJECT));
});

// ---- the command ------------------------------------------------------------

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, 'report', ...args], {
    env: { ...process.env, NERFD_HOME: HOME },
    encoding: 'utf8',
  });
}

test('`nerfd report --json` prints the same data, with nothing identifying in it', () => {
  const parsed = JSON.parse(run(['--json', '--weeks', '4'])) as typeof data;
  assert.equal(parsed.glance.sessions, 12);
  assert.equal(parsed.empty, false);
  const raw = JSON.stringify(parsed);
  assert.ok(clean(raw) && !raw.includes(PROJECT));

  const withProjects = run(['--json', '--weeks', '4', '--projects']);
  assert.ok(clean(withProjects));
  assert.ok(withProjects.includes(PROJECT));
});

test('`nerfd report --no-open --out file` writes a readable page', () => {
  const out = join(HOME, 'report-test.html');
  const printed = run(['--no-open', '--weeks', '4', '--out', out]);
  assert.ok(existsSync(out), 'the report was written');
  assert.ok(printed.startsWith(out + '\n'), 'the path is the first line');
  assert.ok(printed.includes('You ran 12 sessions'), 'the glance sentence is the second line');

  const html = readFileSync(out, 'utf8');
  assert.ok(html.trimStart().toLowerCase().startsWith('<!doctype html>'));
  assert.ok(clean(html) && !html.includes(PROJECT));
  assert.ok(html.includes(LABELS.opus));
});

test('hours are active time: a session resumed over three days is half an hour', () => {
  const wide = buildReportData({ weeks: 8, projects: false });
  assert.equal(wide.glance.sessions, 13);
  // The twelve sessions above are half an hour each; s13 adds its active
  // half hour, not its 72 hour span (which would have read 10 hours).
  assert.equal(wide.glance.hours, 6.5);
  assert.match(wide.glance.sentence, /6\.5 hours of work/);
  // duration_s stays the wall span on the record; only what is reported moved.
  const stored = listSessions({ limit: 50 }).find((s) => s.id === 's13')!;
  assert.equal(stored.duration_s, 3 * 86_400);
  assert.equal(stored.metrics.active_s, 1800);
});

test('a period nobody has judged reports no successes rather than none succeeding', () => {
  const unjudged = {
    ...data,
    glance: { ...data.glance, successes: null, success_rate: null },
  };
  const html = renderFallback(unjudged);
  assert.ok(!/0 of 12 sessions succeeded/.test(html));
  const full = renderReport(unjudged, { logos: {} });
  assert.ok(full.includes('not measured yet'), 'the lede says the work is unmeasured');
  assert.ok(!/0 of 12 sessions succeeded/.test(full));
});

test('a version that refines the family name replaces it rather than following it', () => {
  const sol = resolveModelRef('gpt-5.6-sol', 'openai', {});
  assert.equal(labelFor('gpt-5.6-sol', sol), 'gpt-5.6');            // not gpt-5-5.6
  const codex = resolveModelRef('gpt-5.6-codex', 'openai', {});
  assert.equal(labelFor('gpt-5.6-codex', codex), 'gpt-5.6-codex');  // not gpt-codex-5.6-codex
  const astra = resolveModelRef('gpt-6-astra', 'openai', {});
  assert.equal(labelFor('gpt-6-astra', astra), 'gpt-6-astra');      // a name, not a number: appended
  assert.equal(LABELS.opus, 'claude-opus-5');
});
