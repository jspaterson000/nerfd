# Privacy

This is the privacy statement for the `nerfd` CLI and the public board at nerfd.ai. It is written to be read by a developer in five minutes and by a security reviewer in fifteen. It is versioned in the repo that builds both the collector and the server, so it can be diffed against the code that implements it.

Short version: nerfd measures *how a session went*, never *what the session was about*. Prompts, code, file paths, repo names and notes stay on your machine. One HTTPS endpoint receives one small JSON object per session, and only if you left sharing on. `nerfd privacy` shows you that exact object before you believe any of this.

---

## What is collected and sent

When sharing is on, one JSON record is sent per finished session. Every field, and why it exists:

| Field | What it is |
|---|---|
| `report_id` | hash of your install id and the session id. Lets a rating update the same record instead of creating a second one. |
| `reporter_id` | rotating hash of your install id. Deduplicates and rate-limits one person's sessions within a week. Not an account, not derived from anything about you. |
| `client_version` | the nerfd version that produced the record. |
| `tool`, `tool_version` | which coding agent, and its version. The whole point of the project is separating a model change from a harness change, and this is the field that does it. |
| `model`, `effort` | the model id the tool reported, and its reasoning effort level. A raw id is sent only when it resolves in the vendored catalogue; anything else is replaced by the identity derived from it (family, size, serving mode, quant), because a custom id names your employer. |
| `model_ref` | which weights, served by whom, at what precision: `family`, `version`, `size`, `quant`, `provider`, `serving_mode` (hosted/plan/local/router), `variant`, `modified`, plus `raw_id` and `raw_provider` **only when they resolve in the catalogue** — for anything served locally, `raw_provider` is replaced by the runtime nerfd inferred (`ollama`, `llama.cpp`), never the name you gave your own box. This is the provider board: same weights, different host. |
| `plan_id`, `plan_usd_month` | your subscription tier, and its **list** price from the published plan table — never a dollar amount you typed. Powers "what did $200 actually buy". |
| `plan_source` | one word: `declared` (you ran `nerfd plan`), `detected` (read off the tool's own config on this machine), or `unknown`. The file and field a detector opened stay local; see "What the plan detector opens" below. That word and `plan_id` are the entire public surface of detection. |
| `week`, `ended_at` | the ISO week, and when the session ended, floored to the hour in UTC. |
| `category`, `size` | task type (code, debug, refactor, …) inferred from your first prompt locally, and a small/medium/large bucket. The prompt itself does not leave. |
| `repo` | language name from a fixed list, a size bucket (s/m/l by tracked file count), and an age bucket (greenfield/established). Not the repo name, not the path, not the remote. |
| `duration_s` | how long the session lasted. |
| `metrics` | counts only: prompts, turns, tool calls, edits, files touched, tests run, errors, rate-limit hits, timeouts, model switches, interrupts, `tool_call_errors` (tool calls the model emitted that failed to parse or violated the schema — the number that differs most between hosts of the same weights), `context_limit_hits` (a compaction or a context-length error), token totals, latency p50/p95, and the subscription-window usage percentage where the tool reports it. |
| `signals`, `signal_version` | behavioural signals, computed locally from a transcript already on your disk and reduced to integers before they can leave: corrections, reprompts, frustration, pushback, clarifications, edits without a prior read, retries, test failures before a pass, turns to first success, steering and thinking ratios, an `abandoned` boolean, and the user/assistant turn counts they are divided by. **Counts and the rates derived from them, nothing else** — the type has no string field, and the server rejects a record with a string anywhere inside it. `signal_version` says which version of the detectors produced them. Full method, including the false positives: [SIGNALS.md](SIGNALS.md). |
| `rating`, `kept` | your optional 1-5 rating and whether you kept the work. Absent unless you typed them. |
| `survival_ratio` | the share of lines the session added that were still in the working tree an hour later. A number between 0 and 1, computed from salted local hashes. The lines themselves never leave. |
| `evidence_url` | empty unless you personally attached a public gist or PR link with `nerfd share --evidence`. |

That is the complete list. The shape is defined once, in [`packages/core/src/types.ts`](../packages/core/src/types.ts), and the conversion from a local session to a public record is one function you can read in under a minute: `toReport` in [`packages/core/src/redact.ts`](../packages/core/src/redact.ts). The server refuses anything that does not match, in [`packages/core/src/validate.ts`](../packages/core/src/validate.ts).

## What is never collected

Never sent, under any setting, with no flag to turn it on:

- prompt text, any part of it
- model output, any part of it
- source code, diffs, or line contents
- file names or paths, absolute or relative
- repository names, remotes, branches, or commit hashes
- the note you type when you rate a session
- your username, hostname, machine name, email, git identity, OS user, or environment variables
- IP-derived location, advertising ids, or any third-party analytics

There is no analytics SDK in the codebase. There are zero runtime dependencies, so there is nothing that could add one without showing up in a diff.

Some of that list *is* stored locally, because the local scorecard needs it. See "What is stored on your machine".

## When it is sent

- **Never, if sharing is off.** With `share: never` the CLI makes no network calls at all. Not a heartbeat, not a version check, not an error report. The one `fetch` call in the entire CLI is in [`publish.ts`](../packages/cli/src/publish.ts) and it is reached only from the share path.
- **After a session ends, if sharing is on.** The SessionEnd hook builds the record and POSTs it. It gives up after six seconds and never blocks or fails your coding tool.
- **When you re-rate a session** that was already sent, so the public record matches what you actually think.
- **When you run `nerfd share` by hand**, which works whether or not automatic sharing is on.

The one-line `curl | sh` installer turns automatic sharing **on** and prints the field list while doing it. If that is not what you want:

```sh
curl -fsSL https://nerfd.ai/install.sh | sh -s -- --no-share   # or: NERFD_SHARE=off
nerfd share off                                                # works today, any time
```

## How to see it before it is sent

```sh
nerfd privacy              # sharing status, everything stored locally, and the exact record for your last session
nerfd share --dry-run      # prints the record and sends nothing
nerfd show last --public   # the same record
nerfd export --public      # every record you have ever sent, as JSON or CSV
```

`nerfd privacy` builds the record with the same function, the same install id and the same validator as the real send. What it prints is what goes on the wire, byte for byte, apart from the indentation added for reading.

## How to stop

```sh
nerfd share off      # stops all sending, immediately, permanently, no confirmation dance
nerfd init --remove  # takes the hooks back out of Claude Code and Codex
rm -rf ~/.nerfd      # removes everything nerfd has ever written
```

Turning sharing off does not disable the local scorecard, and turning it back on does not backfill: sessions recorded while sharing was off are never sent unless you explicitly run `nerfd share all`.

## How to delete what was already shared

Your `reporter_id` is printed by `nerfd privacy`. It is the key to every record you have sent. See Open items below for the deletion endpoint, which is not built yet. Until it ships, mail the address on nerfd.ai with your reporter ids and they will be deleted by hand within seven days.

Deletion is real deletion: the rows go, and the next nightly aggregate is recomputed without them. Aggregates already published (a weekly post, an exported CSV someone downloaded) cannot be recalled, but no published aggregate contains a reporter id.

## What is stored on your machine

Everything lives in `~/.nerfd` (override with `NERFD_HOME`), created mode `0700`.

| Path | What it holds |
|---|---|
| `config.json` | a random install id, the server URL, your sharing setting, your plan. Mode `0600`. |
| `local.db` | one SQLite row per session, holding the full local record. |
| `hook.log` | hook failures only, so a broken hook never spams your terminal. |
| `app/` | the CLI itself, if you used the curl installer. |

Inside `local.db`, these fields are stored and **never** sent:

- `first_prompt` — the first 300 characters of your first prompt, kept so `nerfd show` is useful
- `touched_files` — absolute paths of files the session edited, used for the count
- `cwd` — the directory the session ran in, needed to re-measure code survival later
- `git_branch`, `git_head_start` — branch name and commit at session start
- `note` — whatever you typed with `nerfd rate`
- `line_hashes` — salted hashes of the lines the session added, used to check what survived
- `transcript_path` — where your tool keeps its own transcript

`nerfd privacy` shows the size of each file and how many of each of these it is holding. `nerfd privacy purge --yes` deletes `local.db` and `hook.log`.

If your home directory is backed up, synced, or on a shared machine, treat `~/.nerfd/local.db` as you would treat your shell history: it contains prompt fragments and paths.

## Retention

**On your machine:** forever, until you delete it. Code-survival hashes stop being useful after 30 days and should be dropped then (Open items).

**On the server:** raw reports are kept for 13 months, then deleted. Weekly aggregates — counts, medians, intervals, with no reporter ids — are kept indefinitely, because the historical record of how models moved is the entire point of the project. Server access logs, if any exist in front of the app, keep IP addresses for at most 7 days and are never joined to reports.

The server does see the IP address that sent a report, the way every HTTP server does. It is not stored in the reports table, not written to a log by the application, and not used for anything.

## Fingerprinting, honestly

A record with no name in it can still be a fingerprint. A rare language, plus a rare tool build, plus a rare model id, plus a timestamp to the millisecond, can single out one person. These are the mitigations, stated so you can check them:

- **`reporter_id` rotates weekly.** It is derived from your install id and the ISO week, so records can be deduplicated and rate-limited within a week, and cannot be chained across weeks into a years-long profile of one person. Long-lived identity exists only if you choose it, by signing in for a verified-reporter badge.
- **`ended_at` is bucketed to the hour, in UTC.** Week-over-week analysis needs the week, not the millisecond. A millisecond timestamp is close to a unique key, and an hour-of-day pattern reveals your timezone and your working hours.
- **`model` is matched against a public catalogue.** A custom or internal model id — `acme-internal-finetune` — names your employer. Unrecognised ids are not sent until you allow them explicitly.
- **`tool_version` must look like a version.** If `--version` returns something unusual, the raw string is dropped rather than forwarded.
- **`repo.lang` comes from a known list.** A rare in-house file extension is otherwise an employer fingerprint.
- **`plan_usd_month` is a catalogue price or nothing.** A free-typed dollar figure is a small, sharp identifier.
- **Small cells are not published.** Nothing with fewer than three sessions is scored, nothing with fewer than ten appears in a public tier.

Some of these are shipped and some are queued; the table in Open items says which.

## Governance

- **No money from model labs. Ever.** Not sponsorship, not a data deal, not a grant. Every credible evaluator that took lab money stopped being credible. The funding options are a data API, an enterprise view, non-lab sponsorship, or nothing.
- **The collector is open source.** The code that decides what leaves your machine is in this repo, it is about forty lines, and it has no dependencies. You are invited to read it rather than trust this page.
- **The scoring formula is published** on the board footer and in `docs/PLAN.md`, so a number you disagree with can be argued with.
- **Open data licence: CC BY 4.0.** Aggregates — the tier board, drift tables, weekly summaries and the JSON behind them — are CC BY 4.0. Use them, chart them, quote them; just say where they came from.

  **Recommendation on raw reports: keep them public, but only once the fingerprinting mitigations are shipped.** Raw per-session rows are the project's only structural defence against being another opaque leaderboard, and hiding them would cost more credibility than it buys privacy. But a raw dump carrying a permanent reporter id and a millisecond timestamp is a re-identification kit. So: publish aggregates only until weekly rotation and hourly bucketing land, then publish raw rows under the same CC BY 4.0 licence.

## FAQ for people at companies

**Can my employer see this?**
Not through nerfd. There is no admin console, no fleet view, no org enrolment, and no way to look up a person. Your employer can see your machine, the same as always: `~/.nerfd/local.db` is a file on a laptop they may manage, and network egress to nerfd.ai is visible to their proxy. Nothing in the payload tells them, or anyone, which of their staff sent it.

**Does it read my code?**
It reads your working tree to count lines, and turns each added line into a salted 20-character hash so it can tell later whether the line survived. Hashes stay in the local database. No line content, no file name and no hash is ever sent.

**Does it phone home if sharing is off?**
No. One `fetch` call exists in the CLI, on the share path. With sharing off nothing reaches it. `nerfd privacy` prints the endpoint so you can put it in an egress allowlist, or block it and watch nothing break.

**Can I install this without asking legal?**
That is the design target. The argument to make: derived metrics about your own sessions, no content, no identifiers, one endpoint, off with one command, source readable in an afternoon. Point your reviewer at "For your security team" below and at `redact.ts`.

**What about Gemini CLI's telemetry?**
Gemini CLI ships its own OpenTelemetry exporter, and its common attributes include `user.email`. That is Google's pipeline, controlled by Google's settings, and it is nothing to do with nerfd. When nerfd adds Gemini CLI support it reads the local JSONL chat files and deliberately does not touch the OTel stream. If you are worried about telemetry from your coding agents, audit each one separately; installing nerfd does not turn any of them on or off.

**Is there a kill switch for an organisation?**
`nerfd share off` per machine, or block the ingest endpoint at your proxy, or do not install the hooks (`nerfd init --remove`). A central enterprise policy file is not built (Open items).

## For your security team

**Every network call the CLI makes.** Complete list.

| When | Call |
|---|---|
| `nerfd share`, a finished session with sharing on, or a re-rating of a shared session | `POST https://nerfd.ai/v1/reports` — one JSON body under 2 KB, 6-second timeout, no retry, no cookies, no auth header |
| Install only | `GET https://nerfd.ai/install.sh` and `GET https://nerfd.ai/dist/nerfd.tgz` via curl |
| Planned, not yet built | an OpenAI-compatible `GET /v1/models` or Ollama `/api/show` against a **local** model runtime you configured, to identify a local model. localhost or your own host only, never an external service. |

Nothing else. No version check, no crash reporting, no telemetry, no CDN, no fonts. The board and landing pages load no external assets.

**Every process the CLI spawns.** `git` (rev-parse, ls-files, log, rev-list, diff) inside your project directory, and `<tool> --version` for the coding agent that fired the hook (`claude`, `codex`, `opencode`, `gemini`, `qwen`, `kimi`, `goose`, `crush`, `cline`, `aider`, `copilot`, `droid`). All with a timeout, all with stderr discarded. It never spawns `security`, so the macOS login keychain is never opened and no system password prompt is ever raised.

**What the plan detector opens.** nerfd reads your subscription tier off the files the tools already wrote, so that a session can be priced without you having to type anything. This is the complete list of files and fields. In every case one **named** field is extracted — nothing enumerates keys, greps, or scans — and the value must pass a shape gate (1–32 characters, no `@`, `/`, `+`, `:` or `=`) and then match a fixed set of expected enum values, or it is discarded without being returned. Every OAuth token, API key, JWT, email address and UUID in existence fails the first gate. Raw file contents are never returned, logged, cached or written. The reasoning and the sources are in [PLAN-DETECTION.md](PLAN-DETECTION.md); the code is [`packages/cli/src/plandetect/`](../packages/cli/src/plandetect/).

| File | Field read | Values it accepts |
|---|---|---|
| `~/.claude/.credentials.json` | `claudeAiOauth.rateLimitTier`, then `claudeAiOauth.subscriptionType` | `default_claude_max_5x`, `default_claude_max_20x`, …; `pro`, `max`, `team`, `enterprise`, `free` |
| `~/.claude.json` | `oauthAccount.userRateLimitTier`, `.organizationRateLimitTier`, `.organizationType`; and the **presence** of `oauthAccount` | as above; presence only, no key inside it is read |
| `~/.claude/settings.json`, environment | the *names* `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`, `apiKeyHelper` | set / not set. Values are never read, compared or copied |
| `~/.codex/auth.json` | `auth_mode`, and the `chatgpt_plan_type` claim inside `tokens.id_token` | `apikey`, `chatgpt`, …; `free`, `plus`, `pro`, `team`, `business`, `enterprise`, `edu`, … |
| `~/.gemini/settings.json` | `security.auth.selectedType` (legacy: `selectedAuthType`) | `oauth-personal`, `gemini-api-key`, `vertex-ai`, `cloud-shell` |
| `~/.local/share/opencode/auth.json` | the provider ids (keys), filtered against a fixed list, and each entry's `type` | `oauth`, `api`, `wellknown` |
| `~/.config/opencode/opencode.json` | `provider.*.options.baseURL`, reduced to the boolean "is this loopback or a private range" | true / false. The URL itself is never returned |
| `~/.config/goose/config.yaml` | `GOOSE_PROVIDER`, one line-anchored match | `ollama`, `lmstudio`, `anthropic`, `openai`, … |

The `id_token` in `auth.json` is a JWT. Its payload is base64url-decoded **locally** to read that one claim; no signature is verified, the token string never leaves the function, and the sibling claims in the same object (`chatgpt_account_id`, `chatgpt_user_id`, `user_id`) are never named by any code path. There is a test that points the same reader at `accessToken`, `refreshToken` and `chatgpt_account_id` on purpose and asserts it comes back empty.

**What the plan detector will not open.** The macOS login keychain (it would raise a system password prompt — a worse privacy event than the one it solves). `~/.gemini/google_accounts.json`, which holds your email and no tier. Codex's `rollout-*.jsonl` session logs, which interleave a `plan_type` with your prompt text. Anything at all under `~/.kimi-code/` or `~/.copilot/`, because the tier for those lives behind an authenticated API call and nerfd will not transmit a bearer token to learn a display string. Detection makes **no network calls**; it runs at most once a day, and `nerfd plan forget` drops what it found.

Every result records which file and which dotted field it came from, with your home directory collapsed to `~` so an OS username never enters the record. `nerfd privacy` and `nerfd plan` both print that column. It is local display only: of everything above, the only things that can ever be sent are `plan_id` and the word `detected`.

**Every file the CLI writes.**

| Path | Why |
|---|---|
| `~/.nerfd/config.json` | settings, mode 0600 |
| `~/.nerfd/local.db` (+ `-wal`, `-shm`) | local sessions |
| `~/.nerfd/hook.log` | hook errors |
| `~/.nerfd/app/**` | the CLI, if installed by curl |
| `~/.local/bin/nerfd`, `~/.local/bin/ms` | launchers, if installed by curl |
| `~/.claude/settings.json` | hook entries merged in, with a timestamped `.bak-nerfd-*` backup written first |
| `~/.claude/commands/nerfd.md` | the `/nerfd` rating command |
| `~/.codex/hooks.json` | hook entries merged in, backed up the same way |
| `~/.codex/prompts/nerfd.md` | the `/nerfd` rating prompt |

It writes nothing inside your repository. It never writes to your tool's transcript files.

**What the server stores.** One append-only `reports` table: the JSON above, plus a `received_at` timestamp. No IP column, no user-agent column, no account table, no cookies, no third-party scripts on any page.

---

## Open items

Everything below is a change this document describes or depends on that is **not yet in the code**. Each is a precise instruction for the owner of that file. Nothing here is edited by the privacy work itself.

### Blocking — this document overstates the code until these land

1. **`packages/cli/src/commands/sessions.ts:39`** — `show --public` calls `toReport(s, 'preview', CLIENT_VERSION)`, so the `report_id` and `reporter_id` it prints are *not* the ones that get sent, and `evidence_url` is always null. README and this page both claim it prints the exact payload. Change `'preview'` to `loadConfig().install_id` (import `loadConfig` from `../paths.ts`, already importing `CLIENT_VERSION` from there).
2. **`packages/core/src/redact.ts:33`** — `reporter_id: sha256(reporterId).slice(0, 24)` is stable for the life of the install. Change to `sha256(reporterId + '::' + isoWeek(s.ended_at)).slice(0, 24)`. `isoWeek` is already imported in that file.
3. **`packages/core/src/redact.ts:39`** — `ended_at: s.ended_at` is millisecond-precision. Change to the hour floor in UTC: `new Date(Math.floor(Date.parse(s.ended_at) / 3600000) * 3600000).toISOString()`.
4. **`packages/core/src/validate.ts`** — after the `ended_at` date check, reject non-hour-aligned timestamps so an old or modified client cannot push precise ones; cap `model` at 64 characters and `tool_version` at 32; require `tool_version` to match `/^[0-9A-Za-z.\-+]{1,32}$/` or be null.
5. **`packages/cli/src/hooks/handler.ts:46`** — `toolVersion` falls back to `out.trim().slice(0, 40)`, which forwards arbitrary text from a wrapped or corporate `claude --version`. Return `null` when the version regex does not match.
6. **`packages/core/src/redact.ts`, `toReport`** — send `model` only when it resolves in the pricing/catalogue table, or when the user has run `nerfd model-allow <id>`; otherwise return `null` (do not share the session) and have the CLI say why. Same treatment for `repo.lang`: map to a known list, else `'other'`.
7. **`packages/cli/src/cli.ts`** — register the new command. Add to `HELP` after the `share` lines: `  nerfd privacy [purge --yes]                    what is stored, what is sent, how to stop`. Add to the `switch`: `case 'privacy': return (await import('./commands/privacy.ts')).privacy(a);`. Without this the command written for this brief is unreachable.

### Server

8. **`packages/server/src/index.ts`, `POST /v1/reports` block (~line 156)** — build `POST /v1/reports/delete`. Proposed contract: body `{ reporter_ids: string[], proof: string }` where `proof` is `hmac_sha256(install_id, 'delete:' + reporter_ids.sorted().join(','))`. The server cannot verify that without the install id, so the simplest honest design is: the client sends the *unhashed* install id over TLS, the server recomputes `sha256(install_id + '::' + week)` for every week in the retention window, deletes matching rows, and never stores the install id. One line of code, no accounts, and it proves ownership because only the owner can produce a preimage. Rate-limit to a handful per IP per hour. Return `{ deleted: n }`.
9. **`packages/server/src/index.ts:151`, `GET /export.json`** — currently dumps every raw report, unbounded, including permanent reporter ids and millisecond timestamps. Serve aggregates until items 2 and 3 ship. Add a `licence` field or an HTTP `Link: <https://creativecommons.org/licenses/by/4.0/>; rel="license"` header either way.
10. **`packages/server/src/landing.ts:158-164` and `packages/server/src/ui.ts:154-155`** — add `<a href="/privacy">privacy</a>` to both footers. The `/privacy` route already exists in `index.ts:86` and renders `packages/server/src/privacy.ts`.
11. **Deployment** — terminate TLS with HSTS, and configure the proxy not to log client IPs for `POST /v1/reports`, or to truncate them. This page promises it.

### Local data minimisation

12. **`packages/core/src/redact.ts:18`, `hashLine`** — salt with the install id: `hashLine(salt, file, line)` hashing `salt + ' :: ' + file + ' :: ' + line.trim()`. Unsalted hashes of source lines are confirmable by anyone who guesses a line. Callers: `packages/cli/src/git.ts:96,136`. Comparison is always same-machine, so nothing else changes. Bump a schema version or accept that in-flight survival checks reset once.
13. **`packages/cli/src/hooks/handler.ts:122`** — store `first_prompt` only when `process.env.NERFD_KEEP_PROMPTS === '1'`. The classifier at line 123 runs on the live prompt and does not need the stored copy. Default to not keeping it.
14. **`packages/cli/src/hooks/handler.ts:136`** — store `hashPath(fp)` instead of the absolute path in `touched_files`; only the count is ever used. Rename the field to `touched_file_hashes` in `packages/core/src/types.ts:101`.
15. **`packages/core/src/types.ts:89-91`** — `cwd_hash`, `git_head_start` and `git_branch` are written and never read anywhere in the codebase. Delete all three fields and their writes in `handler.ts:67-69` and `record.ts:44-46`. A branch name like `ACME-4471-fix-billing` is the kind of thing that should not be sitting in a database that nothing reads.
16. **`packages/cli/src/commands/check.ts`** — after a session passes the 30-day re-check window, set `s.line_hashes = null` and save. They are dead weight and a code index after that.
17. **`packages/cli/src/hooks/handler.ts`, `finalise`** — null `s.transcript_path` once the transcript has been parsed.
18. **`packages/cli/src/cli.ts:51`** — `log('hook error: ' + e.stack)`. When stdin is not valid JSON, V8 embeds the first ten characters of the input in the error message (`Unexpected token 'p', "prompt: fi"... is not valid JSON`), and that input contains prompt text. Log the error *name* only: `log('hook error: ' + (e as Error).name)`.
19. **`packages/cli/src/paths.ts:46`, `log`** — `hook.log` grows without limit and inherits the default file mode. Truncate to the last 200 lines when it passes 256 KB, and write with `{ mode: 0o600 }`.
20. **`packages/cli/src/hooks/handler.ts:215,228`** — these log exception messages from transcript and git failures, and an `ENOENT` message contains an absolute path including the project directory name. Log `(e as Error).name` plus a fixed label instead.

### Product

21. **`packages/server/src/installer.ts`** — accept `NERFD_SHARE=off` and `sh -s -- --no-share`, passing `--no-share` through to `nerfd init` (which already supports the flag, `init.ts:22`). A developer at a company needs a scripted opt-out that does not involve editing a piped shell script.
22. **`packages/server/src/installer.ts:55`** — add the privacy URL to the closing output. Suggested line in the report accompanying this document.
23. **`packages/core/src/aggregate.ts:203`, `reporterMonths`** — weekly `reporter_id` rotation turns one person into roughly 4.3 reporters per month, which deflates `sessions_median` and `successes_median` and inflates `cost_per_success_median` by the same factor. Switch the unit to reporter-*weeks*, pricing the plan pro-rata at `plan_usd_month * 7 / 30.44`. The headline `value_multiple_median` is a ratio and is unaffected.
24. **Reputation weighting** — it needs identity over time, which weekly rotation deliberately removes. Attach reputation to the verified-reporter identity from the M1 GitHub sign-in instead: anonymous reporters rotate weekly and carry weight 1; verified reporters carry a stable id they opted into and carry more. This also settles the open question in `docs/PLAN.md`.
25. **`nerfd share --evidence`** — an evidence URL permanently and publicly links that record to a GitHub account. Print a one-line confirmation of exactly that before the first one is attached.
