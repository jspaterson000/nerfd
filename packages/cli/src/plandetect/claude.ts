// Claude Code plan detection.
//
// Order of resolution mirrors Claude Code's own documented authentication
// precedence (https://code.claude.com/docs/en/authentication), so that a
// machine with both an API key and a logged-in subscription is reported the way
// the tool will actually bill it:
//
//   cloud provider vars > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY
//   > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN > subscription OAuth
//
// The one field worth reading is `claudeAiOauth.subscriptionType` in
// ~/.claude/.credentials.json. On macOS that file usually does NOT exist:
// the official doc says credentials go to the encrypted login Keychain and the
// file is only the fallback for when the Keychain write is rejected. nerfd will
// not call `security` to fetch it, because that raises a system password prompt
// - a worse privacy event than the one detection is trying to solve. On those
// machines detection falls back to "a subscription is logged in, tier unknown".
//
// Nothing here can distinguish Max 5x from Max 20x. See docs/PLAN-DETECTION.md.

import { existsSync } from 'node:fs';
import { detected, unknown, type Detection, type Detector } from './types.ts';
import { anyEnvSet, evidenceOf, hasNonEmptyString, hasObject, pluckDate, pluckEnum, readableFile, underHome } from './read.ts';

/** Values reported for `subscriptionType`, mapped to plans.ts ids. */
const TIER_TO_PLAN: Record<string, string | null> = {
  pro: 'claude-pro',
  max: 'claude-max',          // 5x vs 20x is not in this field. See RATE_LIMIT_TIER.
  team: 'claude-team',
  enterprise: 'claude-enterprise',
  free: null,                 // Claude Code is not usable on the free tier.
};

const TIERS = Object.keys(TIER_TO_PLAN);

/**
 * A rate-limit tier field is the only thing that could separate Max 5x from
 * Max 20x, both of which report `subscriptionType: "max"`.
 *
 * UNCONFIRMED. No Anthropic documentation describes this field, and the
 * web research for docs/PLAN-DETECTION.md could not corroborate it against a
 * primary source. It is read here speculatively because doing so is free and
 * fail-safe: the value must be one of the strings below to be used at all, and
 * anything else - including the field being absent, which is the expected case
 * - falls through to `subscriptionType`. If the field turns out not to exist,
 * this lookup silently does nothing. It is never reported as high confidence.
 */
// Confirmed on a real install (Sep 2026): a Max subscription carries
// rateLimitTier "default_claude_max_5x", which is what separates 5x from 20x.
const RATE_LIMIT_TIER: Record<string, string> = {
  default_claude_pro: 'claude-pro',
  default_claude_max_5x: 'claude-max-5x',
  default_claude_max_20x: 'claude-max-20x',
  default_claude_team: 'claude-team',
};

const RATE_LIMIT_TIERS = Object.keys(RATE_LIMIT_TIER);

/**
 * The third key this detector is allowed to name inside `oauthAccount`, beside
 * the two tier fields: when the subscription was created. It is a date, not an
 * identity - it says nothing about who the account belongs to - and it exists
 * here for one job: imported history that predates nerfd has no plan on it, and
 * a session that ended after this date was on this subscription. Claude Code
 * writes no end date, so the period is open-ended, which is the truth for a
 * subscription that is still running. It goes through the date gate in read.ts
 * and never leaves the machine; only the plan id and the word `assumed` do.
 * The identity keys in the same object (emailAddress, fullName, displayName,
 * organizationName, accountUuid, organizationUuid) are still never named.
 */
const CREATED_AT = ['oauthAccount', 'subscriptionCreatedAt'];

/** Any of these means the session is billed per token, not against a plan. */
const API_ENV = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
] as const;

