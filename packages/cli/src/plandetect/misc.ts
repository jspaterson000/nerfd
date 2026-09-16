// The tools with no subscription concept, or no local record of one.
//
//   goose  - fully bring-your-own-key. There is no Goose subscription, so the
//            plan is always `api` or, when the provider is a local runtime,
//            `local`. That makes it one of the few tools detection can answer
//            with real confidence.
//   qwen   - ~/.qwen/oauth_creds.json is tokens only. The free OAuth tier was
//            never a named enum on disk and was discontinued in April 2026.
//   crush  - crush.json holds provider config and keys; no tier field.
//   droid  - Factory plans (Pro/Plus/Max/Teams/Enterprise) are account-level and
//            enforced server-side; nothing under ~/.factory/ names one.
//
// For the last three, only the environment is inspected, by variable name. No
// credentials file is opened, because none of them contains an answer.

import { detected, unknown, type Detection, type Detector } from './types.ts';
import { anyEnvSet, evidenceOf, pluckYamlScalar, pointsAtLocalhost, underHome } from './read.ts';

/** Provider ids that mean weights are served on this machine or a private host. */
const LOCAL_PROVIDERS = ['ollama', 'lmstudio', 'llama-cpp', 'llamacpp', 'local'];

const GOOSE_PROVIDERS = [
  ...LOCAL_PROVIDERS, 'anthropic', 'openai', 'google', 'groq', 'openrouter',
  'databricks', 'bedrock', 'azure_openai', 'gcp_vertex_ai', 'venice', 'xai', 'sagemaker_tgi',
];

export const detectGoose: Detector = ({ home, env }): Detection => {
  const cfg = underHome(home, '.config', 'goose', 'config.yaml');

  const envProvider = (env['GOOSE_PROVIDER'] ?? '').trim().toLowerCase();
  if (LOCAL_PROVIDERS.includes(envProvider)) return detected('local', 'env GOOSE_PROVIDER', 'high');

  const provider = pluckYamlScalar(cfg, 'GOOSE_PROVIDER', GOOSE_PROVIDERS);
  if (provider) {
    const ev = evidenceOf(home, cfg, 'GOOSE_PROVIDER');
    // Goose has no subscription tier at all, so the only two answers are the
    // right two answers.
    return detected(LOCAL_PROVIDERS.includes(provider) ? 'local' : 'api', ev, 'high');
  }

  if (pointsAtLocalhost(cfg, [])) return detected('local', evidenceOf(home, cfg, 'host (loopback/private range)'), 'medium');
  if (GOOSE_PROVIDERS.some((p) => envProvider === p)) return detected('api', 'env GOOSE_PROVIDER', 'high');
  return unknown();
};

export const detectQwen: Detector = ({ env }): Detection => {
  const envVar = anyEnvSet(env, ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY']);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'medium');
  return unknown();
};

export const detectCrush: Detector = ({ env }): Detection => {
  const envVar = anyEnvSet(env, ['CRUSH_API_KEY']);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'medium');
  return unknown();
};

export const detectDroid: Detector = ({ env }): Detection => {
  const envVar = anyEnvSet(env, ['FACTORY_API_KEY']);
  if (envVar) return detected('api', `env ${envVar} (set)`, 'medium');
  return unknown();
};
