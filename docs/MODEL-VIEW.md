# Model view, kinds of work, and change over time

Three questions a person brings to the board: *how good is this model*, *at what*, and *has it changed since it came out*. The model page answers all three from the same aggregator as the tier table, so a page and a table never disagree.

## Pages

| Path | What it is |
|---|---|
| `/model` | Every model on record, linked, with sessions and score in the window. |
| `/model/<id>` | One model: rank in the field, standing per kind of work, week-by-week score with change flags, friction, hosts, and where it ran. `?weeks=8|13|26|52`. |
| `/board?category=<work>` | The whole board filtered to one kind of work. The chip row at the top writes this parameter, so a filtered board can be linked to. |

Every model name on the landing page and the board is a link to its page. Table headings on the model page and the tier table sort on click.

## Endpoints

`GET /v1/model?id=<model>&weeks=26&min=10` returns:

- `overall` - the model's tier, score and rank among models with `min` or more sessions, plus a standing per criterion: tier, value, rank, and the best model on that criterion.
- `categories` - one row per kind of work the model has done, ranked inside that work's own field. `eligible` is false below the minimum; the row is still listed with its n.
- `weekly` - one point per week: score, the field's score that week on the same formula, quality, reliability, steering, survival, latency, errors, the tools and effort levels that ran it, and change detection against the trailing four weeks (`rating_z`, `clean_z`, `steering_z`, `survival_z`, `latency_z`, `flag`, `moved`).
- `changes` - the weeks that carry a flag.
- `shift` - the earliest weeks on record against the latest, with a verdict: `worse`, `better`, `mixed`, `steady` or `insufficient`.
- `identity` - family, vendor, version, release date (day from the catalogue, else month from the family table), serving modes, providers, tools and plans.
- `breakdown` and `hosts` - the same model by tool, plan, language, size and effort, and the same weights on every host.

`GET /v1/work?weeks=8&min=10` returns one card per kind of work with the top five models inside it, best first, and how many models reached the minimum.

`GET /v1/tiers?category=<work>` now echoes `category` so the page can say "For debugging, ...".

Automated sessions are excluded from all three, as from every quality board.

## Did it get nerfed, and when

The board's drift table compares only the latest week. The model page runs the same test on **every** week, against that week's trailing four, so the answer to "when" is a week, not a shrug:

- Five metrics: rating, clean-session rate, steering, code survival, latency. A move is |z| ≥ 2 in either direction, reported with its sign normalised so *worse* always means worse.
- A **flag** (watch ≥ 2, alert ≥ 3, on the worst move in the bad direction) needs five sessions in the week. A move is reported whenever it is measurable, so a thin week can still say what it saw.
- The **field line** is every model that week on the same formula. A dip the whole field shares is not one model's.
- The **release marker** is the catalogue's release date, or the family table's month. When the first session on record is long after release, the chart says how many weeks after.
- The **shift** card compares the earliest period on record with the latest. Each side grows week by week until it holds five sessions, up to four weeks, and the two never overlap. Under five sessions a side is `insufficient`, and the page says which side is thin.
- Tool and effort are listed per week because a harness change looks exactly like a weights change from here.

The tone rule from docs/PLAN.md holds: change detection, not accusation. The page says "worse than when it arrived" with the z-scores beside it, never "nerfed".

## Kinds of work

Categories are inferred on the reporter's machine from the person's side of the conversation: the opening prompt counts double, the next seven user turns refine it, one enum value comes out (`classifyTexts` in core). This runs when a session ends and when history is imported, so backfilled sessions are classified too; before this they were all "other" for want of a prompt. `nerfd backfill --refresh` reclassifies sessions already on record, and `nerfd share all --resend` sends the corrections; the server never counts a correction to an existing record against the daily cap. A category the person set with `nerfd rate` is never overwritten.

Display names on the pages: code → writing code, debug → debugging, refactor → refactoring, review → review and explanation, ux → UI and styling, strategy → planning and architecture, writing → docs and prose, research → research, ops → infra and shell work, other → unclassified work.
