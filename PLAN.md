# The situation, phase 1

His decisions of 5 Nov 2026: a stored situation of where things stand, rewritten nightly, is allowed; his page reads as
his life now, not errands; a close person's page answers "are we still together / do we get along / what's open
between us"; every topic on, sensitive ones included; search answers come with context, not raw data.

**Situation**: where things stand now with him or someone close, read from the last 30 days' episodes; not a page section,
not a fact, never stored about anyone without a page.

## Milestone 1: The situation

- [x] `memory/situation.ts`: per his page and each close person's page, one call (fast model) reading that page's live
      lines (views, health, bond, now, History) and the last 30 days' episodes with them (all of them for his page):
      `id`, day, title, `what`, place, people. It returns a few cited lines; code keeps a line only if every cite is an
      `ep_` id it was shown. Written to `memory/situations/<page id>.md` with the hash of its inputs: no call when the
      inputs are unchanged. Rebuilt from episodes and pages alone, never from its own last version (a projection);
      what fades out of the 30 days lives on in the page's sections and History. Git keeps every version.
- [x] `prompts/memory-situation.v1.md` (his OK on the wording first): may say what a stretch amounts to, in plain
      words, each line cited, who-said-it kept, his words vs. Life's reading marked ("he says" / "his days show").
      His: what his days look like, what he's working on, what weighs on him, what he enjoys, frictions, money, body
      and mind, sex life, how others see him. Someone close: together or not and since when, how they get along
      lately. No diagnoses.
- [x] Runs in the nightly after pages; the night's report counts situations rewritten, not as page changes.
- [x] His correction: a line he writes or keeps on the page (`keep-mine`); the situation reads the page and his line
      wins. At read time a situation line shows only while all its cites are live in `episodesNow`.
- [x] Scope: `personallyClose` people and him; a situation goes when its page goes. Inputs hash includes the prompt
      version; lines carry dates, never "lately".
- [x] `memory-pages.v6.md` (his OK): his page's `now` holds only big things (importance 3, money, legal, health);
      errands stay on the to-do list.
- [x] Tried on a copy (allmodels, high): 15 situations, 2 min; a close person's opens with what they are to each other and what is unsaid since. The 12-question side-by-side waits for the episodes backfill to finish (ep_ ids change on re-read).

## Milestone 2: Context with every search

- [x] `person()` (`search.ts`): the situation first, then "Open with them": the standing to-dos, promises and waiting-ons linked to them, through the timeline's own `latest` query.
- [x] `search()`: a head with the situations of the close people the query names.
- [x] Connector descriptions (one batch, names and arguments unchanged): broad questions read his page first.

## Milestone 3: Docs

- [x] `docs/architecture.md:73,98` and `:63`, `docs/SCHEMA.md:282` ("no churn" holds for pages; the situation is
      rewritten), the `situations/` record in SCHEMA, `AGENTS.md:68` (code also rewrites `situations/`), `:123`
      ("his page is a projection": the situation is one too, of everyone close), glossary line for situation.

## Golden rule plan
Inventory: page sections `apps/server/src/memory/page-format.ts:20-47`, `PageSection` `records/observation.ts:143`;
page call, quiet-page skip and rebuild `memory/pages.ts:270-367`, `:303`; owner edits `page-format.ts:356`;
corrections take `obs_`/`ep_` (`records/observation.ts:167`); open items `openItems` (`todo-list/items.ts:215`) via
`dueOf` (`memory/search.ts:779`); person read `search.ts:468`; search OR fallback already at `search.ts:219`;
claims `claimsNow` (`statements.ts:112`); page changes `changes.ts:149`; "no churn" `SCHEMA.md:282`,
`architecture.md:63`; stored-summary ban `architecture.md:73,98`; glossary "state", "context" taken
(`AGENTS.md:156`, `glossary.md:89`). rg: `layoutOf|SECTION|CITES|PageSection`, `person\(|openItems|dueOf`,
`claimsNow`, `no churn|summary hierarch|Arcs are assembled`, `embedding|vector`, `situation`.
Shape: the situation is its own projection beside pages (own file, own call, own cite check), so pages' no-churn
machinery, sections and owner edits are untouched. Open items reuse `dueOf`. Search heads reuse situation files.
State: one situation file per paged person (his included), owned by the situation step, with its inputs' hash; derived,
rebuildable.
Deletes: the errand flood on his page's Now (prompt rule); the ban on stored summaries; no new open-items query.
Net lines: about +185 / −20 (situation.ts +80, prompts +40, search +30, tests +45, docs +10).
Plan review: reshape → fixed: renamed state → situation (word taken); out of `PageSection` into its own file and call;
cites `ep_` not `unit_`; built from episodes and pages, never its last version; rewritten only when inputs change;
`dueOf` reused; areas dropped from search heads; docs list widened. Second review → fixed: situation lines stay out of
`claimsNow` (no stable ids; ratings and eval keys would churn); his corrections are page lines that win; dead `ep_`
cites hidden at read; scoped to `personallyClose`, deleted with the page; hash includes prompt version. Plan: passes.
Built: "Open with them" uses `latest` on the person's links filtered by type, not `dueOf`: `dueOf` keeps only importance-3 items in a few-day window, so it would miss most of what is open with someone. The search head matches names in the query, not hit counts (fewer lines, no index pass).
Skipped: a switch for sensitive topics (all on, his wish; a setting when he wants one off); week/month digests,
counted sections, daily table, voice signals (phase 2); local embeddings (phase 3).
