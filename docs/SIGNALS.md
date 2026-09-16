# Behavioural signals

Errors and latency tell you what the harness did. They do not tell you whether the person got what they wanted. This document describes the second kind of measurement nerfd takes: **how much the human had to fight the model**, computed locally from a transcript that is already on your disk, and reduced to integers before anything can leave the machine.

Implementation: [`packages/core/src/signals.ts`](../packages/core/src/signals.ts). Tests: [`packages/core/test/signals.test.ts`](../packages/core/test/signals.test.ts) and [`packages/cli/test/signals-wiring.test.ts`](../packages/cli/test/signals-wiring.test.ts). One function, no dependencies, no I/O, no network.

**Wired, end to end.** This is no longer a module waiting for a caller. Every adapter that can reconstruct a conversation produces turns; `finalise()` in [`hooks/handler.ts`](../packages/cli/src/hooks/handler.ts) calls `attachSignals` at session end, which computes the counts and drops the text; `toReport` passes `signals` and `signal_version` into the public record; `validateReport` rejects a record with a string anywhere inside `signals`; `aggregate()` averages the per-session rates into every group; and `GET /v1/friction` is the board built on them. A session from an adapter that cannot produce turns simply carries `signals: null`.

## Why

The AMD analysis of 6,852 Claude Code sessions published in April 2026 did not find a degraded week by looking at error rates. It found it by looking at behaviour:

| AMD finding, degraded weeks vs baseline | Signal here |
|---|---|
| interrupts up 12x | `pushback` (counts interrupted assistant turns *and* verbal refusals) |
| edits without a prior read up from 6% to 34% | `edits_without_read` / `edit_tool_calls` |
| frustration markers up 68% | `frustration` |
| median thinking down 73% | `thinking_ratio` |

Those four are the ones the study named. The rest — corrections, reprompts, clarifications, retries, test failures before a pass, turns to first success, steering ratio, abandonment — are the same family: cheap to compute, hard to fake, and about the *shape* of the session rather than its contents. On the board they are compared week over week against the same model, which is the only comparison that means anything, because a person who writes "ugh" a lot writes "ugh" a lot every week.

## The signals

Every field of `Signals` is a number, a null or a boolean. There are no strings.

| Signal | What it counts | Denominator for the published rate |
|---|---|---|
| `corrections` | user turns that tell the model it did the wrong thing: "no", "that's wrong", "not what I asked", "revert", "you didn't", "I said", "still broken", "you did it again" | user turns |
| `reprompts` | user turns that restate the previous prompt because the first one did not land | user turns |
| `frustration` | user turns containing profanity, "wtf", "ugh", "seriously", "why do you keep", "come on", `!!`, `???`, or two or more shouted words | user turns |
| `pushback` | user turns that stop or refuse the action in flight ("stop", "don't", "wait", "hold on", "abort", "cancel"), **plus** every interrupted assistant turn | user turns |
| `clarifications` | assistant turns that end by asking the user a question instead of acting | assistant turns |
| `edits_without_read` | edits to a file the session had never looked at | `edit_tool_calls` |
| `edit_tool_calls` | edit/write tool calls, the denominator above | — |
| `retries` | a shell command re-run, whitespace-normalised, after the same command failed | user turns (see note) |
| `test_failures_before_pass` | failing test runs before the first passing one; `null` if no test ran | — |
| `turns_to_first_success` | user prompts submitted before the first passing test run; `null` if none ever passed | — |
| `steering_ratio` | total user characters per edit; `null` if nothing was edited | — |
| `thinking_ratio` | summed `thinking_tokens` / summed `output_tokens`; `null` if the tool does not report thinking | — |
| `abandoned` | the session stopped within two minutes of an error, correction or frustration turn, with no assistant turn afterwards | — |
| `user_turns`, `assistant_turns` | denominators | — |

