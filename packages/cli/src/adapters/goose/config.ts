import { gooseConfigPath } from './paths.ts';
import { readSimpleYaml, yamlMap, yamlString } from './yaml.ts';

// Reading model identity out of `config.yaml`. Verified against
// crates/goose/src/config/providers.rs: the active provider is
// `active_provider`, per-provider settings live in a `providers:` map keyed by
// provider name with `{ enabled, model, configured }`, the bare model name is
// in `model` and the provider is a separate field. `GOOSE_PROVIDER` and
// `GOOSE_MODEL` in the environment win over the file, and flat
// `GOOSE_PROVIDER`/`GOOSE_MODEL` keys inside the file are read for
// compatibility with configs written before the structured block.
//
// Base URLs are not in the providers map. Each provider declares its own
// config key (crates/goose-providers/src), and those keys sit at the top level
// of config.yaml or in the environment. That is what makes a local Qwen on
// lmstudio distinguishable from the same weights on a hosted endpoint, which
// is the whole reason the field exists.

/** provider name -> the config/env key that carries its endpoint. */
const HOST_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_HOST'],
  openai: ['OPENAI_BASE_URL', 'OPENAI_HOST'],
  openrouter: ['OPENROUTER_HOST'],
  google: ['GOOGLE_HOST'],
  databricks: ['DATABRICKS_HOST'],
  snowflake: ['SNOWFLAKE_HOST'],
  azure_foundry: ['AZURE_FOUNDRY_ENDPOINT'],
  ollama: ['OLLAMA_HOST'],
};

/** Local runtimes whose default endpoint is worth recording even unset. */
const LOCAL_DEFAULTS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
};

export interface GooseConfigFacts {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
}

export function readGooseConfig(path: string | null = gooseConfigPath()): GooseConfigFacts {
  const cfg = path ? readSimpleYaml(path) : {};
  const provider = process.env.GOOSE_PROVIDER?.trim()
    || yamlString(cfg.active_provider)
    || yamlString(cfg.GOOSE_PROVIDER);

  const providers = yamlMap(cfg.providers);
  const entry = provider ? yamlMap(providers?.[provider]) : null;
  const model = process.env.GOOSE_MODEL?.trim()
    || yamlString(entry?.model)
    || yamlString(cfg.GOOSE_MODEL);

  return { provider: provider || null, model: model || null, baseUrl: baseUrlFor(provider, cfg) };
}

/** The endpoint the named provider would use, from env, then file, then a local default. */
export function baseUrlFor(provider: string | null | undefined, cfg: Record<string, unknown>): string | null {
  if (!provider) return null;
  const name = provider.toLowerCase();
  for (const key of HOST_KEYS[name] ?? []) {
    const fromEnv = process.env[key]?.trim();
    if (fromEnv) return fromEnv;
    const fromFile = yamlString(cfg[key] as never);
    if (fromFile) return fromFile;
  }
  // A custom or declarative provider can name its own key; try the obvious ones.
  const upper = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  for (const key of [`${upper}_BASE_URL`, `${upper}_HOST`]) {
    const v = process.env[key]?.trim() || yamlString(cfg[key] as never);
    if (v) return v;
  }
  return LOCAL_DEFAULTS[name] ?? null;
}
