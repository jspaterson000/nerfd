# Model identity reference

Companion to `docs/INTEGRATIONS.md` § "Model identity". Compiled **16 September 2026**.

Machine-readable form: **`packages/core/data/model-families.json`** — 84 families, 465 regex patterns, all
compiling under the `i` flag. This document is the human-readable version plus the parts a JSON schema
cannot carry: naming pitfalls, per-surface id shapes, and what could not be verified.

## How to read the JSON

```jsonc
{
  "generated_at": "2026-09-16",
  "families": [
    {
      "family": "qwen3-coder",        // canonical slug
      "vendor": "alibaba",            // lab that trained the weights
      "display": "Qwen3 Coder",
      "open_weights": true,
      "patterns": ["…"],              // JS regex sources, matched case-insensitively
      "versions": [ { "version": "2507", "patterns": ["…"], "sizes": [], "released": "2025-07" } ],
      "aliases":  { "qwen3-coder-flash": { "version": "flash", "size": "30B-A3B" } },
      "size_patterns": { "480b": "480B-A35B" }   // plain substrings, NOT regexes
    }
  ]
}
```

Contract notes for the resolver:

1. **Patterns are matched twice** — against the raw id as reported, and against the id with a leading
   `org/` segment stripped. Several patterns rely on the stripped form (`meta-llama/llama-4-maverick` →
   `llama-4-maverick`).
2. **Also strip dotted prefixes before the alias lookup.** Bedrock and Vertex prefix with dots and
   `@`, not slashes: `us.anthropic.claude-opus-4-8`, `zai.glm-4.7-flash`, `claude-opus-5@default`.
   Pattern matching survives these; exact-alias lookup does not. **All `aliases` keys are lowercase**,
   so lowercase the id before the lookup.
3. **Families are ordered most-specific-first** in the array and are mutually exclusive on the 1,297
   real ids tested (0 ambiguous matches). Ordering is a safety net, not the primary mechanism — the
   disambiguation is built into the patterns with lookahead/lookbehind (`qwen3` excludes `qwen3-coder`,
   `glm` excludes `glm-*v`, `llama` excludes `*-nemotron`/`hermes-*`/`*-distill-llama`, `gpt-5`
   excludes `*-codex`, `grok` excludes `grok-build`/`grok-code`).
4. **Resolution order within a family**: `aliases` exact match wins, then `versions[].patterns`, then
   `size_patterns` substring scan in declaration order (numeric sizes are declared before word tiers so
   `nemotron-nano-8b` resolves to `8B`, not the `-nano` default).
5. **`sizes` is the grouping axis, not strictly a parameter count.** For open weights it is the real
   count with MoE active params as `480B-A35B`. For closed models the only public differentiator is the
   product tier, so `pro` / `flash` / `mini` / `nano` / `luna` / `sol` / `terra` are used as sizes. The
   board must not present these as parameter counts.

## Coverage

