// The contract between the report data builder (data.ts) and the renderer
// (html.ts). Everything here is derived from local sessions; labels are
// model identities, never prompts or paths. `project` appears only when the
// person passes --projects and is for their eyes only.

export type Logo = string; // key into the logo set: anthropic, openai, google, moonshotai, zai, deepseek, alibaba, minimax, meta, mistral, xai, ollama, openrouter, groq, lmstudio, opencode, github, or '' for none

export interface ReportPlan {
  tool: string;
  plan_id: string;
  name: string;
  usd_month: number | null;
  source: 'detected' | 'declared' | 'unknown';
}

export interface ReportGlance {
  sessions: number;
  hours: number;
  successes: number;
  success_rate: number | null;
  api_equiv_usd: number | null;   // sum over priced sessions
  sentence: string;               // one plain-English line summarising the period
}

export interface ReportPlanEconomics {
  tool: string;
  plan_id: string;
  name: string;
  usd_month: number | null;
  weeks: number;                  // weeks in the period with sessions on this plan
  sessions: number;
  successes: number;
  hours: number;
  api_equiv_usd: number | null;
  multiple: number | null;        // api_equiv / pro-rata plan price for the period
  cost_per_success: number | null; // pro-rata plan price / successes
  waste_share: number | null;
  limit_hits: number;
  limit_peak_pct: number | null;
  hosted_equiv_saved_usd: number | null; // local plans only
}

export interface ReportModelEconomics {
  label: string;
  logo: Logo;
  serving_mode: string;
  n: number;
  cost_mean: number | null;
  cost_per_success: number | null;
  waste_share: number | null;
}

export interface ReportRankedModel {
  label: string;                  // e.g. "claude-opus-5", "kimi-k2.7-code via groq", "qwen3-coder 30B q4_K_M local"
  logo: Logo;
  family: string | null;
  provider: string | null;
  quant: string;
  serving_mode: string;
  n: number;
  score: number | null;
  rating_mean: number | null;
  success_rate: number | null;
  survival_mean: number | null;
  friction_free: number;
  steering: number | null;        // corrections + reprompts + pushback per user turn
  latency_p50_ms: number | null;
  cost_per_success: number | null;
}

export interface ReportMatrixCell { category: string; model: string; n: number; score: number | null }

export interface ReportTroubleModel {
  label: string;
  logo: Logo;
  n: number;
  errors: number;
  rate_limits: number;
  timeouts: number;
  context_limit_hits: number;
  tool_call_errors: number;
  correction_rate: number | null;
  reprompt_rate: number | null;
  pushback_rate: number | null;
  frustration_rate: number | null;
  clarification_rate: number | null;
  edit_without_read_rate: number | null;
  abandoned_rate: number | null;
}

export interface ReportWeekTrouble { week: string; sessions: number; errors: number; rate_limits: number; interrupts: number }

export interface ReportRoughSession {
  ended_at: string;
  tool: string;
  label: string;
  logo: Logo;
  category: string;
  duration_s: number;
  errors: number;
  rate_limits: number;
  interrupts: number;
  corrections: number;
  reprompts: number;
  rating: number | null;
  project?: string;               // only with --projects
}

export interface ReportDrift {
  label: string;
  logo: Logo;
  weekly: Array<{ week: string; n: number; score: number | null }>;
  flag: 'none' | 'watch' | 'alert' | 'n/a';
  rating_z: number | null;
  friction_z: number | null;
  steering_z: number | null;
}

export interface ReportData {
  generated_at: string;
  weeks: number;
  period: { from: string; to: string };
  identity: { tools: string[]; models: string[]; plans: ReportPlan[] };
  glance: ReportGlance;
  economics: { plans: ReportPlanEconomics[]; models: ReportModelEconomics[] };
  ranking: {
    models: ReportRankedModel[];
    matrix: { categories: string[]; models: string[]; cells: ReportMatrixCell[] };
    which: Array<{ category: string; best: string | null; n: number }>;
  };
  trouble: { by_model: ReportTroubleModel[]; weekly: ReportWeekTrouble[]; roughest: ReportRoughSession[] };
  drift: ReportDrift[];
  share: { headline: string; lines: string[]; caption: string };
  empty: boolean;                 // true when there are no finished sessions in the period
}
