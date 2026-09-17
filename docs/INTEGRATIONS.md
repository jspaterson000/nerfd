# Integrations plan: OpenCode, Kimi Code, open-weight models, and the rest

Researched 16 September 2026. Three research passes plus direct inspection of OpenCode's and Gemini CLI's data on this machine. Items marked *unverified* came from docs or secondary sources and must be confirmed against a live install before a parser is written.

## Status, one line per tool

Nine adapters ship. `nerfd init` installs whichever of them it finds; `nerfd backfill [tool] --since 90d` imports the history that predates the install for every one of them. The adapter registry is [`packages/cli/src/adapters/registry.ts`](../packages/cli/src/adapters/registry.ts).

| Tool | Status | What is live |
|---|---|---|
| **Claude Code** | built | eight hooks merged into `~/.claude/settings.json`, transcript ledger, turns for behavioural signals, backfill from `~/.claude/projects/**`. |
| **Codex** | built, backfill-first | hooks in `~/.codex/hooks.json`, which Codex silently skips until they are trusted in `/hooks` (trust is a hash under `[hooks.state]` in `config.toml`; `nerfd doctor` reports `untrusted`). The Codex app and the Codex view in the ChatGPT app have no `/hooks` screen but write the same `rollout-*.jsonl` (originator `Codex Desktop` or `codex_work_desktop`, source `vscode`), so backfill covers them. `rollout-*.jsonl` ledger with its directly reported rate-limit window, turns, backfill. |
| **OpenCode** | built | a JS plugin in `~/.config/opencode/plugins/` that shells out to `nerfd hook opencode` on the event bus, plus the SQLite ledger and backfill from `~/.local/share/opencode/`. |
| **Goose** | built | twelve hooks in `~/.agents/plugins/nerfd/hooks/hooks.json` (no `*` matcher — it is silently skipped), the `usage_ledger` table for tokens and cost, turns, backfill. |
| **Gemini CLI** | built | hooks in `~/.gemini/settings.json`, JSONL ledger and turns from `~/.gemini/tmp/<project>/chats/session-*.jsonl`, backfill. The OTel stream is deliberately not read: its attributes include `user.email`. |
| **Qwen Code** | built | hooks in `~/.qwen/settings.json` on versions that have the hook system, backfill-only below it (and `nerfd init` says which); same JSONL lineage as Gemini, so one parser covers both. Its chat files are never written to: it uses writer-lease fencing. |
| **Kimi Code** | built | TOML hooks merged into `~/.kimi-code/config.toml`, including `Interrupt` and `StopFailure`, the `wire.jsonl` ledger, backfill. |
| **Crush** | built, one live event | the only hook Crush has is `PreToolUse`, installed; everything else comes from the per-project `./.crush/crush.db` ledger and the registry in `~/.local/share/crush/projects.json` at backfill time. |
| **Copilot CLI** | built, backfill-first | hooks live in `~/.copilot/hooks/*.json` (one file per hook, which is how Copilot reads them); the model, tokens and errors come from the `~/.copilot/session-state/<id>/events.jsonl` ledger and backfill. |
| **Cline** | backfill only | no hooks exist; `~/.cline/data/sessions/<id>/` and the extension's `globalStorage/tasks/<id>/` are read by ledger and backfill. |
| **Aider** | backfill only | emits nothing live, and `normalise()` returns null so nothing claiming to be an aider event is scored; `--analytics-log` JSONL is read by ledger and backfill. |
| **Droid, Kilo Code, Cursor CLI** | pending | plan detection knows about Droid; no adapter yet. Build when demand appears. |
| **Amp, Roo Code** | not planned | Amp cannot report a model; Roo Code was archived in May 2026. |

Everything below is the research the adapters were built from, kept as written.

## What changes

Today nerfd knows two tools and one identity for a model. Both assumptions break the moment open-weight models enter:

