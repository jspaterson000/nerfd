import type { ReportData, ReportRankedModel } from './types.js';

// Synthetic design fixture. No conversation text, identifiers or project paths.
const weeks = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'];
const models: ReportRankedModel[] = [
  { label: 'Claude Opus 4.6', logo: 'anthropic', family: 'Claude', provider: 'anthropic', quant: '', serving_mode: 'subscription', n: 28, score: 88, rating_mean: 4.6, success_rate: 24 / 28, survival_mean: .93, friction_free: .82, steering: .07, latency_p50_ms: 2400, cost_per_success: 240.8 / 24 },
  { label: 'GPT-5.4', logo: 'openai', family: 'GPT', provider: 'openai', quant: '', serving_mode: 'subscription', n: 24, score: 81, rating_mean: 4.2, success_rate: 19 / 24, survival_mean: .88, friction_free: .75, steering: .11, latency_p50_ms: 1800, cost_per_success: 76.2 / 19 },
  { label: 'Kimi K2.5 via groq', logo: 'moonshotai', family: 'Kimi K2.5', provider: 'groq', quant: 'fp8', serving_mode: 'api', n: 12, score: 74, rating_mean: 3.9, success_rate: 9 / 12, survival_mean: .83, friction_free: .67, steering: .14, latency_p50_ms: 420, cost_per_success: 1.12 },
  { label: 'Qwen3-Coder 30B q4_K_M local', logo: 'alibaba', family: 'Qwen3-Coder', provider: 'ollama', quant: 'q4_K_M', serving_mode: 'local', n: 10, score: 66, rating_mean: 3.5, success_rate: .6, survival_mean: .78, friction_free: .6, steering: .18, latency_p50_ms: 3100, cost_per_success: 1.82 },
  { label: 'Claude Sonnet 4.6', logo: 'anthropic', family: 'Claude', provider: 'anthropic', quant: '', serving_mode: 'subscription', n: 10, score: 58, rating_mean: 3.1, success_rate: .5, survival_mean: .68, friction_free: .4, steering: .28, latency_p50_ms: 1600, cost_per_success: 14.56 },
];
const categories = ['Implementation', 'Debugging', 'Review', 'Refactoring'];
const scores = [[92, 83, 76, 64, 59], [90, 85, 68, 58, 51], [83, 89, 80, 70, 62], [87, 75, 72, 74, 60]];
const counts = [[10, 8, 4, 3, 3], [8, 7, 2, 2, 3], [4, 5, 4, 2, 2], [6, 4, 2, 3, 2]];

