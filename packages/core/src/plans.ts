import type { Tool } from './types.ts';

// Known subscription plans. Prices are monthly USD list prices and are
// editable; the aggregator only needs usd_month. `api` means pay-as-you-go.
//
// `verified: false` means the price or the plan's existence came from docs or
// secondary sources and has not been confirmed against a live account. Those
// rows are shown with the caveat rather than quietly averaged in.

export interface Plan {
  id: string;
  tool: Tool | 'any';
  name: string;
  usd_month: number | null;
  verified?: boolean;   // default true; false means "documented, not confirmed"
  note?: string;
}

export const PLANS: Plan[] = [
  { id: 'claude-pro',     tool: 'claude-code', name: 'Claude Pro',      usd_month: 20 },
  { id: 'claude-max-5x',  tool: 'claude-code', name: 'Claude Max 5x',   usd_month: 100 },
  { id: 'claude-max-20x', tool: 'claude-code', name: 'Claude Max 20x',  usd_month: 200 },
  { id: 'claude-team',    tool: 'claude-code', name: 'Claude Team',     usd_month: 30 },
  { id: 'claude-enterprise', tool: 'claude-code', name: 'Claude Enterprise', usd_month: null, verified: false, note: 'negotiated pricing' },

  // Auto-detection can read `subscriptionType: "max"` but nothing on disk says
  // which Max. This id exists so a detection is not silently rounded to the
  // wrong price; `nerfd plan` asks for one command to resolve it.
  { id: 'claude-max',     tool: 'claude-code', name: 'Claude Max (5x or 20x, undetermined)', usd_month: null, verified: false, note: 'detected tier; run `nerfd plan claude claude-max-20x` to price it' },

  { id: 'chatgpt-plus',   tool: 'codex',       name: 'ChatGPT Plus',    usd_month: 20 },
  { id: 'chatgpt-pro',    tool: 'codex',       name: 'ChatGPT Pro',     usd_month: 200 },

  // The rest of OpenAI's KnownPlan enum, as the Codex CLI spells it. Prices are
  // unverified and several of these are per-seat or negotiated.
  { id: 'chatgpt-free',     tool: 'codex', name: 'ChatGPT Free',       usd_month: 0 },
  { id: 'chatgpt-go',       tool: 'codex', name: 'ChatGPT Go',         usd_month: null, verified: false, note: 'price unverified' },
  { id: 'chatgpt-pro-lite', tool: 'codex', name: 'ChatGPT Pro Lite',   usd_month: null, verified: false, note: 'price unverified' },
  { id: 'chatgpt-business', tool: 'codex', name: 'ChatGPT Business',   usd_month: null, verified: false, note: 'per seat; covers the team and self-serve business SKUs' },
  { id: 'chatgpt-enterprise', tool: 'codex', name: 'ChatGPT Enterprise', usd_month: null, verified: false, note: 'negotiated pricing' },
  { id: 'chatgpt-edu',      tool: 'codex', name: 'ChatGPT Edu',        usd_month: null, verified: false, note: 'institutional pricing' },

  // Open-weight coding plans. Per-tier credit allowances are not verified, so
  // the value-per-month number is the only thing these rows are used for.
  { id: 'kimi-adagio',     tool: 'kimi', name: 'Kimi Code Adagio (free)', usd_month: 0, verified: false, note: 'free tier' },
  { id: 'kimi-moderato',   tool: 'kimi', name: 'Kimi Code Moderato',   usd_month: 19 },
  { id: 'kimi-allegretto', tool: 'kimi', name: 'Kimi Code Allegretto', usd_month: 39 },
  { id: 'kimi-allegro',    tool: 'kimi', name: 'Kimi Code Allegro',    usd_month: 99 },
  { id: 'kimi-vivace',     tool: 'kimi', name: 'Kimi Code Vivace',     usd_month: 199 },

  { id: 'glm-coding-lite', tool: 'any', name: 'Z.ai GLM Coding Lite',  usd_month: 18 },
  { id: 'glm-coding-pro',  tool: 'any', name: 'Z.ai GLM Coding Pro',   usd_month: null, verified: false, note: 'price unverified' },
  { id: 'glm-coding-max',  tool: 'any', name: 'Z.ai GLM Coding Max',   usd_month: null, verified: false, note: 'price unverified' },

  // The $10/$20/$50 figures still in circulation are 2025 launch prices.
  { id: 'minimax-plus',  tool: 'any', name: 'MiniMax Token Plan Plus',  usd_month: 22 },
  { id: 'minimax-max',   tool: 'any', name: 'MiniMax Token Plan Max',   usd_month: 55 },
  { id: 'minimax-ultra', tool: 'any', name: 'MiniMax Token Plan Ultra', usd_month: 132 },

  // Gemini Code Assist / Google AI. The tier is resolved live by the Gemini CLI
  // and never written to disk, so these are declare-only: detection can tell an
  // API key from a signed-in Google account, and no more.
  { id: 'gemini-free',     tool: 'gemini', name: 'Gemini Code Assist (free)', usd_month: 0, verified: false },
  { id: 'gemini-ai-pro',   tool: 'gemini', name: 'Google AI Pro',             usd_month: 20, verified: false, note: 'price unverified' },
  { id: 'gemini-ai-ultra', tool: 'gemini', name: 'Google AI Ultra',           usd_month: null, verified: false, note: 'price unverified' },

  // Copilot seats. `copilot_plan` is only available from GitHub's API, never
  // from disk, so these are declare-only too.
  { id: 'copilot-free',     tool: 'copilot', name: 'GitHub Copilot Free',     usd_month: 0, verified: false },
  { id: 'copilot-pro',      tool: 'copilot', name: 'GitHub Copilot Pro',      usd_month: 10, verified: false, note: 'list price, not confirmed against a live account' },
  { id: 'copilot-pro-plus', tool: 'copilot', name: 'GitHub Copilot Pro+',     usd_month: 39, verified: false, note: 'list price, not confirmed against a live account' },
  { id: 'copilot-business', tool: 'copilot', name: 'GitHub Copilot Business', usd_month: 19, verified: false, note: 'per seat' },
  { id: 'copilot-enterprise', tool: 'copilot', name: 'GitHub Copilot Enterprise', usd_month: 39, verified: false, note: 'per seat' },

  { id: 'alibaba-coding', tool: 'any',      name: 'Alibaba Model Studio Coding Plan', usd_month: 28, verified: false, note: 'about $28; bundles Qwen, Kimi, GLM and MiniMax behind one endpoint' },
  { id: 'synthetic',      tool: 'any',      name: 'Synthetic.new',                    usd_month: 30, note: 'open-weight models only' },
  { id: 'opencode-go',    tool: 'opencode', name: 'OpenCode Go',                      usd_month: null, verified: false, note: 'dollar-capped subscription' },

  // Locally served weights: no bill, and its own tier. The notional
  // hosted-equivalent lives in pricing.ts and is never summed into spend.
  { id: 'local',          tool: 'any',      name: 'Local (self-hosted)',  usd_month: 0 },
  { id: 'api',            tool: 'any',      name: 'API pay-as-you-go',    usd_month: null },
];

export function planById(id: string | null | undefined): Plan | null {
  if (!id) return null;
  return PLANS.find((p) => p.id === id) ?? null;
}

/** Accepts a plan id, or a bare dollar amount for a plan we do not list. */
export function parsePlan(input: string, tool: Tool): { id: string; name: string; usd_month: number | null } | null {
  const known = planById(input);
  if (known) return { id: known.id, name: known.name, usd_month: known.usd_month };
  const m = /^\$?(\d+(?:\.\d+)?)$/.exec(input.trim());
  if (m) return { id: `custom-${m[1]}`, name: `${tool} plan $${m[1]}/mo`, usd_month: Number(m[1]) };
  return null;
}
