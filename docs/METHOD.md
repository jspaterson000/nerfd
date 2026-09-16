# Method

What nerfd measures, how it scores, and the principles the design follows. The public record is only as good as the argument for it, so the argument is here to be argued with.

## The problem

Nobody knows which AI model to use for which kind of work this week. Lab benchmarks are static, contaminated, and measure a model through the lab's own harness. X is anecdote with no denominator. Model quality genuinely moves week to week: Anthropic has published two postmortems (Sep 2025, Apr 2026) admitting multi-week degradations that their own evals did not catch, and the second one was caused not by the model but by harness changes (default reasoning effort, a prompt-cache bug, a verbosity cap). Endpoint benchmarks are structurally blind to that class of change. The people who can see it are the people doing real work in Claude Code and Codex every day, and today their evidence evaporates into tweets.

## What this is

A local-first scorecard of how models perform on real work, captured automatically from the terminal, with an opt-in public board that shows week-over-week change per model per task type. It is useful to one person on day one with no other users, and it becomes the public record when enough people opt in.

What it does, in priority order:

0. **One-line install, autonomous reporting.** `curl -fsSL <host>/install.sh | sh` puts the CLI in place, hooks Claude Code and Codex, and turns on reporting of redacted session records to that host. The consent text prints at install and on `nerfd share status`. `nerfd share off` is one command. Any other tool reports through `nerfd record`.
1. **Personal scorecard.** Hooks in Claude Code and Codex record every session: model, effort level, tool version, task category, repo shape, tokens, latency, errors, rate limits, interrupts, model switches, and whether the code the session wrote is still there an hour later. Optional one-line rating. `nerfd which debug --lang ts` answers "what should I use right now" from your own history.
2. **Public board.** `nerfd share` sends a redacted record. The board shows model by category by week with sample sizes and confidence intervals, and flags drift as change detection with the raw numbers next to it.

## Principles

These are the product. Break one and it becomes another leaderboard.

- **Selfish first, public second.** Every feature must be worth installing at n=1. The public data is a consequence of people keeping the tool, not the reason they install it.
- **Never ask for a vote.** Copilot Arena died on active voting. Ratings are optional and take two seconds. The objective signals are collected with zero effort and carry most of the weight when ratings are missing.
- **Price the outcome, not the token.** Two views, always side by side. API-equivalent: what the tokens would cost at list price, per session and per successful session, and the share of spend on sessions that failed. Subscription: what a $20, $100 or $200 month actually bought, in successful sessions, hours, API-equivalent value, effective cost per success, and how often the limit wall was hit. Most users are on flat plans; a cost view that ignores that is useless to them.
- **Zero transcript.** No prompt text, no code, no file paths, no repo identity ever leaves the machine. The public record is derived metrics only. `nerfd show last --public` prints exactly what would be sent, and `nerfd share --dry-run` sends nothing. This is what makes it adoptable inside companies and what keeps it clear of the labs' competitive-use terms.
- **Show n and an interval, never a bare average.** Anything with fewer than three sessions is unscored. Wilson intervals on the good-session rate. Drift is a z-score against a trailing baseline, and it needs five sessions in the current week to flag at all.
- **Change detection, not accusation.** The board says "something moved", with the numbers. It never says "they nerfed it". The labs have stated on record that they do not degrade for load, and a false alarm on weak stats is a rebuttal we cannot win. Effort level and tool version are recorded precisely so that a change can be attributed to the harness rather than the model when that is what happened.
- **Open collector, open data, open formula.** The scoring formula is in the footer of the dashboard. Raw data is one link away. The Leaderboard Illusion paper showed what happens when a leaderboard hides its submission policy.
- **Never take money from a lab.** Every credible evaluator that monetised ended up selling to the companies it grades. This product's only asset is that it does not. Funding options are a data API, an enterprise fleet view, sponsorship from non-labs, or nothing.

## What we measure

| Signal | Source | Effort to collect | Fakeable? |
|---|---|---|---|
| model, effort level, tool version | SessionStart and PostModelSwitch hooks, transcript fallback | none | hard |
| task category | keyword classifier on first prompt, user override | none | easy but pointless |
| repo language, size, age | git, at session start | none | hard |
| prompts, tool calls, edits, files touched, test runs | PostToolUse hook | none | hard |
| errors, rate limits, timeouts | PostToolUseFailure, StopFailure error_type, transcript | none | hard |
| interrupts | transcript markers | none | hard |
| model switches mid-session | PostModelSwitch hook | none | hard |
| tokens, latency p50 and p95 | transcript | none | hard |
| survival: share of added lines still present after an hour or more | git diff hashes at start and end, rescan later | none | hard |
| rating 1 to 5, kept or reverted, note | `nerfd rate` or `/ms` inside Claude Code | two seconds | easy |

The AMD analysis of 6,852 sessions that made the news in April 2026 used exactly these kinds of behavioural markers (interrupts up 12x, edits without reads up 5x) and reached the right conclusion with the wrong mechanism. We collect the same markers by default for everyone.

## Tiers

The site's headline is a tier board, relative to the field: each criterion (quality, reliability, survival, speed, value) is normalised against the best model in the window, then banded S / A / B / C at 92 / 78 / 60 percent. Overall tier comes from the composite score. Ten sessions minimum on the public board, three locally. Every cell shows the underlying number next to the badge.

## Scoring

Published formula, deliberately simple:

```
score = 0.55 * rating_norm + 0.30 * survival + 0.15 * clean
```

`rating_norm` is the mean rating mapped from 1..5 to 0..1. `survival` is the mean share of added lines that survived. `clean` is the share of sessions with no errors, rate limits, interrupts, or model switches. A missing part is dropped and the remaining weights renormalised, so unrated sessions still score on survival and friction. Groups with fewer than three sessions get no score.

Drift compares the current ISO week against the trailing four weeks for rating, clean rate, and latency, as a z-score using standard errors. `watch` at |z| >= 2, `alert` at |z| >= 3, and only with five or more sessions in the current week.

This will be wrong in places. It is public so it can be argued with.

## Architecture

```
packages/core     types, classifier, stats, aggregation, redaction, validation. No deps.
packages/cli      `nerfd`. Hooks, local sqlite, commands, `nerfd dash`. No deps.
packages/server   node:http ingest + dashboard. Same aggregation code as the CLI. No deps.
```

Zero runtime dependencies. Node 22.13+ runs the TypeScript directly, so there is no build step. Local data lives in `~/.nerfd/local.db`. The public server keeps one append-only `reports` table.

Data flow:

```
Claude Code / Codex --hook JSON on stdin--> nerfd hook --> ~/.nerfd/local.db
                                                           |
              nerfd sessions / stats / which / drift / dash <--+
                                                           |
                     nerfd share (redacted, explicit) --------+--> POST /v1/reports --> board
```

Claude Code hooks used: SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PostModelSwitch, Stop, StopFailure, SessionEnd. The SessionEnd hook has a 30 second timeout because it parses the transcript and hashes the diff. Codex uses the same hook file shape with fewer events, and its rollout log is parsed for tokens, model, and its directly reported rate-limit usage. Codex fidelity is lower and will stay lower until its hook surface catches up.

The model page, the per-work ranking and the week-by-week change detection are described in [MODEL-VIEW.md](MODEL-VIEW.md); tokens versus limits in [LIMITS.md](LIMITS.md); the behavioural signals in [SIGNALS.md](SIGNALS.md); what leaves the machine in [PRIVACY.md](PRIVACY.md).