1. **Every tool is different, but they all split the same way.** Live events (hooks or a plugin) give session boundaries, tool calls, errors and interrupts, keyed on a session id, and never carry token counts. Tokens, cost and the model actually used live in the tool's transcript or SQLite store. The adapter layer must budget for both paths for every tool.
2. **"Which model" is not one string.** Kimi K2.7-code on OpenRouter is served at fp4 by one host and int4 by another, with a 14x spread in output limit and different tool-calling support. Moonshot's own vendor verifier found tool-call schema accuracy ranging from 100% to materially worse across hosts of the same weights. A local Qwen at q4_K_M is not the Qwen on Cerebras. The scorecard has to key on model **and** provider **and** quantisation, or it will average things that are not the same.

The second point is the opportunity. Nobody runs a public board that says "Kimi K2.7 via Groq versus via Moonshot versus local q4, with tool-call failure rate and cost per successful session, from real sessions". OpenRouter ranks by tokens routed, Artificial Analysis prices per host but scores per model, and Moonshot's verifier is a single-family README last updated November 2025.

## Model identity

Every session carries a `ModelRef`, resolved locally at session end and sent in the public record:

| Field | Meaning | Example |
|---|---|---|
| raw_id | exactly what the tool reported | `qwen38-27b-abliterated` |
| raw_provider | the tool's provider id | `qwen38-runpod` |
| family | normalised weights family | `qwen3-coder`, `kimi`, `glm`, `claude-opus` |
| version | release or date tag | `k2.7-code`, `2507`, `5` |
| size | parameter count where public | `480B-A35B`, `27B` |
| quant | quantisation or `unknown` | `fp8`, `int4`, `q4_K_M`, `awq-int4` |
| provider | who served it | `anthropic`, `groq`, `deepinfra`, `moonshot`, `ollama`, `vllm-self` |
| serving_mode | `hosted`, `plan`, `local` | `local` |
| variant | routing variant if any | `:nitro`, `:floor` |
| modified | true for abliterated, uncensored, fine-tuned or merged weights | `true` |

Resolution order, best evidence first:

1. **Catalogue match.** The tool's `provider/model` id is looked up in a vendored models.dev snapshot, which already flags `open_weights`, names the family, and lists the coding-plan providers. Hosted first-party models resolve here.
2. **OpenRouter endpoint join.** For `openrouter/*` ids, the `/api/v1/models/{slug}/endpoints` response gives per-host quantisation, context limit, output limit and tool-choice support. The session's chosen host is not always visible from the tool, so v1 records the slug plus variant and the endpoint table as of that week; per-host attribution comes from the response headers where the tool exposes them (OpenCode's `chat.headers` hook can capture the provider header on the way back, *unverified*).
3. **Local runtime probe.** For OpenAI-compatible base URLs on localhost or a private host, ask the runtime: `GET /v1/models` on vLLM and llama.cpp returns the served model path, and Ollama's `/api/show` returns the exact tag with quant suffix. The user's own config on this machine declares "Qwen 3.8 27B Abliterated AWQ INT4" only in a human-readable name field, so a name parser for `awq`, `int4`, `q4_K_M`, `fp8`, `abliterated`, `uncensored`, `heretic` is the fallback.
4. **User declaration.** `nerfd model-info <raw_id> --family qwen3 --size 27B --quant awq-int4 --modified` for anything the above cannot resolve. Stored locally and re-applied to future sessions.

Family-level tiers on the public board include only `modified: false` weights. Modified weights are shown under their own row so the user still gets a personal scorecard, but they never dilute the family number.

## Pricing and plans

