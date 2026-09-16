# Contributing

Thanks for looking. nerfd is small on purpose: zero runtime dependencies, Node runs the TypeScript directly, and every number on the site is computed by code in this repository. That makes it easy to read end to end, and easy to argue with.

## Ground rules

These are the product, so a change that breaks one will not be merged however good the code is. The reasoning is in [docs/METHOD.md](docs/METHOD.md).

- **Counts, never conversations.** Nothing that could identify a person, a project or a prompt leaves the machine. New fields in the public record go through `toReport` in `packages/core/src/redact.ts` and `validateReport` in `packages/core/src/validate.ts`, and every string field needs an allowlist or a reason it cannot carry text. `nerfd show last --public` must keep printing exactly what is sent.
- **Show n and an interval, never a bare average.** A new metric on a page carries its sample size and, where it is a rate, an interval.
- **Change detection, not accusation.** Wording on the site and in generated posts says what moved and by how much. It never says why.
- **Same number everywhere.** The CLI, the personal report, the board and the model pages all call `aggregate` in `packages/core/src/aggregate.ts`. Do not compute a metric twice.
- **No dependencies.** Not in `packages/*`. Dev dependencies are TypeScript and the type packages only.

## Setup

```sh
pnpm install
pnpm typecheck
pnpm test
NERFD_HOME=/tmp/nerfd-dev pnpm nerfd sessions    # an isolated data directory
NERFD_HOME=/tmp/nerfd-dev pnpm nerfd dash        # the board over that directory, at http://localhost:8787
pnpm server -- --port 8787 --db /tmp/reports.db   # the public site, locally
```

Node 22.13 or newer. Tests are `node --test`; put new ones next to the existing ones under `packages/*/test/`.

## Good first contributions

- **An adapter for a tool we do not cover.** Read [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for the shape (`detect`, `install`, `normalise`, `ledger`, `turns`, `backfill`) and copy the closest existing adapter in `packages/cli/src/adapters/`. Every adapter has a test with a fixture of the tool's own files; commit fixtures with all content replaced, never real transcripts.
- **A behavioural signal.** See [docs/SIGNALS.md](docs/SIGNALS.md). Signals take turns in and return integers; a new one bumps `SIGNAL_VERSION` and comes with markers, known false positives and a test.
- **Pricing and family data.** `packages/core/data/model-families.json` is the table that turns a raw model id into family, version, size and release date. Missing or wrong entries are easy fixes with a test in `packages/core/test/modelref.test.ts`.
- **The method.** If a statistic here is wrong, say so in an issue with the numbers. The formula is public because it is meant to be argued with.

## Pull requests

- One change per PR, with the test that shows it.
- If it touches what leaves the machine, say so in the description and update [docs/PRIVACY.md](docs/PRIVACY.md).
- Keep the tone of the pages: numbers, no adjectives, no exclamation marks.

## Reporting a privacy problem

If you believe something identifying can leave a machine, open an issue titled "privacy:" with the field and how it gets there, or email the maintainer via the address on the GitHub profile if you would rather not post it. It will be treated as the most important issue in the queue.