`signalRates()` turns the counts into per-turn rates and returns `null` wherever the denominator is zero. Counts are not comparable between a five-turn session and a two-hundred-turn one, so the board publishes rates; the raw counts travel alongside so an aggregate can be recomputed and a rate with n=2 behind it can be thrown away.

`retry_rate` is retries per **user turn**, not per shell command, because the `Signals` shape carries no shell-command count. Read it as "retries per prompt".

## How they are computed

**Sanitisation first.** Before any phrase matching, `stripQuotedAndCode` removes fenced code blocks, inline code spans, lines beginning with `>`, indented code blocks and URLs. A pasted stack trace containing "no such file" is not a correction; a diff containing `if (!ok) return` is not pushback. An unterminated fence swallows the rest of the turn, which loses markers rather than inventing them — the direction we want.

**Structure second.** Corrections and pushback only count when the turn is at most 400 characters *and* the nearest earlier speaker was the assistant. A refusal is a reaction; a 2,000-word spec that happens to contain the word "stop" is not. Frustration is not gated this way, because people vent at length.

**Marker table third.** All the phrase detectors live in one exported array, `SIGNAL_MARKERS`, each with a stable id, a regex, an optional suppressor regex, and a note saying what it deliberately does not catch. A change to a detector is one line in a diff. The suppressors exist because the obvious word lists are wrong more often than they are right:

| Turn | Naive verdict | Actual verdict | Why |
|---|---|---|---|
| `add undo support to the editor` | correction | nothing | the `revert` marker is suppressed when "undo"/"revert" is the object of a feature request |
| `stop the server and restart it` | pushback | nothing | "stop" with a piece of infrastructure as its object is an instruction |
| `don't forget to update the changelog` | pushback | nothing | the verb list excludes "forget", and a suppressor catches it anyway |
| `run the tests again` | correction | nothing | "again" only counts after "you/it/that/this", and "run … again" is suppressed on top |
| `the API returns JSON but the URL is wrong` | frustration (shouting) | nothing | `ACRONYM_ALLOWLIST` covers ~160 tech acronyms, and `FOO_BAR` constants are excluded |
| `that was seriously good` | frustration | nothing | "seriously" as an intensifier for praise is suppressed |
| `no problem, carry on` | correction | nothing | "no problem/worries/idea/rush" openers are suppressed |

**Reprompts** compare content-word sets (stopwords dropped) of consecutive user turns with an overlap coefficient — shared tokens over the size of the *smaller* set, because a reprompt is usually a shorter restatement and Jaccard punishes that asymmetry. At or above 0.6 it is a reprompt however long the pause was. Between 0.4 and 0.6 it only counts when it arrived within three minutes with no tool call in between: "same intent, quickly, and the model did nothing" is the closest honest approximation of intent we can make without a classifier.

**Edits without read** keeps two local sets for the duration of the call: full normalised paths, and basenames. A path enters them from a `Read`-family tool call, from a path-shaped argument to a read-ish shell command (`cat`, `head`, `grep`, `rg`, `sed`, `git`, …), or from a previous edit — once you have edited a file you have seen it, so only the *first* edit of an unread file counts while the denominator counts them all. Basename matching is there because adapters mix absolute tool paths with relative shell paths; it under-counts rather than over-counts, which is the right direction for a public number. Edits with no path reported land in the denominator only.

**Abandonment** finds the last friction event (a failed tool call, a correction or a frustration turn), and is true when no assistant turn follows it and the session's last timestamp is within two minutes of it.

## Known false positives and false negatives

Stated plainly, because these numbers will be public and someone will check.

