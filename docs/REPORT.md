# nerfd report: your own usage, beautifully

## The call: local web, not native

`nerfd report` builds one self-contained HTML file from the local database and opens it. No server, no port, no network, works on every OS the CLI runs on, and the same file can be saved, printed, or shared. It uses the nerfd design system (system UI type, SF Mono numerals, Mac dark greys, hairlines, provider logos inlined), so on a Mac it reads as native.

Why not a native app: it would be a second codebase for one platform, it could not reuse the aggregation the board already trusts, and the thing people want to do with a report is look at it and send it. A menu-bar companion can come later if demand shows; it would only render this same page.

## What the report is

A monthly statement for your AI usage, in the order a person asks the questions.

1. **This month at a glance.** Sessions, hours, successful sessions, tools and models used, plans detected. One line in words: "You ran 84 sessions across three tools. 61 succeeded. Your Max 5x plan bought about $410 of API-equivalent work."
2. **What did it cost, what did I get.** Per plan: price, API-equivalent value, multiple, cost per successful session, share of spend wasted on reverted or poorly rated work, limit-wall hits with peak window usage. For local models: billed zero, hosted-equivalent saved. For API keys: actual spend at list price.
3. **Your ranking.** Models ranked by your own score with n, and a category-by-model grid showing which model won for which kind of work, which is `nerfd which` as a picture. Rows carry family, provider and quant, so a local q4 and a hosted fp8 of the same weights never merge.
4. **Where it went wrong.** Errors, rate limits, timeouts, context-limit hits by model and by week. The friction signals: corrections, re-prompts, pushback, frustration, clarifying questions, edits without read, abandoned sessions, each per model with a bar. A short list of the roughest sessions (time, tool, model, category, duration, what went wrong in counts) so you can remember what happened. Nothing textual: no prompts, no paths, unless `--projects` is passed, which labels sessions by folder name for your eyes only.
5. **Drift, for you.** Week-over-week score per model from your own sessions, with the same change-detection flags as the public board.
6. **Share card.** A 1200 by 630 card summarising the month with no identifying information: models, scores, plan value, friction. Rendered to PNG in the page with a copy button and a suggested caption. This is how a personal report turns into a public post and an install.

## Design

- One column, 720px reading width, sections separated by hairlines, generous space. Numbers in tabular mono; prose in the system UI face. Every number has a unit and an n.
- Charts are inline SVG built from the data at generation time: horizontal bars, small multiples for weekly series, a heatmap grid for the category-by-model matrix. No chart library.
- Light and dark from the OS; print stylesheet so it becomes a clean PDF.
- Empty states that tell you what to do: "No Codex sessions yet. Codex is hooked; the next session appears here."
- The same design tokens and logo set as nerfd.ai, so the personal report and the public board look like one product.

## Implementation

- `packages/cli/src/report/data.ts`: builds a `ReportData` object from local rows using the shared aggregator (`aggregate`, `planSummaries`, `reporterMonths`, `drift`, `tierModels`, signal rates). Pure; testable.
- `packages/cli/src/report/html.ts`: renders `ReportData` to HTML with inline CSS, SVG and the share-card script. Logos inlined as data URIs from `packages/server/assets/logos`.
- `nerfd report [--weeks 4] [--out path] [--no-open] [--projects]`: writes `~/.nerfd/report.html` by default and opens it with the OS opener.
- `nerfd dash` stays as the live board; `nerfd report` is the document.
- Privacy: the report contains hashes and counts only unless `--projects` is passed. A test renders a report from sessions with distinctive prompt text and paths and asserts none of it appears in the HTML.

## Later

- A weekly reminder that a new report is ready, optional, local.
- Menu-bar companion on macOS showing this week's score and opening the report.
- Team mode: several installs on one shared local database for a small team, aggregated the same way.
