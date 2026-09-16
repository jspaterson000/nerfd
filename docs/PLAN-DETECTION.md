# Plan detection

`nerfd plan claude claude-max-20x` still works and still wins. But most people
never run it, and a scorecard that cannot price a session is half a scorecard.
So nerfd now reads the plan off the machine where the tool already wrote it, and
treats self-report as an override rather than a prerequisite.

This document is the evidence behind that. It says, per tool, exactly which file
and which field is opened, what values that field takes, how confident the
answer is, and — the part that matters most — what it **cannot** know.

Implementation: [`packages/cli/src/plandetect/`](../packages/cli/src/plandetect/).
Tests: [`packages/cli/test/plandetect.test.ts`](../packages/cli/test/plandetect.test.ts).

---

## The rules

Detection touches other tools' credential files. That is a serious thing to do
in a project whose first principle is [zero transcript](PRIVACY.md), so it is
fenced in six ways, and the fence is code, not a promise:

1. **One named field.** A detector may open a credentials or config file only to
   extract a single named field whose value is a plan / tier / type enum. It
   never enumerates keys, never scans, never greps.
2. **Two gates on every value.** Everything a detector learns comes back through
   `read.ts`, which applies a *shape gate* (1–32 characters, letters, digits,
   space, `_`, `-`, `.`, and never `@`, `/`, `+`, `:` or `=`) and then a
   *membership gate* against the exact set of values the caller expects. Every
   OAuth token, API key, JWT, email address and UUID in existence fails the
   first gate. A value that passes the first but not the second is discarded.
   The practical consequence: **a detector pointed at the wrong field returns
   nothing rather than a secret.** There is a test that points it at
   `accessToken` and `refreshToken` on purpose and asserts it comes back empty.
3. **Nothing is retained.** The parsed object lives inside one function call and
   is never returned, logged, cached or written. Raw file contents never reach
   any caller.
4. **Evidence is recorded.** Every result carries `evidence`: the file and the
   dotted field it was read from, with the home directory collapsed to `~` so an
   OS username never enters the stored record. `nerfd plan` prints it in a
   "read from" column. Nothing was read that is not in that column.
5. **Never the keychain.** On macOS, Claude Code stores credentials in the login
   keychain. nerfd will not run `security find-generic-password`, because that
   raises a system password prompt — a worse privacy event than the one it
   solves. On those machines detection degrades to "a subscription is logged in,
   tier unknown" and says so.
