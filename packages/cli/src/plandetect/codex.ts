// Codex CLI plan detection.
//
// Verified against the codex-rs source on github.com/openai/codex:
//
//   AuthDotJson       codex-rs/login/src/auth/storage.rs   { auth_mode, OPENAI_API_KEY, tokens, ... }
//   TokenData         codex-rs/login/src/token_data.rs     { id_token, access_token, refresh_token, account_id }
//   IdTokenInfo       codex-rs/login/src/token_data.rs     chatgpt_plan_type, from the
//                                                          "https://api.openai.com/auth" claim
//   PlanType/KnownPlan codex-rs/protocol/src/auth.rs       the exact wire strings mapped below
//   AuthMode          codex-rs/protocol/src/auth.rs        apikey | chatgpt | ...
//
// The id_token is a JWT. Its payload is base64url-decoded locally to read ONE
// claim, `chatgpt_plan_type`. The token string is never returned, logged or
// written, no signature is checked, and nothing is sent anywhere. The sibling
// claims in that same object - chatgpt_account_id, chatgpt_user_id, user_id,
// chatgpt_account_is_fedramp - are never named by any path in this file, and
// the value gate in read.ts would reject them if they were.
//
// Codex also puts `plan_type` on the `RateLimitSnapshot` of the `token_count`
// event in ~/.codex/sessions/**/rollout-*.jsonl. nerfd deliberately does not
// read it: those files interleave the plan with prompt and output text, and
// auth.json answers the same question by opening one small file. See
// docs/PLAN-DETECTION.md.

import { existsSync } from 'node:fs';
import { detected, unknown, type Detection, type Detector } from './types.ts';
import { anyEnvSet, evidenceOf, hasNonEmptyString, pluckEnum, pluckJwtClaim, underHome } from './read.ts';

/**
 * KnownPlan wire strings -> plans.ts ids. Taken verbatim from the serde
 * `rename_all = "lowercase"` enum, including the SKU-shaped business and
 * enterprise variants and the `hc` / `education` aliases. An unrecognised value
 * lands in PlanType::Unknown upstream and is simply not matched here.
 */
const PLAN_CLAIM_TO_ID: Record<string, string | null> = {
  free: 'chatgpt-free',
  go: 'chatgpt-go',
  plus: 'chatgpt-plus',
  pro: 'chatgpt-pro',
  prolite: 'chatgpt-pro-lite',
  team: 'chatgpt-business',
  business: 'chatgpt-business',
  self_serve_business_prolite: 'chatgpt-business',
  self_serve_business_usage_based: 'chatgpt-business',
  ent26: 'chatgpt-enterprise',
  enterprise: 'chatgpt-enterprise',
  hc: 'chatgpt-enterprise',
  enterprise_cbp_automation: 'chatgpt-enterprise',
  enterprise_cbp_usage_based: 'chatgpt-enterprise',
  edu: 'chatgpt-edu',
  education: 'chatgpt-edu',
  edu_plus: 'chatgpt-edu',
  edu_pro: 'chatgpt-edu',
};

const PLAN_CLAIMS = Object.keys(PLAN_CLAIM_TO_ID);

/** AuthMode values that mean "billed per token", not against a subscription. */
const API_AUTH_MODES = [
  'apikey', 'headers', 'agentidentity', 'personalaccesstoken',
  'bedrockapikey', 'bedrockaccesskeys',
];

/** AuthMode values that mean a ChatGPT subscription is in use. */
const SUB_AUTH_MODES = ['chatgpt', 'chatgptauthtokens'];

const ALL_AUTH_MODES = [...API_AUTH_MODES, ...SUB_AUTH_MODES];

export const detectCodex: Detector = ({ home, env }): Detection => {
  const auth = underHome(home, '.codex', 'auth.json');

  // 1. An API key in the environment wins before any file is opened. Name only.
  const envVar = anyEnvSet(env, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'high');

  // 2. auth_mode, which codex persists directly. Comparing it against a fixed
  //    list means an unexpected value is discarded rather than returned.
  const mode = pluckEnum(auth, ['auth_mode'], ALL_AUTH_MODES);
  if (mode && API_AUTH_MODES.includes(mode)) {
    return detected('api', evidenceOf(home, auth, 'auth_mode'), 'high');
  }

  // 3. The plan itself: one claim out of the id_token payload.
  const claim = pluckJwtClaim(
    auth,
    ['tokens', 'id_token'],
    ['https://api.openai.com/auth', 'chatgpt_plan_type'],
    PLAN_CLAIMS,
  );
  const jwtEvidence = evidenceOf(home, auth, 'tokens.id_token → "https://api.openai.com/auth".chatgpt_plan_type');
  if (claim) {
    const id = PLAN_CLAIM_TO_ID[claim];
    if (id) return detected(id, jwtEvidence, 'high');
    return unknown(jwtEvidence);
  }

  // 4. A stored key with no usable token: still API billing.
  if (hasNonEmptyString(auth, ['OPENAI_API_KEY'])) {
    return detected('api', evidenceOf(home, auth, 'OPENAI_API_KEY (present)'), 'high');
  }

  // 5. Logged into ChatGPT, but the claim was missing or unrecognised.
  if (mode && SUB_AUTH_MODES.includes(mode)) return unknown(evidenceOf(home, auth, 'auth_mode'));

  if (existsSync(underHome(home, '.codex'))) return unknown(jwtEvidence);
  return unknown();
};
