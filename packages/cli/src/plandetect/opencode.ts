// OpenCode plan detection.
//
// ~/.local/share/opencode/auth.json is a flat object keyed by provider id, and
// each value is a discriminated union on `type`: "oauth" | "api" | "wellknown"
// (packages/opencode/src/auth/index.ts in sst/opencode). There is no plan or
// tier field anywhere in that schema - it stores credentials only.
//
// So the provider ids themselves are the signal, and they are read as KEYS,
// filtered against a fixed list of known providers. A user-named custom
// provider is not returned, because a custom provider id can be an employer
// name. The credential values under those keys are never touched; only the
// `type` discriminator is read, and only against its three legal values.
//
// The useful inference is delegation: OpenCode signed in to Anthropic or OpenAI
// by OAuth is spending somebody's Claude or ChatGPT subscription, so the plan
// is whatever those tools' own detectors find.

import { detected, unknown, type Detection, type Detector, type ResolvedOpts } from './types.ts';
import { evidenceOf, objectKeys, pluckEnum, pointsAtLocalhost, readableFile, underHome } from './read.ts';
import { detectClaude } from './claude.ts';
import { detectCodex } from './codex.ts';

/** Known provider ids. Anything not on this list is not read back out. */
const KNOWN_PROVIDERS = [
  'opencode', 'opencode-go', 'opencode-zen', 'anthropic', 'openai', 'github-copilot',
  'google', 'google-vertex', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai',
  'zai', 'z-ai', 'zhipuai', 'moonshotai', 'minimax', 'ollama', 'lmstudio', 'llamacpp',
];

const AUTH_TYPES = ['oauth', 'api', 'wellknown'];

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp']);

export const detectOpencode: Detector = (opts: ResolvedOpts): Detection => {
  const { home } = opts;
  const auth = authPath(home);
  const providers = objectKeys(auth, [], KNOWN_PROVIDERS);
  const ev = (field: string) => evidenceOf(home, auth, field);

  // 1. OpenCode's own subscription. Its entry may be `opencode`, `opencode-go`
  //    or `opencode-zen` depending on version; any of them with a non-api type
  //    is the dollar-capped plan.
  for (const id of ['opencode-go', 'opencode-zen', 'opencode']) {
    if (!providers.includes(id)) continue;
    const t = pluckEnum(auth, [id, 'type'], AUTH_TYPES);
    if (t && t !== 'api') return detected('opencode-go', ev(`${id}.type`), 'medium');
  }

  // 2. Locally served weights configured as a provider: its own tier, no bill.
  for (const cfg of configPaths(home)) {
    if (pointsAtLocalhost(cfg, ['provider'])) {
      return detected('local', evidenceOf(home, cfg, 'provider.*.options.baseURL (loopback/private range)'), 'medium');
    }
  }
  if (providers.some((p) => LOCAL_PROVIDERS.has(p))) {
    return detected('local', ev('provider keys (ollama/lmstudio/llamacpp)'), 'medium');
  }

  // 3. Borrowing another tool's subscription by OAuth. The plan is that tool's.
  if (providers.includes('anthropic') && pluckEnum(auth, ['anthropic', 'type'], AUTH_TYPES) === 'oauth') {
    const d = detectClaude(opts);
    if (d.plan_id && d.plan_id !== 'api') return { ...d, confidence: down(d.confidence), evidence: `${ev('anthropic.type')} → ${d.evidence ?? 'claude'}` };
  }
  if (providers.includes('openai') && pluckEnum(auth, ['openai', 'type'], AUTH_TYPES) === 'oauth') {
    const d = detectCodex(opts);
    if (d.plan_id && d.plan_id !== 'api') return { ...d, confidence: down(d.confidence), evidence: `${ev('openai.type')} → ${d.evidence ?? 'codex'}` };
  }

  // 4. Every entry is an API key: pay-as-you-go.
  if (providers.length > 0) {
    const types = providers.map((p) => pluckEnum(auth, [p, 'type'], AUTH_TYPES));
    if (types.length > 0 && types.every((t) => t === 'api')) return detected('api', ev('*.type'), 'medium');
    return unknown(ev('*.type'));
  }

  if (readableFile(auth)) return unknown(ev('*.type'));
  return unknown();
};

function down(c: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' {
  return c === 'high' ? 'medium' : 'low';
}

function authPath(home: string): string {
  return underHome(home, '.local', 'share', 'opencode', 'auth.json');
}

function configPaths(home: string): string[] {
  return [
    underHome(home, '.config', 'opencode', 'opencode.json'),
    underHome(home, '.config', 'opencode', 'config.json'),
  ];
}
