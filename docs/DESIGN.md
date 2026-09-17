# Website direction

The approved website style is the ivory, ink and electric-blue design in
`packages/server/assets/design.ts`: system typography, strong editorial headings,
restrained green accents, native controls, animated SVG charts and generous space.
Preserve this visual direction when extending the site. Respect reduced-motion
preferences and keep example data explicitly labelled.

## Positioning

nerfd is a community-sourced benchmark for AI coding models, measured against
actual outcomes from real work. That is the main idea and the reason to contribute.
The personal scorecard is a useful benefit of installing the collector, not the
product's primary identity.

Lead with the collective evidence: code survival, user-rated outcomes, clean
sessions, steering, differences by task, and changes over time. Explain how
contributing redacted session measurements helps build an open public record.
Keep the open collector, open scoring method and open dataset visible.

Present the public benchmark before the personal report. The report explains
what contributors get for themselves: which models work for them, plan value,
limits and friction. Sharing remains a choice; local reports work without it.

Explain the limits precisely. Controlled tests measure capabilities in a test
setting. Community outcomes add evidence about everyday use. Observational
rankings reflect different tasks, tools and people; they are not controlled
experiments or proof of a universally better model. Preserve sample thresholds,
counts and links to the method. Do not claim all conventional benchmarks are
worthless or that community data removes bias.

## Community accountability and privacy

Lead with community-led model accountability: people doing real work can check
model-lab claims against independent, inspectable evidence. Include positive and
negative outcomes, improvements and regressions. The mission is accountability,
not simply another leaderboard or a personal usage tracker.

Keep privacy claims specific: prompts, code, paths and project names stay local.
Shared metrics use weekly rotating pseudonymous identifiers. Do not describe
public measurements as completely private or guarantee that they are anonymous.
The public metadata may allow re-identification; link to the privacy statement.

## Evidence-page UX

Rankings should answer a question before exposing every metric. Keep comparison
controls scoped to what they actually filter; language and grouping belong to
the detailed session table. Surface the selected comparison metric in the table.
Carry the chosen time window into model links.

The model library supports search and sorting, and distinguishes ranked models
from those still building evidence. Model records lead with sample coverage,
task results and observed change. Use a keyboard-accessible weekly chart inspector
and progressive disclosure for raw weekly rows, conversation signals and setup
breakdowns. Keep animation restrained and respect reduced-motion preferences.

## Table-first rankings

The rankings page is a compact comparison tool. Do not add a large introductory
heading, aggregate-stat cards, podium cards, a sidebar or explanatory blocks
above its table. Put the first results within roughly 300px on desktop and
400px on mobile. Use one toolbar for task, ranking metric, period and search.

Keep header sorting and the ranking selector synchronised. Store view, filters,
search, direction and optional columns in the URL. Keep models without enough
evidence in a collapsed list with a clear reason. Do not show unrecorded ratings
as zero or imply that an unrated composite is a human quality assessment.

Use separate Models, Providers, Plans, Changes and Evidence tabs. Retain legacy
section links by mapping them to the appropriate view. Load each view when it
is needed, honour the selected period, and label the scope of task filters.

Comparison controls should be one-click segmented choices on wide screens and
compact selectors on phones. The standard desktop table includes human rating,
reliability and cost alongside the score. Keep phone rows compact and expose the
full metric breakdown through a keyboard-accessible row disclosure. Extra columns
are optional and persist in the URL; sorting must retain keyboard focus.