- **Catalogue.** Vendor `https://models.dev/api.json` weekly with a fetched-at date. It is the source OpenCode itself uses, covers 217 providers including `lmstudio`, `ollama-cloud`, `openrouter`, `groq`, and the coding-plan providers (`kimi-for-coding`, `zai-coding-plan`, `minimax-coding-plan`, `alibaba-coding-plan`, `opencode-go`) at zero per-token cost, which is exactly the signal for plan mode. LiteLLM's price JSON is the fallback for gaps. Sessions are priced against the snapshot in force when they ended, never a live table.
- **Provider layer.** OpenRouter's public endpoints API for per-host quant, limits and tool support. No auth needed.
- **Local models.** Billed cost is zero and `serving_mode: local` is its own plan tier. Alongside it, a notional **hosted-equivalent** figure prices the same tokens at the cheapest hosted endpoint of the same family and size. It answers "what did running this locally save me", it is auditable, and it is never summed into spend. Hardware amortisation is not attempted: the collector cannot see the GPU, duty cycle or power price, so any dollars-per-hour number would be invented.
- **New plans** for `plans.ts`, with the prices that were verifiable and the rest flagged: Kimi Code membership (Moderato $19, Allegretto $39, Allegro $99, Vivace $199; per-tier credits *unverified*), Z.ai GLM Coding (Lite $18; Pro and Max *unverified*), MiniMax Token Plan (Plus $22, Max $55, Ultra $132; the $10/$20/$50 figures in circulation are 2025 launch prices), Alibaba Model Studio Coding Plan (about $28, bundles Qwen, Kimi, GLM and MiniMax behind one endpoint), Synthetic.new ($30, open-weight only), OpenCode Go (dollar-capped subscription). DeepSeek has no subscription and stays pay-as-you-go.
- **Stale names to fix in the pricing table now.** The current frontier open models are Kimi K3 and K2.7-code, GLM-5.3, MiniMax M3, DeepSeek V4 Pro and DeepSeek Flash, Qwen 3.7. The catalogue will carry these; the hand-written table should stop naming versions at all and defer to the snapshot.

## Tools, in priority order

Priority is extension surface quality times user base, weighted toward tools that carry open-weight models, since that is the gap. Effort is a rough size for the adapter given the shared machinery below.