Built from a full enumeration of `https://models.dev/api.json` (217 providers, 7,823 provider-model
rows, 3,712 distinct model ids) and `https://openrouter.ai/api/v1/models` (443 models, with
`canonical_slug` and `hugging_face_id`), cross-checked against vendor docs. Of the 1,297 non-media ids
across the first-party vendor providers plus the coding-agent surfaces (`opencode`, `opencode-go`,
`github-copilot`, `kimi-for-coding`, `zai-coding-plan`, `alibaba-coding-plan`, `minimax-coding-plan`,
`ollama-cloud`, `lmstudio`, `synthetic`, `groq`, `cerebras`, `llama`), **1,271 resolve to a family and
0 are ambiguous**. The 26 that do not are listed under [Not covered](#not-covered).

---

## Anthropic

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `claude-opus` | 5 (2026-07), 4.8 (2026-05), 4.7 (2026-04), 4.6 (2026-02), 4.5 (2025-11), 4.1 (2025-08), 4 (2025-05), 3 (2024-03) | tier only | no |
| `claude-sonnet` | 5 (2026-06), 4.6 (2026-02), 4.5 (2025-09), 4 (2025-05), 3.7 (2025-02), 3.5 (2024-06) | tier only | no |
| `claude-haiku` | 4.5 (2025-10), 3.5 (2024-10), 3 (2024-03) | tier only | no |
| `claude-fable` | 5.1 (2026-09), 5 (2026-06) | tier only | no |
| `claude-mythos` | 5 (2026-06) | tier only | no |

Anthropic does not publish parameter counts for any Claude model.

| Surface | Id form | Examples |
|---|---|---|
| Anthropic API | `claude-<tier>-<major>-<minor>` and dated twin | `claude-opus-5`, `claude-fable-5-1`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001` |
| Claude Code | API id, plus `[1m]` long-context suffix and short aliases | `claude-fable-5-1[1m]`, `claude-opus-5`; `/model opus\|sonnet\|haiku\|fable\|default\|opusplan`, `opus[1m]`, `sonnet[1m]` |
| Bedrock | `<region>.anthropic.claude-…`, older ones keep `-v1:0` | `anthropic.claude-opus-5`, `us.anthropic.claude-opus-4-8`, `global.anthropic.claude-fable-5-1`, `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, `anthropic.claude-opus-4-6-v1` |
| Bedrock region prefixes seen | `us.` `eu.` `apac.` `au.` `jp.` `ca.` `in.` `global.` `us-gov.` | |
| Vertex | `…@<date\|default>` | `claude-opus-5@default`, `claude-opus-4-1@20250805`, `claude-sonnet-4-5@20250929` |
| Azure | bare tier id; **only surface carrying Mythos** | `claude-opus-5`, `claude-mythos-5`, `claude-opus-4-1` |
| OpenRouter | `anthropic/claude-<tier>-<ver>` + `:batch`; canonical slug **inverts tier/version for 4.x** | `anthropic/claude-opus-5` (canonical `anthropic/claude-opus-5-20260723`), `anthropic/claude-opus-4.6` (canonical `anthropic/claude-4.6-opus-20260205`), `anthropic/claude-fable-5.1:batch`, `~anthropic/claude-opus-latest` |
| GitHub Copilot | dots, not dashes | `claude-opus-4.7`, `claude-fable-5.1`, `claude-sonnet-4.6` |
| OpenCode / Zen | `anthropic/claude-opus-5`, `opencode/claude-opus-5` | |

## OpenAI

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `gpt-6` | astra (2026-09) | standard, pro | no |
| `gpt-5` | 5.6 (2026-07), 5.5 (2026-04), 5.4 (2026-03), 5.3 (2026-03, chat only), 5.2 (2025-12), 5.1 (2025-11), 5 (2025-08) | standard, mini, nano, pro, chat; **5.6 ships as luna / sol / terra (+ `-pro`)** | no |
| `gpt-codex` | 5.3-codex + 5.3-codex-spark (2026-02), 5.2-codex (2026-01), 5.1-codex/-max/-mini (2025-11…12), 5-codex (2025-09), codex-mini (2025-05) | standard, max, mini, spark | no |
| `gpt-4` | 4.1 (2025-04), 4o (2024-05), 4-turbo (2023-11), 4 (2023-03) | standard, mini, nano | no |
| `gpt-3-5` | 3.5-turbo (2023-03) | — | no |
| `openai-o` | o4 (2025-04), o3 (2025-04), o1 (2024-12) | standard, mini, pro | no |
| `gpt-oss` | safeguard (2025-10), 1 (2025-08) | 120B-A5.1B, 20B-A3.6B | **yes** (Apache-2.0) |

`gpt-5.6` has no plain `gpt-5.6` endpoint — the release is three sibling ids (`gpt-5.6-luna`,
`gpt-5.6-sol`, `gpt-5.6-terra`) plus `-pro` variants of each. `gpt-5.3` exists only as
`gpt-5.3-codex`, `gpt-5.3-codex-spark` and `gpt-5.3-chat-latest`; there is no general `gpt-5.3`.

| Surface | Id form | Examples |
|---|---|---|
| OpenAI API | bare | `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.4-mini`, `gpt-5.3-codex`, `o4-mini`, `gpt-chat-latest` |
| Codex CLI | `model = "…"` in `~/.codex/config.toml`; picker shows `gpt-6-astra` + GPT-5.6 family | `gpt-6-astra` (observed in this machine's `config.toml`), `gpt-5.3-codex`, `gpt-5.3-codex-spark` |
| Bedrock | `openai.<id>`, region-prefixed | `openai.gpt-6-astra`, `us.openai.gpt-5.6-luna`, `global.openai.gpt-5.6-sol`, `in.openai.gpt-5.6-terra`, `openai.gpt-oss-120b-1:0`, `us-gov.openai.gpt-oss-20b-1:0` |
| Azure | bare, includes `codex-mini`, `model-router` | `gpt-6-astra`, `gpt-5.1-codex-max`, `codex-mini` |
| OpenRouter | `openai/…` + `:batch`; canonical adds date | `openai/gpt-6-astra` (canonical `openai/gpt-6-astra-20260903`), `openai/gpt-5.6-luna-pro:batch`, `~openai/gpt-astra-latest`, `~openai/gpt-luna-latest`, `~openai/gpt-mini-latest` |
| Ollama / LM Studio | gpt-oss only | `gpt-oss:120b`, `gpt-oss:20b`, `openai/gpt-oss-20b` (LM Studio), `openai/gpt-oss-120b` (HF) |
| GitHub Copilot | bare | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.3-codex`, `gpt-5-mini` |

## Google

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `gemini` | 3.8 (2026-09), 3.7 (2026-08), 3.6 (2026-07), 3.5 (2026-05), 3.1 (2026-02), 3 (2025-11), 2.5 (2025-06), 2.0 (2024-12), 1.5 (2024-02) | pro, flash, flash-lite | no |
| `gemma` | 4 (2026-04), 3n (2025-06), 3 (2025-03), 2 (2024-06) | 31B, 26B-A4B, E2B/E4B, 27B, 12B, 4B, 1B | **yes** |

Gemini 3.1 is the newest **Pro**; everything from 3.5 to 3.8 has shipped Flash-tier only. Gemma 4 is
26B-A4B (MoE), 31B (dense) and E2B.

| Surface | Id form | Examples |
|---|---|---|
| Gemini API | bare, `-preview` on unstable tiers | `gemini-3.1-pro-preview`, `gemini-3.8-flash`, `gemini-3.1-flash-lite`, `gemini-flash-latest`, `gemini-flash-lite-latest` |
| Gemini CLI | same ids; `/model` → Manual lists `gemini-3.1-pro-preview`; Auto routes across the 3.x line | |
| Vertex | same ids, no `@date` for Gemini; third-party models get `-maas` | `gemini-3.1-pro-preview`, `qwen/qwen3-235b-a22b-instruct-2507-maas`, `moonshotai/kimi-k2-thinking-maas`, `openai/gpt-oss-120b-maas`, `zai-org/glm-5-maas` |
| Bedrock | Gemma only | `google.gemma-4-26b-a4b`, `google.gemma-4-31b`, `google.gemma-4-e2b` |
| OpenRouter | `google/…` + `:batch`/`:free`; canonical adds date | `google/gemini-3.8-flash` (canonical `…-20260902`), `google/gemma-4-31b-it:free`, `~google/gemini-pro-latest` |
| Ollama | `gemma4:31b` | |

## Moonshot

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `kimi-k3` | k3 (2026-07) | 2.8T-A104B (16 of 896 experts, 1M ctx) | **yes** (Kimi K3 License, MXFP4 checkpoint) |
| `kimi-k2` | k2.7-code (2026-06), k2.6 (2026-04), k2.5 (2026-01), k2-thinking (2025-11), k2-0905 (2025-09), k2 (2025-07) | 1T-A32B (384 experts, top-8 + 1 shared) throughout | **yes** (Modified MIT) |

K2.5, K2.6 and K2.7-Code all keep the K2 1T-A32B architecture; K2.7-Code cuts thinking tokens ~30 %
against K2.6.

| Surface | Id form | Examples |
|---|---|---|
| Moonshot API | `kimi-k<n>` | `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6` |
| Kimi Code CLI | **short ids, not display names** | `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`. Passing `K3` or `K2.8 Preview` fails. `k3-256k` is the same weights at a 256K cap for ~half the quota |
| Bedrock | two spellings coexist | `moonshot.kimi-k2-thinking`, `moonshotai.kimi-k2.5` |
| Azure | `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5` | |
| Vertex | `moonshotai/kimi-k2-thinking-maas` | |
| OpenRouter | `moonshotai/…`; canonical adds date | `moonshotai/kimi-k3` (canonical `…-20260715`, HF `moonshotai/Kimi-K3`), `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2-0905`, `~moonshotai/kimi-latest` |
| Ollama / Synthetic | `kimi-k3`, `kimi-k2.7-code`; `hf:moonshotai/Kimi-K3`, `hf:moonshotai/Kimi-K2.7-Code` | |
| OpenCode / Zen / Go | `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.5`, `kimi-k2-thinking` | |

## Zhipu / Z.ai

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `glm` | 5.3 (2026-08), 5.2 (2026-06), 5.1 (2026-04), 5 (2026-02), 4.7 (2025-12), 4.6 (2025-09), 4.5 (2025-07) | 744B-A40B (GLM-5 line), 320B-A18B (5.3-Flash), 355B-A32B (4.5/4.6/4.7), 106B-A12B (4.5-Air), 30B-A3B (4.7-Flash) | **yes** (weights lag the API by ~2 weeks) |
| `glm-v` | 5v (2026-04), 4.6v (2025-12), 4.5v (2025-08) | turbo, 106B-A12B | yes for 4.x |

| Surface | Id form | Examples |
|---|---|---|
| Z.ai / Zhipu API | `glm-<ver>[-tier]` | `glm-5.3`, `glm-5.3-flash`, `glm-5-turbo`, `glm-4.7-flashx`, `glm-4.5-air` |
| Coding plan | adds `-highspeed` | `glm-5.3-highspeed`, `glm-5.2-highspeed` |
| Bedrock | `zai.glm-…` | `zai.glm-5`, `zai.glm-4.7-flash` |
| Vertex | `zai-org/glm-5-maas`, `zai-org/glm-4.7-maas` | |
| OpenRouter | `z-ai/glm-…` + `:free`/`:batch`; HF `zai-org/GLM-…` | `z-ai/glm-5.3` (canonical `…-20260816`), `z-ai/glm-5.2:free`, `~z-ai/glm-latest`, `~z-ai/glm-flash-latest` |
| NVIDIA NIM | `z-ai/glm-5.2`, `z-ai/glm-5.3-flash` | |
| Mistral(!) | resells as `zai-glm-5-2` — a rare cross-vendor id | |
| Ollama / Synthetic | `glm-5.3`, `glm-5.3-flash`; `hf:zai-org/GLM-5.2`, `hf:zai-org/GLM-4.7-Flash` | |

## DeepSeek

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `deepseek-v4` | v4.1-flash (2026-09), v4-pro (2026-04), v4-flash (2026-04) | 1.6T-A49B (Pro), 284B-A13B (Flash), 8B/16B active (V4.1 Flash) | **yes** |
| `deepseek-v3` | v3.2 (2025-12), v3.1 (2025-08), v3-0324 (2025-03), v3 (2024-12) | 685B-A37B, 671B-A37B | yes |
| `deepseek-r1` | r1-0528 (2025-05), r1 (2025-01) | 671B-A37B + Llama/Qwen distills 70B…1.5B | yes |

| Surface | Id form | Examples |
|---|---|---|
| DeepSeek API | `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-flash` (= V4.1 Flash), plus the legacy pointers `deepseek-chat` and `deepseek-reasoner` | |
| Bedrock | `deepseek.r1-v1:0`, `deepseek.v3-v1:0` (**labelled V3.1**), `deepseek.v3.2` | |
| Vertex | `deepseek-ai/deepseek-v3.2-maas` | |
| Azure | `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3.2-speciale` | |
| OpenRouter | `deepseek/deepseek-v4-pro-0813`, `deepseek/deepseek-v4-flash-0731`, `deepseek/deepseek-chat-v3-0324`, `~deepseek/deepseek-pro-latest` | |
| Ollama | `deepseek-v4-pro:0813`, `deepseek-v4-flash:0731`, `deepseek-v4.1-flash` | |

## Alibaba / Qwen

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `qwen3-coder` | next (2026-02), 2507 (2025-07), plus/flash aliases | 480B-A35B, 30B-A3B | **yes** |
| `qwen3` | 3.8 (2026-08), 3.7 (2026-05), 3.6 (2026-04), 3.5 (2026-02), next (2025-09), 3-2507 (2025-07), 3 (2025-04) | 2.4T-A95B, 397B-A17B, 235B-A22B, 122B-A10B, 80B-A3B, 35B-A3B, 32B, 30B-A3B, 27B, 14B, 9B, 8B, 4B, 1.7B, 0.6B; plus max/plus/flash/turbo tiers | mixed |
| `qwen2-5-coder` | 2.5 (2024-11) | 32B…0.5B | yes |
| `qwen2-5` | 2.5 (2024-09) | 72B…3B | yes |
| `qwq` | qwq-32b, qvq-max (2025-03) | 32B | yes |
| `qwen-legacy` | commercial (2024-01) | max, plus, turbo, flash | no |

`-max` / `-plus` / `-flash` are closed hosted tiers; the numbered `NNB` ids are the open weights.
`qwen3.8-max` is closed at ~4T params, while `qwen3.8-2.4t-a95b` is its open-weight sibling.

| Surface | Id form | Examples |
|---|---|---|
| Alibaba Model Studio | `qwen3-coder-plus`, `qwen3-coder-flash`, `qwen3.7-max`, `qwen3.8-flash`, `qwen3-coder-480b-a35b-instruct` | |
| Qwen Code CLI | Model Studio ids; coding plan bundles others | `qwen3-coder-plus`, `qwen3-coder-next`, `qwen3.7-max` |
| Alibaba coding plan | also serves rival weights under Alibaba ids | `kimi-k2.5`, `glm-5`, `MiniMax-M2.5`, `qwen3-max-2026-01-23` |
| Bedrock | `qwen.qwen3-coder-480b-a35b-v1:0`, `qwen.qwen3-coder-next`, `qwen.qwen3-next-80b-a3b` | |
| OpenRouter | `qwen/qwen3-coder` (canonical `qwen/qwen3-coder-480b-a35b-07-25`, HF `Qwen/Qwen3-Coder-480B-A35B-Instruct`), `qwen/qwen3.8-2.4t-a95b`, `qwen/qwen3.5-397b-a17b` | |
| Ollama / LM Studio | `qwen3-coder:30b-a3b-q4_K_M`, `qwen/qwen3-coder-30b`, `qwen/qwen3-30b-a3b-2507`, `qwen3.5:397b` | |
| Groq / Cerebras | `qwen/qwen3.8-27b`, `qwen-3.8-27b` | |

## MiniMax

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `minimax-m` | m3 (2026-06), m2.7 (2026-03), m2.5 (2026-02), m2.1 (2025-12), m2 (2025-10), m1 (2025-06) | 428B-A23B (M3), 229B-A10B (M2.7), 230B-A10B (M2/M2.1/M2.5), 456B-A45B (M1) | **yes** (modified MIT) |

Id casing is inconsistent: MiniMax's own API and the coding plan use `MiniMax-M2.5`; Bedrock, OpenRouter,
Ollama and OpenCode all lowercase it. Patterns are case-insensitive, so this only matters for exact
alias lookups.

| Surface | Examples |
|---|---|
| MiniMax API / coding plan | `MiniMax-M3`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5` |
| Bedrock | `minimax.minimax-m3`, `minimax.minimax-m2.1` |
| OpenRouter | `minimax/minimax-m3` (HF `MiniMaxAI/Minimax-M3`), `minimax/minimax-m2-her` |
| Ollama / OpenCode | `minimax-m3`, `minimax-m2.5-free` |

## Meta

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `llama` | 4 (2025-04), 3.3 (2024-12), 3.2 (2024-09), 3.1 (2024-07), 3 (2024-04), 2 (2023-07) | 400B-A17B (Maverick), 109B-A17B (Scout), 405B, 90B, 70B, 11B, 8B, 3B, 1B | **yes** |
| `muse` | spark-1.3 (2026-09), spark-1.2 (2026-08), spark-1.1 (2026-04), glimmer (2026-08) | standard, contributor; Glimmer 30B dense | Spark **no**, Glimmer **yes** |

Meta Superintelligence Labs' current line is **Muse**, not Llama. Muse Spark is API-only; Muse Glimmer
30B is the open, distilled sibling. The `-contributor` ids are a separate (cheaper, data-sharing) tier,
not a size.

| Surface | Examples |
|---|---|
| Meta API / OpenRouter | `meta/muse-spark-1.3`, `meta/muse-spark-1.3-contributor`, `meta/muse-glimmer-30b` (HF `meta-models/Muse-Glimmer-30B`) |
| Bedrock | `meta.llama4-maverick-17b-instruct-v1:0`, `us.meta.llama3-3-70b-instruct-v1:0` |
| Vertex | `meta/llama-4-maverick-17b-128e-instruct-maas` |
| OpenRouter / HF | `meta-llama/llama-4-maverick` (HF `meta-llama/Llama-4-Maverick-17B-128E-Instruct`) |
| Llama API provider | `llama-4-maverick-17b-128e-instruct-fp8`, `cerebras-llama-4-scout-17b-16e-instruct`, `groq-llama-4-maverick-17b-128e-instruct` |

**`17b` in a Llama 4 id is the active parameter count, not the model size.** Maverick is 400B-A17B and
Scout is 109B-A17B; both carry `17b` in the id. The JSON maps on `maverick`/`scout`, not on `17b`.

## Mistral

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `devstral` | 2512 (2025-12), 2507 (2025-07), 2505 (2025-05) | 123B (Devstral 2), 24B (Small) | **yes** |
| `codestral` | 2508 (2025-08), 2501 (2025-01), 22b (2024-05) | 22B | no (22B weights were released) |
| `mistral-large` | 3 / 2512 (2025-12), 2411, 2407 | 675B-A41B (Large 3), 123B | yes |
| `mistral-medium` | 3.5 / 2604 (2026-04), 3.1 / 2508, 3 / 2505 | 128B | Medium 3.5 yes |
| `mistral-small` | 4 / 2603 (2026-03), 3.2 / 2506, 3.1 / 2503, 3 / 2501 | 119B-A12B (Small 4), 24B | yes |
| `ministral` | 3 / 2512 (2025-12), 1 (2024-10) | 14B, 8B, 3B | yes |
| `magistral` | 1.2 / 2509, 1.1 / 2507, 1 / 2506 | 24B, medium | Small yes |
| `mixtral` | 8x22b (2024-04), 8x7b (2023-12) | 141B-A39B, 46.7B-A12.9B | yes |
| `mistral-nemo` | 2407 (2024-07) | 12B | yes |
| `mistral-7b` | v0.3 (2024-05) | 7B | yes |

Mistral versions by `YYMM` date code, and the marketing name drifts from it: `mistral-large-2512` is
"Mistral Large 3", `mistral-small-2603` is "Mistral Small 4", `devstral-2512` is "Devstral 2".
Confusingly `mistral-large-2411` is "Mistral Large 2.1".

| Surface | Examples |
|---|---|
| Mistral API | `devstral-2512`, `devstral-latest`, `mistral-large-latest`, `codestral-latest`, `labs-devstral-small-2512` |
| Bedrock | `mistral.devstral-2-123b`, `mistral.mistral-large-3-675b-instruct`, `mistral.ministral-3-8b-instruct` |
| OpenRouter / HF | `mistralai/devstral-2512` (HF `mistralai/Devstral-2-123B-Instruct-2512`), `mistralai/mistral-small-2603` (HF `mistralai/Mistral-Small-4-119B-2603`) |

## xAI

| Family | Versions (released) | Sizes | Open weights |
|---|---|---|---|
| `grok` | 4.6 (2026-08), 4.5 (2026-07), 4.3 (2026-04), 4.20 (2026-03), 4.1 (2025-12), 4 (2025-07), 3 (2025-02) | reasoning / non-reasoning / multi-agent / fast / mini | no |
| `grok-code` | fast-1 (2025-08) | — | no |
| `grok-build` | 0.1 (2026-04) | — | no |

**`grok-4.20` sorts below `grok-4.3` in a naive string compare but is older** — it is "four point twenty",
released 2026-03. Reasoning mode is baked into the id on several surfaces
(`grok-4.20-0309-reasoning`, `grok-4-1-fast-non-reasoning`).

| Surface | Examples |
|---|---|
| xAI API | `grok-4.6`, `grok-4.20-0309-reasoning`, `grok-4.20-multi-agent-0309`, `grok-build-0.1` |
| Bedrock | `xai.grok-4.6`, `us.xai.grok-4.6`, `xai.grok-4.3` |
| Vertex | `xai/grok-4.1-fast-reasoning`, `xai/grok-4.20-non-reasoning` |
| Azure | dashes for minors: `grok-4-20-reasoning`, `grok-4-1-fast-non-reasoning`, `grok-4.6` |
| OpenRouter | `x-ai/grok-4.6`, `x-ai/grok-4.20-multi-agent`, `~x-ai/grok-latest` |
| OpenCode Zen | `grok-code` (free tier), `grok-4.5`, `grok-build-0.1` |

## Cohere, NVIDIA, Microsoft, IBM, Amazon, Writer, Perplexity

| Family | Vendor | Versions (released) | Sizes | Open weights |
|---|---|---|---|---|
| `command-a` | cohere | plus-05-2026, translate-08-2025, reasoning-08-2025, vision-07-2025, 03-2025 | 111B, 32B | yes |
| `command-r` | cohere | r7b-12-2024, r-plus-08-2024, r-08-2024 | 104B, 32B, 7B | yes |
| `north` | cohere | 1.0 (2026-06) | — | yes |
| `aya` | cohere | vision (2025-03), expanse (2024-10) | 32B, 8B | yes |
| `nemotron` | nvidia | 3.5 (2026-08), 3 (2025-12), 2 (2025-08), 1.5 / 1 (2025-03) | 550B-A55B (Ultra), 120B-A12B (Super), 30B-A3B (Nano/Lightning), 253B, 49B, 12B, 9B | yes |
| `phi` | microsoft | 4 (2024-12), 3 (2024-04) | 14B, 3.8B | yes |
| `mai` | microsoft | code-1.1 (2026-08), code-1 (2026-06) | flash | no |
| `granite` | ibm | 4.2 (2026-08), 4.1 (2026-04), 4.0 (2025-10), 3 (2024-10) | 32B-A9B, 8B, 7B-A1B, 3B | yes |
| `nova` | amazon | 2 (2025-12), 1 (2024-12) | premier, pro, lite, micro | no |
| `palmyra` | writer | x5 (2025-04), x4 (2024-10) | — | no |
| `sonar` | perplexity | pro-search, deep-research, reasoning-pro, pro, sonar | — | no |

Nemotron 3 renamed the tiers into the id (`nemotron-3-ultra-550b-a55b`), while Bedrock kept the old
shape (`nvidia.nemotron-super-3-120b`, `nvidia.nemotron-nano-3-30b`). Both forms resolve.
Cohere's `north-mini-code` is the coding-agent model; it appears on OpenCode Zen as `north-mini-code-free`.

## Other Chinese labs

| Family | Vendor | Versions (released) | Sizes | Open weights |
|---|---|---|---|---|
| `hunyuan` | tencent | hy4 (2026-08), hy3 (2026-07), hy-mt2 (2026-05), a13b (2025-06) | 770B-A49B, 295B-A21B (192 experts, top-8), 30B-A3B, 7B, 1.8B | yes |
| `seed` | bytedance | 2.1 (2026-08), 2.0 (2026-02), 1.6 (2025-06), oss (2025-09) | code, pro, lite, mini, turbo, 36B | Seed-OSS only |
| `mimo` | xiaomi | v2.5 (2026-04), v2 (2026-03) | standard, pro, flash, omni | yes |
| `ernie` | baidu | 5.1 (2026-05), 5.0 (2026-01), 4.5 (2025-06) | 424B-A47B, 300B-A47B | 4.5 yes |
| `ling` | inclusionai | 3.0 (2026-07), 2.6 (2026-05) | 124B-A5.5B | yes |
| `ring` | inclusionai | 2.6 (2026-05), 1T (2025-10) | 1T | yes |
| `longcat` | meituan | 2.0 (2026-07) | A48B of ~1T | yes |
| `step` | stepfun | 3.7 (2026-05), 3.5 (2026-02), 3 (2025-07) | flash | yes |
| `kat-coder` | kwai | pro-v2.5 (2026-07), pro-v2 (2026-03), pro-v1 (2025-11) | pro, air | no |

Tencent's new ids are `hy3` / `hy4-preview`, not `hunyuan-*`; both spellings resolve to `hunyuan`.
ByteDance uses `doubao-seed-*` on Volcengine and `seed-*` everywhere else.

## Western startups

| Family | Vendor | Versions (released) | Sizes | Open weights |
|---|---|---|---|---|
| `inkling` | thinking-machines | 1 (2026-07) | 975B-A41B, 276B-A12B (Small) | yes |
| `laguna` | poolside | 2.1 (2026-07), m.1 (2026-04) | 118B-A8B (S), 33B-A3B (XS) | yes |
| `trinity` | arcee | large (2026-01), mini (2025-12) | large, mini | yes |
| `fugu` | sakana | max (2026-09), ultra-v2 (2026-09), ultra (2026-06), namazu (2026-08) | — | no |
| `mercury` | inception | 2.5 (2026-09), 2 (2026-03), coder (2025-02) | small | no |
| `morph` | morph | v3 (2025-07) | large, fast | no |
| `relace` | relace | apply-3 (2026-02), search (2025-12) | — | no |
| `lfm` | liquid | 2.5 (2026-08), 2 (2026-01) | 2.6B, 24B-A2B | yes |
| `reka` | reka | edge (2026-03), flash-3 (2025-03) | 21B | yes |
| `hermes` | nous-research | 4 (2025-08), 3 (2024-08) | 405B, 70B, 8B | yes |
| `sarvam` | sarvam | 2 (2026-02), m (2025-07) | 105B, 30B, 24B | yes |
| `solar` | upstage | pro4 (2026-08), pro3 (2026-01), pro2 (2025-05) | — | no |
| `aion` | aion-labs | 3.0 (2026-07), 2.0 (2026-02) | standard, mini | no |
| `nex-n` | nex-agi | n2.5 (2026-09) | pro, mini | yes |
| `dots` | dots-studio | 3 (2026-08) | note | no |

## Agent-tool in-house models and routers

| Family | Vendor | Versions | Notes |
|---|---|---|---|
| `cursor-composer` | cursor | 2 (2026-03), 1 (2025-10) | Cursor's own agent model. **Not in models.dev or OpenRouter** — patterns are inferred from the product name (`composer`, `composer-1`, `composer-2`, `cursor-small`); confirm against a real `~/.cursor/chats/<id>/store.db` row before trusting. |
| `windsurf-swe` | cognition | 2 (2026-05), 1.5 (2025-10), 1 (2025-05) | Same caveat — id form inferred (`swe-1`, `swe-1.5`, `swe-2`). |
| `big-pickle` | unknown | stealth (2026-04) | OpenCode Zen stealth models: `big-pickle`, `omen-alpha`, `ox-alpha-free`, `x-preview-f-free`. Vendor deliberately undisclosed. Never attribute these to a lab. |
| `openrouter-auto` | openrouter | router | `openrouter/auto`, `openrouter/fusion`, `openrouter/pareto-code`, `openrouter/bodybuilder`, `openrouter/free`, Azure `model-router`. These pick a different model per request — a session tagged with one of these has **no** meaningful model identity and must not be aggregated into a family row. |

**OpenCode Zen** (`opencode/` provider) resells 102 models under bare ids with a `-free` suffix for the
free tier: `claude-opus-5`, `gpt-6-astra`, `kimi-k3`, `glm-5.3`, `grok-code`, `qwen3-coder`,
`minimax-m3-free`, `nemotron-3-ultra-free`, `big-pickle`, `hy3-free`, `north-mini-code-free`,
`laguna-s-2.1-free`, `trinity-large-preview-free`. **OpenCode Go** (`opencode-go/`) is the
dollar-capped subscription with a 36-model subset and no `-free` suffixes.

---

## Naming pitfalls

**Date suffixes.** Four incompatible conventions, all live:
- Anthropic API: `-YYYYMMDD` (`claude-sonnet-4-5-20250929`).
- Vertex: `@YYYYMMDD` or `@default` (`claude-opus-4-1@20250805`, `claude-opus-5@default`).
- Mistral: `YYMM` with no separator, and it doubles as the version (`devstral-2512`, `mistral-small-2603`).
- Chinese labs: `MMDD` (`kimi-k2-instruct-0905`, `deepseek-v4-pro-0813`, `grok-4.20-0309-reasoning`).
Strip the date before alias lookup; keep it for the ledger, because `deepseek-v4-pro` and
`deepseek-v4-pro-0813` are different checkpoints of the same version.

**`-latest` and `~` pointers.** `claude-opus-latest`, `gemini-flash-latest`, `mistral-large-latest`,
`codestral-latest`, `kimi-latest`, `deepseek-flash-latest`. OpenRouter marks these with a leading tilde
in the org segment: `~anthropic/claude-opus-latest`, `~openai/gpt-astra-latest`, `~z-ai/glm-latest`,
`~x-ai/grok-latest`. **A `-latest` id resolves to a family but not to a reproducible version.** Record
`version: "latest"` and resolve the concrete version from the session's end date against the release
table, or leave it unresolved — never silently assume the newest.

**OpenRouter variant suffixes.** `:free`, `:batch`, `:nitro`, `:floor`, `:online`, `:thinking`,
`:extended`. These change routing, price and sometimes the reasoning budget, never the weights. Strip
into `ModelRef.variant`. `:thinking` additionally appears with a token budget in models.dev rows
(`anthropic/claude-opus-4.1:thinking:8192`).

**OpenRouter canonical slugs are not stable in shape.** For Claude 4.x the canonical inverts tier and
version (`anthropic/claude-opus-4.6` → `anthropic/claude-4.6-opus-20260205`) but for Claude 5 it does
not (`anthropic/claude-opus-5` → `anthropic/claude-opus-5-20260723`). Match on the served `id`, use
`canonical_slug` only to recover the date.

**Bedrock and Vertex prefixes.** Bedrock prepends a region/scope segment with a dot:
`us.` `eu.` `apac.` `au.` `jp.` `ca.` `in.` `global.` `us-gov.`, then the vendor (`anthropic.`,
`openai.`, `qwen.`, `zai.`, `minimax.`, `moonshot.` / `moonshotai.`, `deepseek.`, `nvidia.`, `meta.`,
`mistral.`, `writer.`, `xai.`, `google.`, `amazon.`), and older models keep a `-v1:0` suffix. The
region is a routing choice, not identity — put it in `ModelRef.provider`, not `family`. Vertex uses
`@date` and a `-maas` suffix for third-party weights (`qwen/qwen3-235b-a22b-instruct-2507-maas`).

**Azure uses dashes where the vendor uses dots.** `grok-4-20-reasoning` for `grok-4.20-reasoning`,
`claude-opus-4-1` for `claude-opus-4.1`. Azure is also the only catalogued surface carrying
`claude-mythos-5`.

**GitHub Copilot uses dots where Anthropic uses dashes.** `claude-opus-4.7` vs `claude-opus-4-7`,
`claude-fable-5.1` vs `claude-fable-5-1`.

**Claude Code's `[1m]` suffix.** `claude-fable-5-1[1m]`, `opus[1m]`, `sonnet[1m]` select the 1M-token
context tier at a different price. The brackets are literal and will break a naive regex — strip them
into `size`/`variant`. Observed live in `~/.claude/settings.json` on this machine.

**Ollama quant tags.** `<model>:<size>-<quant>`: `qwen3-coder:30b-a3b-q4_K_M`, `gpt-oss:120b`,
`gemma4:31b`, `nemotron-3-nano:30b`, `qwen3.5:397b`, `deepseek-v4-pro:0813`. A bare `:latest` or no tag
means the default quant, which is **not** the same weights as the fp16 checkpoint — quant belongs in
`ModelRef.quant`, not in `size`. `/api/show` returns the exact tag.

**LM Studio / Hugging Face repo ids.** `lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF`,
`unsloth/Kimi-K2.7-Code-GGUF`, `bartowski/...-GGUF`, `mlx-community/Qwen3.5-27B-4bit`,
`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8`. The trailing `-GGUF`, `-AWQ`, `-FP8`, `-MXFP4`,
`-BF16`, `-4bit`, `-8bit` is quantisation, and the leading org is the **repackager**, not the lab:
`unsloth/Kimi-K3-GGUF` is Moonshot's weights. Resolve `vendor` from the family, `provider` from the
serving runtime, and never from the HF org.

**Synthetic.new prefixes every id with `hf:`.** `hf:moonshotai/Kimi-K3`, `hf:zai-org/GLM-5.2`.

**Codex internal names.** `gpt-5.6-luna` / `-sol` / `-terra` are three distinct released models, not
internal codenames — but OpenAI ships no plain `gpt-5.6`, so a tool that logs "GPT-5.6" has lost
information. `gpt-5.3-codex-spark` is a separate, cheaper model from `gpt-5.3-codex`. Codex retired
`gpt-5.4` and `gpt-5.4-mini` on 2026-08-31, remapping saved configs to `gpt-5.6-terra` and
`gpt-5.6-luna` — sessions from before that date may carry ids the current picker no longer offers.

**Kimi Code rejects display names.** The CLI accepts `k3`, `k3-256k`, `kimi-for-coding`,
`kimi-for-coding-highspeed` only; `K3` or `K2.8 Preview` fail. `kimi-for-coding` is a *plan* id that
points at whatever Moonshot currently serves for the coding subscription — treat it like `-latest`.

**`-highspeed` / `-fast` / `-turbo` are serving tiers, not weights.** `kimi-k2.7-code-highspeed`,
`MiniMax-M2.5-highspeed`, `glm-5.3-highspeed`, `glm-5-turbo`. Same weights, different throughput and
price. They belong in `variant`, but the JSON maps them to `size` where the vendor gives no other
differentiator — the board should not split a family on these.

**Modified weights.** Community fine-tunes append or embed a marker: `abliterated`, `uncensored`,
`heretic`, `derestricted`, `dolphin`, `unslop`, `magnum`, `hermes`, `euryale`, `lunaris`, `cydonia`,
`skyfall`, `venice-edition`, `-rp`. Real examples in the catalogues: `qwen38-27b-abliterated`,
`Qwen3.5-27B-Queen-Derestricted`, `Qwen3.5-27B-BlueStar-v3-Derestricted`,
`TEE/qwen3.6-35b-a3b-uncensored`, `cognitivecomputations/Dolphin-Mistral-24B-Venice-Edition`,
`Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled`. The family and size still resolve from the base
name; set `modified: true` and keep the row out of family tiers, per `INTEGRATIONS.md`.

**Distills are a different model from their base.** `deepseek-r1-distill-llama-70b` is DeepSeek's
weights, not Meta's; `Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled` is Google's weights, not
Anthropic's; `nvidia/llama-3.3-nemotron-super-49b` is NVIDIA's, not Meta's. The patterns encode this —
`llama` refuses to match anything containing `nemotron`, anything preceded by `distill`, and anything
inside a `hermes-*` or `aion-rp-*` id.

**Two models can share a number across labs.** `glm-5.2` is served by Z.ai, Zhipu, NVIDIA NIM,
OpenRouter, Ollama Cloud, OpenCode *and* by Mistral as `zai-glm-5-2`. `deepseek-v4-flash` is served by
DeepSeek, Ollama Cloud, NVIDIA, OpenCode Zen and OpenRouter. The family is the same; the provider and
quantisation are not, which is the whole point of the provider board.

**Version strings do not sort.** `grok-4.20` (2026-03) predates `grok-4.3` (2026-04).
`gemini-3.1-pro` (2026-02) is newer than `gemini-3-pro` but older than `gemini-3.8-flash` — and is
still the *only* Pro tier, so "3.8 > 3.1" does not mean "better model". Sort by `released`, never by
the version string.

---

## Not covered

Documented gaps rather than silent ones.

**Unmatched ids in the catalogues (26).** Deliberate, not bugs:
- Roleplay/creative fine-tunes with no base-model marker in the id, and out of scope for a coding
  scorecard: `sao10k/l3.3-euryale-70b`, `sao10k/l3-lunaris-8b`, `thedrummer/cydonia-24b-v4.1`,
  `thedrummer/skyfall-36b-v2`, `thedrummer/unslopnemo-12b`, `gryphe/mythomax-l2-13b`,
  `undi95/remm-slerp-l2-13b`, `mancer/weaver`, `microsoft/wizardlm-2-8x22b`,
  `abacusai/dracarys-llama-3.1-70b-instruct`.
- Non-LLM NVIDIA models that slipped the media filter: `nvidia/bevformer`, `nvidia/gliner-pii`,
  `nvidia/sparsedrive`, `nvidia/streampetr`.
- `mistralai/mistral-saba` / `-2502` — a regional Mistral variant with no published size; no family
  created for a single id.

**Parameter counts not published.** Anthropic (all Claude), OpenAI (all except gpt-oss), Google
(Gemini), xAI (all Grok), Amazon Nova, Writer Palmyra, Perplexity Sonar, Sakana Fugu, Upstage Solar,
Inception Mercury, Cursor Composer, Windsurf SWE, Microsoft MAI, Kwaipilot KAT Coder, ByteDance Seed
(non-OSS), Qwen `-max`/`-plus`/`-flash` tiers, `qwen3.7-max` (Alibaba has not disclosed dense vs MoE).
These carry tier names in `sizes`.

**Conflicting size figures — recorded value flagged.**
- **GLM-5.3**: recorded as `744B-A40B` (the GLM-5 line's architecture, per `github.com/zai-org/GLM-5`).
  Artificial Analysis lists GLM-5.3 (max) at **753B**-A40B and one secondary source at 744B. Not
  resolved; treat the total as ±10B.
- **MiniMax M2.7**: `229B-A10B` per NVIDIA's technical blog, `230B` per the Hugging Face card. Recorded
  as 229B-A10B for M2.7 and 230B-A10B for M2/M2.1/M2.5.
- **DeepSeek V4.1 Flash**: "activates 8B parameters on input and 16B on [output]" — an asymmetric
  scheme with no single active-param figure. Recorded as `A8B-A16B`, total not published.
- **Kimi K3**: 2.8T total / 104B active / 16-of-896 experts is consistent across secondary sources but
  was not verified against a Moonshot technical report.
- **Meituan LongCat 2.0**: 48B active "out of 1.x T" — the total was truncated in the OpenRouter
  description and is recorded as `A48B`.

**Release dates.** `released` is the **first public availability month**, taken from models.dev
`release_date` where present. Where surfaces disagree (Bedrock lists Claude Opus 4.6 at 2026-02-05,
models.dev at 2026-02-04; Claude Fable 5 at 2026-06-09 on Bedrock vs 2026-06-07 on the Anthropic API)
the vendor-API date wins. Open-weight *drops* often lag the API launch — GLM-5.3 shipped API-only on
2026-08-14 and the weights ~2 weeks later; Kimi K3 was hosted 2026-07-16 and open 2026-07-26. Only the
first date is recorded.

**Could not verify at all:**
- **Cursor Composer** and **Windsurf SWE** raw id strings. Neither appears in models.dev or OpenRouter.
  The patterns are inferred from product naming and are the least trustworthy in the file. Confirm
  against `~/.cursor/chats/<id>/store.db` and a real Windsurf session before publishing rows for them.
- **Sourcegraph Amp** has no model picker and reports no model id — consistent with `INTEGRATIONS.md`
  marking it "cannot report a model". No family created.
- **OpenCode Zen stealth models** (`big-pickle`, `omen-alpha`, `ox-alpha-free`, `x-preview-f-free`,
  `hy3-free` aliasing, `trinity-large-preview-free`). Vendor undisclosed by design; `vendor` is
  `unknown` for `big-pickle` and these must never be attributed to a lab on the board.
- **Gemini CLI's default model id** for v0.60 specifically. The `/model` picker exposes
  `gemini-3.1-pro-preview` and an "Auto (Gemini 3)" router; which concrete id Auto selects is not
  documented, so a Gemini CLI session logging "Auto" has the same problem as `openrouter/auto`.
- **Qwen Code's** own model list beyond the Model Studio ids — the free tier shut in April 2026 and the
  docs were not re-checked.
- **Kimi K2.7-Code's** expert count (384, top-8 + 1 shared) is inherited from the K2 architecture per
  secondary sources; Moonshot's card was not read directly.

## Sources

- https://models.dev/api.json — 217 providers, primary id enumeration
- https://openrouter.ai/api/v1/models — `id`, `canonical_slug`, `hugging_face_id`, context limits
- https://code.claude.com/docs/en/model-config — Claude Code aliases
- https://www.kimi.com/code/docs/en/kimi-code/models — Kimi Code model ids
- https://opencode.ai/docs/zen/ — OpenCode Zen model list and `opencode/<id>` form
- https://ai.google.dev/gemini-api/docs/models and https://geminicli.com/docs/get-started/gemini-3/
- https://codex.danielvaughan.com/2026/09/03/gpt-6-astra-codex-cli-configuration-context-notes-safety/ — Codex CLI `gpt-6-astra`
- https://github.com/zai-org/GLM-5 and https://artificialanalysis.ai/models/glm-5-3 — GLM-5 sizes
- https://huggingface.co/moonshotai/Kimi-K2.7-Code and https://www.morphllm.com/kimi-k3 — Kimi sizes
- https://huggingface.co/MiniMaxAI/MiniMax-M2.7 and https://developer.nvidia.com/blog/minimax-m2-7-advances-scalable-agentic-workflows-on-nvidia-platforms-for-complex-ai-applications/
- https://www.morphllm.com/minimax-m3 — MiniMax M3 428B-A23B
- https://artificialanalysis.ai/models/comparisons/deepseek-v4-pro-vs-qwen3-7-max — DeepSeek V4 Pro 1.6T-A49B
- `~/.claude/settings.json` and `~/.codex/config.toml` on this machine — live `claude-fable-5-1[1m]` and `gpt-6-astra` id forms
