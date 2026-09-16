# Tokens versus limits

What a subscription actually gives you: how many tokens a window holds, how much of it you use, how often you hit the wall, and which plan is most generous per dollar, overlaid with quality. Everything is measured from data already on the machine. No vendor API is ever called with a person's token.

## Evidence per tool (verified 16 September 2026)

| Tool | Window state | Wall hits | Notes |
|---|---|---|---|
| Codex | `token_count` event after every model response carries `rate_limits` with one or more limit ids, each with `used_percent` (integer), `window_minutes`, `resets_at` (epoch seconds), `plan_type`, `rate_limit_reached_type`, `credits` | `rate_limit_reached_type` non-null | On a Pro account the main `codex` limit reports a 10080-minute window only; a model-scoped limit id carries 300 + 10080. Windows are first-use anchored, not calendar weeks. `resets_at` jitters a few minutes between readings and jumps at reset. |
| Claude Code | Status-line JSON: `rate_limits.five_hour`, `.seven_day`, `.spend_limit`, each `{ used_percentage: float, resets_at: epoch }`, present for Pro and Max after the first response | `StopFailure` hook with `error_type: rate_limit` | Transcripts carry no window state. `total_tokens_reminder` is the context budget, not a rate limit. |
| Kimi Code | none on disk (quota is fetched with the bearer token, never cached) | wire.jsonl error kinds `rate_limit`, `quota_exhausted`, `overloaded`, `context_overflow` | |
| OpenCode, Gemini, Copilot, Goose | none | error text only | Zen and Go caps are dollar-based and server-side. |

## What a session records

```
limit_windows: Array<{
  scope: 'primary' | 'secondary' | 'five_hour' | 'seven_day' | 'spend' | 'model',   // allowlisted; never the raw limit id or name
  window_min: number | null,           // 300, 10080, ...
  used_pct_start: number | null,       // first sample in the session
  used_pct_end: number | null,         // last sample
  samples: number,                     // how many readings
  resets_in_min_end: number | null,    // minutes from the last sample to reset; an offset, never an absolute time
  reset_bucket: number | null,         // floor(resets_at / 3600): coarse enough to group a reporter's sessions into one window, too coarse to fingerprint
  wall_hit: boolean,
  tokens: { total: number; uncached_in: number; out: number; cached_in: number }   // consumed between the first and last sample
}>
```

Codex: one entry per limit id seen, scope mapped from the id (`codex` primary and secondary windows → `primary` / `secondary`; model-scoped ids → `model`). Claude Code: `five_hour`, `seven_day`, `spend` from the status-line samples. Every field is validated: scope from the enum, numbers bounded, no strings.

## Capturing Claude Code's status line

`nerfd init` installs a status-line wrapper only when Claude Code is present and a Pro or Max plan is detected. The wrapper receives the status JSON on stdin, extracts exactly `session_id` and `rate_limits`, appends one sample per minute at most to `~/.nerfd/limits/<session_id>.jsonl`, then runs the person's original status-line command with the same stdin and returns its output unchanged. If there was no status line, it prints nothing. `nerfd init --remove` restores the original. The wrapper never reads `cwd`, `model`, `cost` or any other field from the status JSON. The samples are read by the Claude adapter's ledger at session end and deleted after 30 days by `nerfd check`.

## The estimator

Per-window, never per-pair: Codex quantises to whole percents, so a single pair is off by up to half.

1. Group a reporter's sessions by `(plan_id, scope, window_min, reset_bucket)`.
2. Sum `tokens` and `Δused_pct` across the group. Discard groups with `Δused_pct < 20` or whose samples cover less than 80% of the elapsed window.
3. `capacity_tokens = Σtokens / Σ Δused_pct × 100`, on two bases: total tokens, and uncached input plus output. Both are estimates and are labelled as such.
4. Across reporters, publish the band: p25, p50, p75, with the number of windows and reporters. Unobserved concurrent sessions bias a window low; cached input biases it high, so the band is the honest number.