| # | Tool | Live events | Ledger (tokens, cost, model) | Slash command | Open-weight relevance | Effort | Notes |
|---|---|---|---|---|---|---|---|
| 1 | **OpenCode** 1.18 | JS plugin: `event` bus (`session.idle`, `session.error`, `session.interrupt`, `message.updated`), `chat.message` with provider and model, `tool.execute.after` | SQLite `~/.local/share/opencode/opencode.db`: per-session cost, tokens split input, output, reasoning, cache read and write, diff line counts, per-message latency and abort errors. `opencode export` too. Verified locally. | `~/.config/opencode/commands/nerfd.md` | High: any OpenAI-compatible endpoint, Ollama, LM Studio, OpenRouter, Zen | S | No shell hooks; the adapter is a 40-line plugin that shells out to `nerfd`. Cost is zero for custom providers, so recompute from tokens. Installed here. |
| 2 | **Goose** 1.50 (Linux Foundation) | 12 hooks in `~/.agents/plugins/<name>/hooks/hooks.json`; `*` matcher is invalid and silently skips | SQLite `~/.local/share/goose/sessions/sessions.db` with a **usage_ledger** per LLM call carrying model, tokens, cost and cost provenance. Best ledger surveyed. Native OTLP and Langfuse. | recipes | Very high: about 60 providers including zai, minimax, moonshot, deepseek, ollama, lmstudio | S | Repo moved to `aaif-goose/goose`, docs at goose-docs.ai. Governance is neutral, which matters for a "no lab money" project. |
| 3 | **Gemini CLI** 0.60 | 11 hooks including `BeforeModel`/`AfterModel` with the request model; every hook has `session_id` and `transcript_path` | JSONL `~/.gemini/tmp/<project>/chats/session-*.jsonl` with `model` and `tokens` per message. Verified locally. | TOML in `~/.gemini/commands/` | Low: Gemini and Gemma only | S | Largest user base of the surveyed tools. Do not use its OTel path: common attributes include `user.email`. |
| 4 | **Kimi Code CLI** 0.43 | 20 hooks in TOML including `SessionStart` with model, `Interrupt`, `StopFailure`, `SessionHeartbeat` | `wire.jsonl` carries model, provider and per-call usage (verified against the shipped source). The local REST API only runs under `kimi web` and needs a bearer token, so it is not used | Agent Skills in `~/.agents/skills/` | High: Kimi K3 and K2.x, any OpenAI-compatible endpoint, models.dev import | M | The old `kimi-cli` is end-of-life; target `@moonshot-ai/kimi-code` (148k npm downloads a month and rising). Its plugin marketplace is a distribution channel. Its quota API gives the subscription-value numbers directly. |
| 5 | **Qwen Code** 0.23 | 21 Claude-style hooks with an `http` executor that can POST straight to the ingest endpoint | JSONL under `~/.qwen/projects/<cwd>/chats/` with `model` and `usageMetadata`; same lineage as Gemini CLI so one parser covers both | Markdown in `~/.qwen/commands/` | High: Qwen, GLM, Kimi, MiniMax through Alibaba's plan | XS after Gemini | Free tier shut in April 2026, user base declining. Never write to its JSONL: it uses writer-lease fencing. |
| 6 | **GitHub Copilot CLI** | 14 hooks with `transcriptPath` | `~/.copilot/session-state/<id>/events.jsonl` | `/model`, `/usage` | None: no BYOK | S | Highest volume (about 10M npm downloads a month). Worth it for closed-model coverage, not for this brief. |
| 7 | **Crush** 0.94 | One hook, `PreToolUse`, with a Claude-Code-compatible payload | Per-project SQLite `./.crush/crush.db` with `sessions.prompt_tokens`, `completion_tokens`, `cost` and `messages.model`, `provider`; registry at `~/.local/share/crush/projects.json` | skills | High: Ollama, OpenRouter first-class | S | Ledger only, no session-end event; the adapter polls the registry from `nerfd check`. |
| 8 | **Cline** CLI and extension | SDK `onEvent` with a `usage` event; no shell hooks | `~/.cline/data/sessions/<id>/` and the extension's `tasks/<id>/` with tokens, cache and cost | none | Medium | S | Scrape-only backfill. |
| 9 | **Kilo Code** | Claude-style hooks and a TS plugin API | *unverified* | *unverified* | Medium | M | Confirm session storage before building. |
| 10 | **Factory Droid** | `Pre/PostToolUse` hooks, `droid exec -o json` | `./.factory/sessions/` | | High: documented BYOK for Qwen, Kimi, OpenRouter, Ollama | S | Small base, strong open-weight cohort. |
| 11 | **Aider** 0.86 | none | `aider --analytics-disable --analytics-log <file>` writes JSONL with models, tokens and cost and sends nothing | none | High | XS | 424k PyPI downloads a month on a repo with no maintainer activity since May. Harvest via backfill, do not invest. |
| 12 | **Cursor CLI** | hooks exist but do not all fire | `~/.cursor/chats/<id>/store.db`, token columns *unverified* | | Low | | Defer. |
| skip | **Amp** | toolboxes only | cloud threads, no model picker | | none | | Cannot report a model. |
| skip | **Roo Code** | | | | | | Archived May 2026. |

## Shared machinery

Three things get built once and reused by every adapter.

- **Adapter interface.** `{ id, detect(), install(), uninstall(), onEvent(input), ledger(sessionId) -> LedgerFacts, backfill(since) -> Session[] }`. `ledger` returns model refs, token split, cost if the tool computed one, per-message latency, aborts and tool errors. `backfill` reads the tool's store and creates sessions for history that predates the install. Backfill matters: an OpenCode or Goose user gets a populated personal scorecard the minute they install, and the public board gets months of open-model history on day one.
- **Event normaliser.** Hook payloads from Claude Code, Codex, Gemini, Qwen, Kimi, Copilot, Goose, Droid and Crush are all JSON on stdin with a session id and an event name. One dispatcher maps their names onto the existing handler (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `SessionEnd`, plus new `Interrupt`). OpenCode is the exception and gets a JS plugin that emits the same JSON to `nerfd hook opencode`.
- **Model resolver and price snapshot** as described above, in `packages/core`, used identically by the CLI and the server. Both ship a dated snapshot in the release tarball and refresh weekly.