export const detectClaude: Detector = ({ home, env }): Detection => {
  const dir = underHome(home, '.claude');

  // 1. Environment. Highest precedence in Claude Code, so highest here. Only
  //    the NAME of the variable is used; the value is never read.
  const envVar = anyEnvSet(env, API_ENV);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'high');

  // 2. apiKeyHelper in settings.json: a script that mints a key, so also API.
  //    Presence only - the command string could contain a path and is not read.
  for (const f of ['settings.json', 'settings.local.json']) {
    const p = underHome(dir, f);
    if (hasNonEmptyString(p, ['apiKeyHelper'])) {
      return detected('api', evidenceOf(home, p, 'apiKeyHelper (present)'), 'high');
    }
  }

  // 3. The precise tier from the account profile in ~/.claude.json, which
  //    Claude Code refreshes on every login (profileFetchedAt). Seen on a real
  //    Max 20x install (Sep 2026): organizationRateLimitTier
  //    "default_claude_max_20x" while the credentials blob below still said
  //    "default_claude_max_5x" from an expired token issued before an upgrade.
  //    So the profile wins, and the credentials tier is only a fallback.
  //    Only these two tier keys are read; the identity keys in the same
  //    object (emailAddress, fullName, displayName, organizationName,
  //    accountUuid, organizationUuid) are never named by any path here.
  const dotJson = underHome(home, '.claude.json');
  for (const field of [['oauthAccount', 'userRateLimitTier'], ['oauthAccount', 'organizationRateLimitTier']]) {
    const v = pluckEnum(dotJson, field, RATE_LIMIT_TIERS);
    if (v) return { ...detected(RATE_LIMIT_TIER[v]!, evidenceOf(home, dotJson, field.join('.')), 'high'), ...activePeriod(dotJson) };
  }

  // 4. The rate-limit tier in the credentials file. Can lag an upgrade, so
  //    medium confidence; the CLI prints the tier so a person can correct it.
  const creds = underHome(dir, '.credentials.json');
  const rlt = pluckEnum(creds, ['claudeAiOauth', 'rateLimitTier'], RATE_LIMIT_TIERS);
  if (rlt) {
    return { ...detected(RATE_LIMIT_TIER[rlt]!, evidenceOf(home, creds, 'claudeAiOauth.rateLimitTier'), 'medium'), ...activePeriod(dotJson) };
  }

  // 4. The subscription tier itself, from the credentials file.
  const sub = pluckEnum(creds, ['claudeAiOauth', 'subscriptionType'], TIERS);
  if (sub) {
    const id = TIER_TO_PLAN[sub];
    const ev = evidenceOf(home, creds, 'claudeAiOauth.subscriptionType');
    // "max" is genuinely ambiguous: same string on $100 and $200. Reported as
    // claude-max at medium confidence so the CLI can ask for one `nerfd plan`.
    if (id) return { ...detected(id, ev, id === 'claude-max' ? 'medium' : 'high'), ...activePeriod(dotJson) };
    return unknown(ev);
  }

  // 5. ~/.claude.json organizationType, as a fallback for the keychain case
  //    when no tier field was present above. The value gate in read.ts
  //    rejects an email or a uuid even if a path ever named one.
  const seat = pluckEnum(dotJson, ['oauthAccount', 'organizationType'], TIERS);
  if (seat) {
    const id = TIER_TO_PLAN[seat];
    const ev = evidenceOf(home, dotJson, 'oauthAccount.organizationType');
    if (id) return detected(id, ev, 'low');
    return unknown(ev);
  }

  // 6. Keychain-only machine (the normal case on macOS). An oauthAccount object
  //    existing at all means a subscription login happened, which rules out
  //    API billing but names no tier. Its presence is tested without reading
  //    any key inside it.
  if (hasObject(dotJson, ['oauthAccount'])) {
    return unknown(evidenceOf(home, dotJson, 'oauthAccount (present; tier is in the macOS keychain, not read)'));
  }

  // 7. A CLAUDE_CODE_OAUTH_TOKEN is a long-lived subscription token; again a
  //    subscription, again no tier.
  if (anyEnvSet(env, ['CLAUDE_CODE_OAUTH_TOKEN'])) {
    return unknown('env CLAUDE_CODE_OAUTH_TOKEN (set; names no tier)');
  }

  if (readableFile(creds) || existsSync(dir)) return unknown(evidenceOf(home, creds, 'claudeAiOauth.subscriptionType'));
  return unknown();
};

/**
 * When this subscription started. Claude Code records no end date, so
 * `active_until` is null: the subscription is open-ended until something says
 * otherwise, which is what a live plan is.
 */
function activePeriod(dotJson: string): { active_from: string | null; active_until: string | null } {
  return { active_from: pluckDate(dotJson, CREATED_AT), active_until: null };
}