6. **Never the network.** Some tiers (Kimi's membership, Copilot's
   `copilot_plan`, Gemini's Code Assist tier) exist only behind an authenticated
   API call. Reaching them means transmitting a bearer token to learn a display
   string. nerfd does not do this, and those tools are reported as undetectable
   with the reason shown.

Only two fields ever leave the machine: `plan_id`, and
`plan_source: 'detected' | 'declared' | 'assumed' | 'unknown'`. `evidence`,
`confidence` and the two subscription dates below are local display only, and
there is a test asserting the public surface is those two keys.

### The seventh rule: one date each, and only for history

Rule 1 says "one named field whose value is a plan / tier / type enum". There
are exactly two exceptions, both added for imported history, and both are
dates:

| Tool | File | Field | What it is |
|---|---|---|---|
| Codex | `~/.codex/auth.json` | `tokens.id_token` → `"https://api.openai.com/auth".chatgpt_subscription_active_start` / `_until` | the window this ChatGPT subscription was active |
| Claude Code | `~/.claude.json` | `oauthAccount.subscriptionCreatedAt` | when the subscription was created; there is no end date, so the period is open-ended |

A date is not an identity: it says when a subscription ran, not whose it is.
They cross their own gate in `read.ts` (`dateGate`) rather than a hole in the
enum one: the value must parse as a calendar date and land within a decade of
now, and what comes back is re-serialised from `Date`, so whatever shape the
file used, what the caller sees is an ISO timestamp and nothing else. A token,
a uuid, an email or an org name cannot survive that, and there is a test that
points the readers at `access_token`, `chatgpt_account_id` and `email` on
purpose and asserts they come back empty. Neither date is ever published;
`nerfd privacy` shows them, and what leaves is the plan id and one word.

### `assumed`: pricing imported history

Backfilled sessions ran before nerfd existed, so nothing on them says which
plan was in force and `plan_id` was `null` — which is why the public plans
board was empty for every imported session. Detection knows which plan the
machine is on **now**; applying that to all of history would put $200 against
sessions run before the subscription was bought.

So `nerfd backfill` applies the tool's effective plan to an imported session
only when that session's `ended_at` falls inside the active period above, and
marks it `plan_source: 'assumed'`. Outside the period — or on a tool that
records no dates at all — the session keeps `null` and `'unknown'`. OpenCode
borrows the Codex period, the same way it borrows the plan. A plan you
declared, or one detected at the time the session actually ran, is better
evidence and is never overwritten.

`nerfd backfill --restamp` re-runs that pass over sessions already on record,
for when a period only becomes readable later; `nerfd share all --resend`
pushes the corrected records to the board, which upserts on `report_id`.

---

## Summary

| Tool | File | Field | Values | Confidence | Cannot distinguish |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json` | `claudeAiOauth.subscriptionType` | `pro`, `max`, `team`, `enterprise`, `free` | high (`max`: medium) | **Max 5x from Max 20x** |
| Claude Code | `~/.claude.json` | `oauthAccount.userRateLimitTier`, then `oauthAccount.organizationRateLimitTier` (the account profile, refreshed at login; preferred) | `default_claude_max_5x`, `default_claude_max_20x`, … | high | — |
| Claude Code | `~/.claude.json` | `oauthAccount.subscriptionCreatedAt` (a date, for `assumed` pricing of imported history) | ISO date | high | whether the tier changed since |
| Claude Code | `~/.claude/.credentials.json` | `claudeAiOauth.rateLimitTier` (can lag an upgrade: a real install showed 5x here and 20x in the profile) | same | medium | — |
| Claude Code | `~/.claude.json` | `oauthAccount.userRateLimitTier`, `.organizationRateLimitTier`, `.organizationType` | as above | low | fallback only |
| Claude Code | `~/.claude.json` | `oauthAccount` *(presence only)* | — | low (plan stays `null`) | any tier; this only rules out API billing |
| Claude Code | env / `settings.json` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`, `apiKeyHelper` | set / not set | high | → `api` |
| Codex | `~/.codex/auth.json` | `tokens.id_token` → `"https://api.openai.com/auth".chatgpt_plan_type` | `free`, `go`, `plus`, `pro`, `prolite`, `team`, `business`, `self_serve_business_*`, `ent26`, `enterprise`, `hc`, `enterprise_cbp_*`, `edu`, `education`, `edu_plus`, `edu_pro` | high | seats within a Business/Enterprise org |
| Codex | `~/.codex/auth.json` | `tokens.id_token` → `"https://api.openai.com/auth".chatgpt_subscription_active_start` / `_until` | ISO dates / unix timestamps | high | when within the window a plan changed |
| Codex | `~/.codex/auth.json` | `auth_mode` | `apikey`, `chatgpt`, `chatgptAuthTokens`, `headers`, `agentidentity`, `personalaccesstoken`, `bedrockapikey`, `bedrockaccesskeys` | high | → `api` for all but the two ChatGPT modes |
| Gemini CLI | `~/.gemini/settings.json` | `security.auth.selectedType` (or legacy `selectedAuthType`) | `oauth-personal`, `gemini-api-key`, `vertex-ai`, `cloud-shell` | high for `api` | **free vs AI Pro vs AI Ultra** — tier is never on disk |
| OpenCode | `~/.local/share/opencode/auth.json` | provider ids (keys) + `<provider>.type` | `oauth`, `api`, `wellknown` | medium | which OpenCode Zen tier; whose Claude/ChatGPT plan is being borrowed |
| OpenCode | `~/.config/opencode/opencode.json` | `provider.*.options.baseURL` *(loopback/private test only)* | boolean | medium | → `local` |
| Goose | `~/.config/goose/config.yaml` | `GOOSE_PROVIDER` | `ollama`, `lmstudio`, `anthropic`, `openai`, … | high | nothing — Goose has no subscription, so `api` or `local` is the complete answer |
| Kimi Code | *(none opened)* | — | — | — | **everything.** Tier is server-side only |
| Copilot CLI | *(none opened)* | — | — | — | **everything.** `copilot_plan` is server-side only |
| Qwen, Crush, Droid | *(none opened)* | env API keys only | set / not set | medium | any tier |

---

## Claude Code

**`~/.claude/.credentials.json` → `claudeAiOauth.subscriptionType`.** The object
also holds `accessToken`, `refreshToken`, `expiresAt` and `scopes`; none of them
is named by any code path, and the gates in `read.ts` reject all of them anyway.
Observed values are `"max"`, and `null` in a known bug where a Pro subscription
bought through the iOS App Store was not recognised
([anthropics/claude-code#34049](https://github.com/anthropics/claude-code/issues/34049),
[gist](https://gist.github.com/Prajwalsrinvas/cacbb728c4ea06c3bc1676608d3c72dc)).
Anthropic does not publish this schema, so the field is community-documented
rather than official, and detection treats a missing or unexpected value as a
normal outcome.

**The keychain.** The official authentication doc states plainly: "On macOS,
credentials are stored in the encrypted macOS Keychain. When the Keychain
rejects the write… Claude Code stores your login in `~/.claude/.credentials.json`
instead" ([docs](https://code.claude.com/docs/en/authentication)). So on a normal
Mac **the file does not exist**, and this is the common case, not the edge case.
nerfd does not call `security`. It falls back to testing whether
`~/.claude.json` contains an `oauthAccount` object — presence only, no key
inside it is named or read — which establishes "signed in to a subscription,
tier unknown" and nothing more.

**Max 5x vs Max 20x: not knowable from `subscriptionType`.** A $100 plan and a
$200 plan both write `"max"`. Nothing in the hooks reference
([docs](https://code.claude.com/docs/en/hooks)) carries a tier. The statusline
JSON ([docs](https://code.claude.com/docs/en/statusline)) carries
`rate_limits.five_hour.used_percentage`, `.seven_day.…` and `.spend_limit.…` —
percentages and reset timestamps, with no multiplier, seat name or plan string.
Its mere *presence* distinguishes a subscription from an API key, because the
doc says it appears only for Pro/Max subscribers, but it never names the tier.

Because guessing here would put a wrong price on real money, detection reports
the plan id **`claude-max`** (added to `plans.ts`, `usd_month: null`) at medium
confidence, and `nerfd plan` prints one line asking for one command:

```
claude: detected Max, but a $100 Max 5x and a $200 Max 20x are identical on disk,
        so the price is unknown.
        settle it in one command:  nerfd plan claude claude-max-5x | claude-max-20x
```

**`rateLimitTier` is read speculatively.** A field of that name, with values
like `default_claude_max_20x`, would settle the ambiguity. It could not be
corroborated against any primary source during this research, and is flagged
here as **confirmed** (observed as `default_claude_max_5x` on a real Max install in September 2026). It is read first because doing so is free and
fail-safe: the value must be one of four allowlisted strings to be used at all,
anything else falls through to `subscriptionType`, and a result from it is never
reported above medium confidence. If the field does not exist, the lookup
silently does nothing.

**API mode.** Per the documented authentication precedence, cloud-provider
variables outrank `ANTHROPIC_AUTH_TOKEN`, which outranks `ANTHROPIC_API_KEY`,
which outranks `apiKeyHelper`, which outranks subscription OAuth. The detector
resolves in that same order, so a machine with both a key and a login is
reported the way it will actually be billed. Only variable *names* are used;
values are never read, compared or copied into evidence.

## Codex

Verified against the `codex-rs` source on
[github.com/openai/codex](https://github.com/openai/codex):

- `AuthDotJson` — `codex-rs/login/src/auth/storage.rs`: `auth_mode`,
  `OPENAI_API_KEY`, `tokens`, `last_refresh`, plus newer `agent_identity`,
  `personal_access_token`, `bedrock_api_key`, `bedrock_access_keys`.
- `TokenData` / `IdTokenInfo` — `codex-rs/login/src/token_data.rs`:
  `chatgpt_plan_type`, populated from the `"https://api.openai.com/auth"` claim.
- `PlanType` / `KnownPlan` — `codex-rs/protocol/src/auth.rs`: the wire strings in
  the table above, with an `Unknown(String)` fallback variant.
- `AuthMode` — same file.

The `id_token` is a JWT. Its **payload** is base64url-decoded locally to read one
claim. No signature is verified, because nothing here trusts the value for
anything beyond choosing a price to display; the token string is never returned,
logged or written; and the sibling claims in that same object —
`chatgpt_account_id`, `chatgpt_user_id`, `user_id`,
`chatgpt_account_is_fedramp` — are never named by any code path. There is a test
that tries to read `chatgpt_account_id` through the same function and asserts it
comes back `null`.

**What is deliberately not read.** `RateLimitSnapshot` on the `token_count`
event in `~/.codex/sessions/**/rollout-*.jsonl` carries a `plan_type` field
(`codex-rs/protocol/src/protocol.rs`), which would be a second, independent
source. nerfd does not read it: those files interleave the plan with prompt and
output text, and `auth.json` answers the same question by opening one small
file. Opening less is the better trade.

## Gemini CLI

The Code Assist tier (`UserTierId` = `free-tier` | `legacy-tier` |
`standard-tier`, in `packages/core/src/code_assist/types.ts`) is resolved at
runtime by `loadCodeAssist` / `onboardUser` against Google's Cloud Code API and
**is never written to disk**. There is therefore no local field naming a Google
AI Pro or AI Ultra subscription, and nerfd does not invent one.

What *is* on disk is the auth method, at `security.auth.selectedType` in
`~/.gemini/settings.json` (older versions: a top-level `selectedAuthType`). Both
are checked. `gemini-api-key` and `vertex-ai` mean `api`; `oauth-personal` means
a Google account is signed in — a Code Assist tier of some kind — and the plan
is left `null` with the reason shown.

`~/.gemini/google_accounts.json` holds the signed-in email address. nerfd never
opens it, not even to test whether it exists, because the tier is not in it and
the only other thing in it is identity. A test asserts the Gemini result is
unchanged by that file's contents.

## OpenCode

`~/.local/share/opencode/auth.json` is a flat object keyed by provider id whose
values are a discriminated union on `type`: `oauth` | `api` | `wellknown`
([packages/opencode/src/auth/index.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/auth/index.ts)).
The schema has **no plan or tier field at all** — it stores credentials only.

So the provider ids themselves are the signal, and they are read as *keys*,
filtered against a fixed list of known providers. A user-named custom provider
is not returned, because a custom provider id can be an employer name. Only the
`type` discriminator is read from each entry, and only against its three legal
values.

Three inferences follow:

- an `opencode` / `opencode-go` / `opencode-zen` entry with a non-`api` type →
  `opencode-go`;
- a provider whose `baseURL` is loopback or a private range, or an
  `ollama`/`lmstudio`/`llamacpp` entry → `local` (the URL itself is never
  returned, only the boolean "this is local");
- an `anthropic` or `openai` entry of type `oauth` means OpenCode is spending
  somebody's Claude or ChatGPT subscription, so the Claude or Codex detector is
  reused and the result is reported one confidence step lower.

## Kimi Code, Copilot CLI, Qwen, Crush, Droid

These open no credential file, because none of them contains an answer.

- **Kimi Code.** Everything under `~/.kimi-code/` is credentials
  (`credentials/kimi-code.json` holds OAuth tokens; `device_id` is a device id).
  The membership tier — Adagio, Moderato, Allegretto, Allegro, Vivace — is
  fetched live from Moonshot's usage endpoint, which requires sending the bearer
  token. nerfd will not transmit a secret to learn a display field. Declare it:
  `nerfd plan kimi kimi-allegro`.
- **Copilot CLI.** GitHub's own reference for `~/.copilot/` describes
  `config.json` as "automatically managed application state" and lists no plan
  field anywhere in the directory
  ([docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)).
  `copilot_plan` comes from `GET /copilot_internal/user` on api.github.com,
  which again means sending a token.
- **Qwen Code.** `~/.qwen/oauth_creds.json` is tokens only; the free OAuth tier
  was never a named field on disk and was discontinued in April 2026.
- **Crush, Droid.** Provider config and keys, no tier field. Factory's plans are
  enforced server-side.

For all of these, only environment variable *names* are checked, to separate
`api` from unknown.

## Goose

Goose is fully bring-your-own-key: there is no Goose subscription. That makes it
one of the few tools detection can answer completely — the plan is `api`, or
`local` when `GOOSE_PROVIDER` in `~/.config/goose/config.yaml` names a local
runtime. One line-anchored match for one named key; the rest of the file is
never parsed.

---

## Behavioural inference, and why it is not used

The tempting last resort is to infer the tier from the limit windows and how
often the wall is hit. nerfd does not do this, and the reason should be on the
record rather than discovered later:

- **The windows are not tier signals.** Claude exposes a 5-hour and a 7-day
  window. Codex reports windows per limit id, and they are not constant: on a
  real Pro account (Sep 2026) the plan-level `codex` limit carried a single
  10080-minute window with no secondary, while a model-scoped limit id carried
  300 + 10080. Window layout must be read per limit id, never assumed, and it
  still says nothing about the tier: only the quota *size* behind a window
  differs, and the size is never reported, only `used_percent` against it.
  (nerfd now estimates that size from token deltas, see LIMITS.md, but as a
  measurement of generosity, not as a way to identify the plan.)
- **Usage is a property of the person, not the plan.** A heavy Max 5x user and a
  light Max 20x user produce the same rate-limit-hit counts. Inverting from
  "hits the wall twice a week" to a tier requires knowing the workload, which is
  exactly what nerfd is trying to measure. The inference runs backwards.
- **A wrong plan is a wrong price.** Plan id feeds "what did $200 actually buy".
  Guessing 20x when the truth is 5x halves a headline number, and
  `plan_usd_month` is shared. A silent wrong number is worse than a visible
  blank, and this project's whole argument is that it publishes numbers you can
  check.

So: no inference from limit windows, no inference from hit frequency. Where the
file does not say, detection says `unknown` and `nerfd plan` asks for one
command.

---

## Storage, staleness, precedence

Detections live in `config.json` under `detected_plans`:

```json
{
  "detected_plans": {
    "checked_at": "2026-09-16T04:23:46.521Z",
    "plans": {
      "codex": {
        "plan_id": "chatgpt-pro",
        "source": "detected",
        "evidence": "~/.codex/auth.json tokens.id_token → \"https://api.openai.com/auth\".chatgpt_plan_type",
        "confidence": "high"
      }
    }
  }
}
```

Re-detection runs at most once a day (`DETECT_TTL_MS`), because a subscription
changes about as often as a person changes their mind about one. A `checked_at`
that is missing, unparseable, or in the future is treated as stale, so a clock
that jumped cannot freeze detection forever.

Precedence, implemented once in `effectivePlan()`:

```
declared  >  detected  >  null
```

A plan the person typed is stored with `source: 'declared'` and always wins —
the person knows, and the file may be stale, may be a work account, or may say
`max` when they are on 20x. `nerfd plan <tool> none` drops the declaration and
falls back to the detected value, and says so.

## Commands

```sh
nerfd plan                    # what each tool is on, with evidence and confidence
nerfd plan detect             # re-run detection now
nerfd plan claude claude-max-20x   # declare; overrides detection
nerfd plan claude none        # drop the declaration, fall back to detection
nerfd plan forget [tool]      # drop a stored detection without declaring
```
