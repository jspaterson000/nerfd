// The contract between the report data builder (data.ts) and the renderer
// (html.ts). Everything here is derived from local sessions; labels are
// model identities, never prompts or paths. `project` appears only when the
// person passes --projects and is for their eyes only.

export type Logo = string; // key into the logo set: anthropic, openai, google, moonshotai, zai, deepseek, alibaba, minimax, meta, mistral, xai, ollama, openrouter, groq, lmstudio, opencode, github, or '' for none

export type PlanSourceLabel = 'detected' | 'declared' | 'assumed' | 'unknown';

export interface ReportPlan {
  tool: string;
  plan_id: string;
  name: string;
  usd_month: number | null;
  // 'assumed' means the sessions themselves carry no plan - imported history
  // predates the stamp - and today's plan was applied to them for the sums.
  source: PlanSourceLabel;
}

export interface ReportGlance {
  sessions: number;
  hours: number;
  // Null, not zero, when nothing in the period was rated, kept or measured:
  // "0 successes" is a verdict on work nobody has judged.
  successes: number | null;
  success_rate: number | null;
  api_equiv_usd: number | null;   // sum over priced sessions
  sentence: string;               // one plain-English line summarising the period
}

export interface ReportPlanEconomics {
  tool: string;                   // the tool with the most sessions on this plan; picks the logo
  tools: string[];                // every tool that ran on it: one subscription, one card
  source: PlanSourceLabel;
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

/**
 * One subscription window of your own: what it holds, how full you typically
 * leave it, and how often you hit the wall. The capacity figures are
 * estimates from your own sessions - see docs/LIMITS.md - and are null until
 * a window has moved enough to divide by.
 */
export interface ReportLimitWindow {
  scope: string;                      // five_hour, seven_day, primary, ...
  window_min: number | null;
  capacity_total_p50: number | null;      // tokens the window holds, total-token basis
  capacity_uncached_p50: number | null;   // uncached input + output basis
  n_windows: number;                      // windows observed, estimated or not
  usage_median_pct: number | null;        // how full you typically leave it
  wall_hits: number;                      // windows in which you hit the wall
  typical_resets_in_min: number | null;   // median minutes to reset at the last reading
}

export interface ReportLimitPlan {
  plan_id: string;
  name: string;
  usd_month: number | null;
  tokens_per_dollar_p50: number | null;
  successes_per_dollar: number | null;
  wall_hit_share: number;
  usage_median_pct: number | null;
  // The public band for the same plan, for the "and everyone else" column.
  // Null until a later fetch fills it in; the report never calls out on its own.
  public_band?: { p25: number | null; p50: number | null; p75: number | null } | null;
}

/**
 * A scope that was observed but never moved enough to divide by. Kept apart
 * from `windows` so the page can say "observed, not enough movement to
 * estimate" rather than print a capacity of zero for an idle window.
 */
export interface ReportObservedWindow {
  scope: string;
  window_min: number | null;
  sessions: number;
  samples: number;
}

export interface ReportLimits {
  windows: ReportLimitWindow[];       // scopes with at least one window worth estimating from
  observed_only: ReportObservedWindow[];
  plans: ReportLimitPlan[];
  empty: boolean;                     // no window state on any session in the period
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
  limits: ReportLimits;
  share: { headline: string; lines: string[]; caption: string };
  empty: boolean;                 // true when there are no finished sessions in the period
}