- **All of it is heuristic and English-only.** A session conducted in another language scores near zero on every phrase detector. Its counts are not zero because it went well.
- **Corrections are under-counted.** The suppressors are deliberately aggressive. "try again" and "no need to do that" are both genuine corrections that this version drops.
- **`pushback` conflates two things.** A user pressing escape and a user typing "stop" are one counter. That is intentional — both mean "not this" — but a tool whose adapter cannot report `interrupted` will look calmer than one that can. Compare models within a tool, not across tools.
- **Frustration is a personality measurement as much as a session measurement.** Some people swear at everything. This is only meaningful as a week-over-week delta for the same reporter population, which is how the board uses it.
- **`clarifications` cannot see thinking-time questions.** A model that asks a question and then acts in the same turn is not counted; a model that asks and stops is. Adapters that flatten a turn differently will differ here, which is why `ends_with_question` can be precomputed by the adapter.
- **`edits_without_read` misses reads via a tool the regex does not recognise**, and treats a basename collision (`index.ts` in two directories) as a read. Both push the number down.
- **`retries` counts an identical command string only.** `npm test` then `npm test -- -t foo` is not a retry here, though a human would call it one.
- **`test_failures_before_pass` depends on `ok`.** A test runner that exits 0 while printing failures is recorded as a pass. Test runs with no `ok` reported are ignored entirely.
- **`turns_to_first_success` uses the first passing test run only.** The interface cannot see reverts, so "the first edit that was not later reverted" is not computable here; code survival is measured separately by `nerfd check`.
- **`steering_ratio` counts raw user characters**, including pasted logs, so a session where someone pasted a large stack trace looks heavily steered.
- **`abandoned` cannot tell "gave up" from "went to lunch".** A session ending two minutes after a failed command is a plausible give-up, not a proven one.

Rough expectation, from reading the marker table against real sessions rather than from a labelled corpus: precision is good (few false alarms) and recall is poor (many missed signals), by construction. Treat every count as a **lower bound**. If someone builds a hand-labelled sample, the numbers belong in this section and `SIGNAL_VERSION` gets bumped when the detectors move in response.

## What leaves the machine

Nothing in this module handles I/O or network. `computeSignals` takes turns and returns numbers; the caller decides what to do with them.

What **is** published, when sharing is on: the integer counts and the boolean listed in the table above, and `SIGNAL_VERSION` next to them, so a public row says which version of the detectors produced it. The rates are derived from those counts by `signalRates()` on the way into an aggregate rather than sent separately. Nothing else exists to publish — the return type has no string field. `GET /v1/friction` serves the group-level rates; `nerfd privacy` prints the counts for your last session before any of it moves.

What never leaves, and is never even retained past the end of the call: prompt text, assistant text, tool output, shell commands, file paths, marker ids, matched substrings, offsets. Text is sanitised into a local variable, matched against regexes, and dropped when the function returns. File paths live in a `Set` only so that "was this file read before it was edited" can be answered at all.

There is a test, `computeSignals returns nothing but numbers, booleans and nulls`, that walks the returned object and fails on any string. It is the zero-transcript rule from [PRIVACY.md](PRIVACY.md) enforced mechanically rather than by review.

## Versioning

`SIGNAL_VERSION` is currently `1`. Bump it in the same commit as any change to a detector, a suppressor, a threshold or the marker table, so that counts from different code are never silently pooled in an aggregate. The constants that a reviewer is most likely to want to argue with are exported for exactly that reason: `MAX_REACTION_CHARS`, `REPROMPT_OVERLAP`, `REPROMPT_OVERLAP_FAST`, `REPROMPT_WINDOW_MS`, `ABANDON_WINDOW_MS`.

## A local classifier, later

`localClassifierAvailable()` returns `false` and always will until someone builds the thing behind it. The regexes are a floor: they miss sarcasm, terseness and every language but English. A small model running on the same machine would do better without breaking anything, and the shape is written out in a comment at the bottom of `signals.ts`: detect an Ollama or OpenAI-compatible runtime on loopback only, send one turn at a time asking for a single label from a fixed set, keep the label, discard the turn, publish the same counts. Explicit opt-in, a bumped `SIGNAL_VERSION`, and a fall back to the regexes on any failure.

No network code exists in this package today, and the stub is there so that the intent is reviewable before the capability is.