export const SAMPLE: ReportData = {
  generated_at: '2026-09-14T08:30:00.000Z', weeks: 4,
  period: { from: '2026-08-17T00:00:00.000Z', to: '2026-09-13T23:59:59.999Z' },
  identity: {
    tools: ['Claude Code', 'Codex', 'OpenCode'], models: models.map(m => m.label),
    plans: [
      { tool: 'Claude Code', plan_id: 'claude-max-5x', name: 'Claude Max 5×', usd_month: 100, source: 'detected' },
      { tool: 'Codex', plan_id: 'chatgpt-plus', name: 'ChatGPT Plus', usd_month: 20, source: 'declared' },
    ],
  },
  glance: { sessions: 84, hours: 62.4, successes: 63, success_rate: .75, api_equiv_usd: 410.8, sentence: 'You put AI to work for 62.4 hours across three tools. 63 of 84 sessions succeeded. Your Claude Max plan delivered about 3.4× its period cost in API-equivalent work.' },
  economics: {
    plans: [
      { tool: 'Claude Code', plan_id: 'claude-max-5x', name: 'Claude Max 5×', usd_month: 100, weeks: 4, sessions: 38, successes: 29, hours: 32.8, api_equiv_usd: 313.6, multiple: 3.4, cost_per_success: 92.31 / 29, waste_share: .13, limit_hits: 7, limit_peak_pct: 98, hosted_equiv_saved_usd: null },
      { tool: 'Codex', plan_id: 'chatgpt-plus', name: 'ChatGPT Plus', usd_month: 20, weeks: 4, sessions: 24, successes: 19, hours: 17.6, api_equiv_usd: 76.2, multiple: 4.13, cost_per_success: 18.46 / 19, waste_share: .09, limit_hits: 2, limit_peak_pct: 84, hosted_equiv_saved_usd: null },
    ],
    models: models.map((m, i) => ({ label: m.label, logo: m.logo, serving_mode: m.serving_mode, n: m.n, cost_mean: [8.6, 3.175, .84, 1.092, 7.28][i]!, cost_per_success: m.cost_per_success, waste_share: [.08, .09, .12, null, .29][i]! })),
  },
  ranking: {
    models,
    matrix: { categories, models: models.map(m => m.label), cells: categories.flatMap((category, r) => models.map((m, c) => ({ category, model: m.label, n: counts[r]![c]!, score: scores[r]![c]! }))) },
    which: categories.map((category, i) => ({ category, best: models[i === 2 ? 1 : 0]!.label, n: counts[i]!.reduce((a, b) => a + b, 0) })),
  },
  trouble: {
    by_model: models.map((m, i) => ({ label: m.label, logo: m.logo, n: m.n, errors: [5, 6, 4, 7, 12][i]!, rate_limits: [4, 2, 3, 0, 3][i]!, timeouts: [1, 1, 2, 2, 3][i]!, context_limit_hits: [1, 2, 0, 3, 2][i]!, tool_call_errors: [2, 2, 1, 4, 6][i]!, correction_rate: [.03, .05, .06, .09, .13][i]!, reprompt_rate: [.03, .04, .05, .06, .09][i]!, pushback_rate: [.01, .02, .03, .03, .06][i]!, frustration_rate: [.01, .02, .03, .04, .08][i]!, clarification_rate: [.04, .05, .03, .07, .06][i]!, edit_without_read_rate: [.02, .02, .04, .09, .08][i]!, abandoned_rate: [1 / 28, 2 / 24, 1 / 12, .2, .3][i]! })),
    weekly: weeks.map((week, i) => ({ week, sessions: [17, 20, 22, 25][i]!, errors: [5, 7, 9, 13][i]!, rate_limits: [2, 3, 3, 4][i]!, interrupts: [3, 4, 5, 8][i]! })),
    roughest: [4, 3, 4, 2, 1, 0].map((index, i) => ({ ended_at: ['2026-09-12T16:42:00Z', '2026-09-10T09:15:00Z', '2026-09-08T14:30:00Z', '2026-09-03T11:20:00Z', '2026-08-28T17:05:00Z', '2026-08-21T10:40:00Z'][i]!, tool: index === 1 ? 'Codex' : index === 2 || index === 3 ? 'OpenCode' : 'Claude Code', label: models[index]!.label, logo: models[index]!.logo, category: categories[i % categories.length]!, duration_s: [5520, 4380, 3660, 2940, 4200, 3180][i]!, errors: [5, 4, 4, 3, 3, 2][i]!, rate_limits: [2, 0, 1, 2, 1, 2][i]!, interrupts: [4, 3, 2, 2, 1, 1][i]!, corrections: [8, 6, 5, 3, 4, 2][i]!, reprompts: [5, 4, 4, 3, 2, 2][i]!, rating: [1, 2, 2, 2, 3, 3][i]! })),
  },
  drift: models.map((m, i) => ({ label: m.label, logo: m.logo, weekly: weeks.map((week, w) => ({ week, n: [[6, 7, 7, 8], [5, 6, 6, 7], [3, 3, 3, 3], [2, 3, 3, 2], [1, 1, 3, 5]][i]![w]!, score: [[86, 87, 89, 90], [80, 82, 79, 83], [72, 76, 73, 75], [null, 68, 67, null], [79, 71, 56, 39]][i]![w]! })), flag: i === 4 ? 'alert' : i === 3 ? 'n/a' : 'none', rating_z: i === 4 ? -2.7 : i === 3 ? null : .3, friction_z: i === 4 ? 2.4 : i === 3 ? null : -.2, steering_z: i === 4 ? 2.8 : i === 3 ? null : .1 })),
  share: { headline: 'A month of AI. Measured.', lines: ['84 sessions · 62.4 hours · 75% successful (n=84)', 'Claude Opus leads: 88 / 100 points (n=28)', 'Claude Max: 3.4× API-equivalent value (n=38)', '34 errors · 12 rate limits across 84 sessions'], caption: 'My AI usage, measured locally with nerfd: 84 sessions, 75% successful, and 3.4× API-equivalent value from Claude Max. Personal results, not a universal benchmark. Compare on nerfd.ai.' },
  empty: false,
};