`~/.agents/` is emerging as a cross-tool convention: Kimi reads `~/.agents/skills/`, Goose puts hooks in `~/.agents/plugins/` and uses `.agents/` in projects, Crush reads a sibling path, and AGENTS.md is now a foundation project. Shipping the hooks and the `/ms` skill as one `~/.agents/` package could cover several tools with a single install step. Worth adopting once Goose and Kimi are in.

## New public metrics for open-weight models

These are derivable from session reports with no benchmark harness and are the headline of the provider board:

- **Tool-call error rate.** Share of tool calls the model emitted that failed to parse or violated the schema. This is the metric Moonshot's verifier uses and the one that differs most between hosts.
- **Context-limit hits.** Sessions where the tool compacted or errored on context. Hosts differ by 14x on output limits.
- **Cost per successful session by provider**, and hosted-equivalent for local.
- **Latency by provider**, already collected.

Schema changes: `Report` gains `model_ref` (the table above) and `metrics.tool_call_errors`, `metrics.context_limit_hits`. `Row` aggregation gains `provider` and `quant` group keys.

## Order of work

1. **Shared machinery** (adapter interface, event normaliser, model resolver, models.dev snapshot, new schema fields). About two days.
2. **OpenCode**: plugin, ledger reader, backfill from the local database. Half a day, and it is installed here with real open-model sessions to test on.
3. **Gemini CLI and Qwen Code**: one JSONL parser, hook install for both. Half a day.
4. **Goose**: hooks in `~/.agents/plugins`, `usage_ledger` reader, backfill. Half a day. Then the `~/.agents/` shared package.
5. **Kimi Code**: TOML hooks, REST usage and quota reader, plan tiers. One day, including verifying the wire log.
6. **Provider board** on the site: model by provider by quant, tool-call error rate, hosted-equivalent. One day.
7. **Backfill-only adapters**: Crush, Cline, Aider, Copilot. A day for the set.
8. Kilo, Droid, Cursor as demand appears.

## Corrections to earlier assumptions

- Model names in this repo's pricing table and seed data are behind: the current families are Kimi K3 and K2.7-code, GLM-5.3, MiniMax M3, DeepSeek V4 Pro and Flash, Qwen 3.7. The catalogue snapshot replaces the hand-written table.
- The Kimi tool to target is `@moonshot-ai/kimi-code`, not `kimi-cli`.
- Goose is a Linux Foundation project now, not Block's, and its repo moved.
- Cost figures stored by OpenCode are zero for user-declared providers, so cost must always be recomputed from tokens and the snapshot.

## Risks specific to this scope

- **Self-declared local models.** A user can name a local model anything. The runtime probe and the name parser reduce this, and `modified: true` weights are kept out of family tiers, but local rows will always carry more noise than hosted ones. Show `serving_mode` on every row.
- **Provider attribution through routers.** OpenRouter picks the host per request. Until the response header is captured, an `openrouter/*` row means "some host", and the board must say so.
- **Format churn.** Every ledger format here is internal to its tool. Each reader is wrapped, logged and version-gated, and hook data remains primary.
- **Privacy in other tools' telemetry.** Gemini CLI's OTel attributes include the user's email. nerfd reads the JSONL and never the OTel stream.
- **Dead or dying tools.** Aider and Roo Code are not worth live integrations; Qwen Code is declining. Backfill readers cost little and are the right level of investment.