## Generosity and the overlay

- `tokens_per_dollar = capacity_p50 × windows_per_month / plan_usd_month`, with `windows_per_month = 43800 / window_min`, shown as a band.
- `successes_per_dollar`: successful sessions in the reporter-week with no wall hit and no context-limit hit, divided by the pro-rata plan price.
- `wall_hit_share`: reporter-weeks with at least one wall hit.
- `usage_median`: median `used_pct_end` at session end, i.e. how much of the window people typically consume.
- Quality overlay: the plan's quality score from the same sessions, plotted against successes per dollar, sized by n, faceted by serving mode.

## Where it shows

- **Personal report**, section "Tokens versus limits": your windows this period with capacity estimate, typical usage, wall hits and time to reset, your generosity figure, and the public band beside it for the same plan.
- **Public board and landing**, section "What a plan actually gives you": plans ranked by tokens per dollar with the band, wall-hit share, usage median, successes per dollar, and the quality tier beside each.
- **API**: `GET /v1/limits?weeks=8` and the aggregate in `/export.json`.

## Published tier facts, for the overlay

Almost nobody publishes counts any more. Anthropic publishes structure and multipliers only. OpenAI publishes explicitly-disclaimed message ranges per 5 hours for Plus and scale factors for Pro, no weekly numbers. Alibaba's coding plan publishes requests per 5h, week and month. Z.ai publishes credits per window. OpenCode Go publishes nested windows as a share of a monthly dollar cap. Copilot is monthly credits only. Kimi and MiniMax publish structure without counts. This is why a measured band is worth having.

## API

`GET /v1/limits?weeks=8` (`weeks` clamped to 1..52), and the same two arrays under `limits` in `/export.json`. Plans are ordered by `tokens_per_dollar.p50`, best first; windows by plan, then window length, then scope. Every capacity figure is an estimate, and nothing here is ever a single number without the band around it.

```jsonc
{
  "weeks": 8,
  "n": 1284,                       // sessions behind the answer
  "plans": [{
    "tool": "claude-code",
    "plan_id": "claude-max-20x",
    "name": "Claude Max 20x",
    "usd_month": 200,
    "scope": "five_hour",          // the window the band below is computed on:
    "window_min": 300,             // the cell with the most windows behind it
    "n_windows": 412,
    "tokens_per_dollar": { "p25": 730000, "p50": 890000, "p75": 1100000 },   // all null when the plan has no published price
    "successes_per_dollar": 0.0435,  // median over reporter-weeks, pro-rata price
    "wall_hit_share": 0.33,          // reporter-weeks with at least one wall hit
    "usage_median_pct": 61,          // used_pct_end at session end
    "quality": 83,                   // the plan's composite score, same aggregator as the board
    "reporter_weeks": 96,
    "n": 612                         // sessions on the plan
  }],
  "windows": [{
    "plan_id": "claude-max-20x",
    "scope": "five_hour",
    "window_min": 300,
    "n_windows": 412,                // windows that passed both filters
    "n_reporters": 38,
    "capacity_total": { "p25": 1000000, "p50": 1200000, "p75": 1450000 },
    "capacity_uncached": { "p25": 500000, "p50": 600000, "p75": 720000 },
    "usage_median_pct": 50,
    "wall_hit_share": 0.2,           // windows in which somebody hit the wall
    "samples_median": 5
  }]
}
```

Every figure in a `windows` entry describes the windows that survived the estimator's filters - `Δused_pct >= 20` and sessions spanning at least 80% of the window length - so `usage_median_pct` and `wall_hit_share` are medians over the same set `n_windows` counts. The personal report runs the identical estimator over one person's sessions with the floor at 10%, because for one person the alternative to a slightly noisier number is no number; it reports the observed windows and their capacity separately, so a window that moved too little to divide by is still counted and shown.
