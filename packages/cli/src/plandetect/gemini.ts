// Gemini CLI plan detection.
//
// The Code Assist tier (UserTierId: 'free-tier' | 'legacy-tier' |
// 'standard-tier', packages/core/src/code_assist/types.ts in
// google-gemini/gemini-cli) is resolved at runtime by loadCodeAssist /
// onboardUser against Google's Cloud Code API. It is NOT written to disk, so
// there is no local field naming a Google AI Pro or Ultra subscription.
//
// What IS on disk is the auth METHOD, in ~/.gemini/settings.json. That
// separates "billed per token" (an API key, or Vertex) from "signed in with a
// Google account" (which is a plan of some tier we cannot name). Newer versions
// nest it at security.auth.selectedType; older ones use a top-level
// selectedAuthType. Both are checked.
//
// ~/.gemini/google_accounts.json holds the signed-in email address and is never
// opened by nerfd - not even to test whether it exists, because the tier is not
// in it and the only other thing in it is identity.

import { existsSync } from 'node:fs';
import { detected, unknown, type Detection, type Detector } from './types.ts';
import { anyEnvSet, evidenceOf, pluckEnum, underHome } from './read.ts';

const AUTH_TYPES = ['oauth-personal', 'gemini-api-key', 'vertex-ai', 'cloud-shell', 'oauth', 'api-key'];

/** Auth methods that are pay-as-you-go rather than a subscription. */
const API_AUTH = new Set(['gemini-api-key', 'vertex-ai', 'api-key']);

export const detectGemini: Detector = ({ home, env }): Detection => {
  const settings = underHome(home, '.gemini', 'settings.json');

  const envVar = anyEnvSet(env, ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI']);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'high');

  for (const field of [['security', 'auth', 'selectedType'], ['selectedAuthType']]) {
    const v = pluckEnum(settings, field, AUTH_TYPES);
    if (!v) continue;
    const ev = evidenceOf(home, settings, field.join('.'));
    if (API_AUTH.has(v)) return detected('api', ev, 'high');
    // oauth-personal / cloud-shell: a Google account is signed in, so this is a
    // Code Assist tier - free, AI Pro or AI Ultra. Which one is fetched live
    // and never cached locally, so nerfd will not guess.
    return unknown(ev);
  }

  if (existsSync(underHome(home, '.gemini'))) return unknown(evidenceOf(home, settings, 'security.auth.selectedType'));
  return unknown();
};
