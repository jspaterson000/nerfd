// GitHub Copilot CLI plan detection - another documented refusal.
//
// GitHub's own reference for ~/.copilot/ describes config.json as "automatically
// managed application state (authentication, installed plugins, other internal
// data)" and lists no plan or tier field anywhere in that directory.
//
// The plan IS available as `copilot_plan` from GET /copilot_internal/user on
// api.github.com, but reaching it means sending a GitHub token. nerfd does not
// transmit a credential to learn a display field, and does not make network
// calls outside the share path. So no file under ~/.copilot/ is opened.
//
// Declare it instead: `nerfd plan copilot copilot-pro`.

import { detected, unknown, type Detection, type Detector } from './types.ts';
import { anyEnvSet } from './read.ts';

export const detectCopilot: Detector = ({ env }): Detection => {
  // A model API key in the environment means per-token billing rather than a
  // Copilot seat. A GITHUB_TOKEN does NOT, so it is deliberately not listed.
  const envVar = anyEnvSet(env, ['COPILOT_API_KEY']);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'medium');
  return unknown();
};
