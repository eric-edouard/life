# Moments: what he did, when, where, and what came of it

Goal: `read_day` answers "what did I do today" in one read. Measured on the truth set of 4 Nov
(`~/Life/docs/evals/truth-2026-10-28.json`, `-11-02`, `-11-03`; baseline in `baseline-2026-11-04.md`: 60% of true facts
held, 42% of false ones restated).

What is wrong today (review of 4 Nov, his agreement): a moment is a title; facts don't know their moment; no trip level;
the phone's stays are ignored; things he didn't do become moments (money moved, mail received, his agents' commits);
plans are moments and go stale; a day is read about 10 times, each time in full (one new message changes its
chat-day unit's hash, so the whole day of ~140 units goes again).

His rules for the new shape: overlaps are fine when both truly happened (a call during a drive, a dinner inside a
trip); never two in-person places at once, never one event as several moments; nesting only where it makes sense.

## Milestone 1: score the timeline

- [ ] `scripts/eval.ts --timeline <truth.json>`: the day's moments against the truth timeline, by code, no model,
      reusing `factsRun`'s file parsing. A truth moment is found by a Life moment sharing one of its evidence units and
      overlapping its time. Per day: found, missed, extra (a Life moment matching no truth moment: what the truth's
      prose `notMoments` describe, counted without reading them), start/end within 15 min, place within 150 m of the
      truth's `gps` (the moment's stay, below), `within` right.
- [ ] `scripts/bench.ts` grades with the truth set (its days and facts) instead of the fixed `events-2026-10-16.json` week,
      and prints the timeline score beside the facts.
- [ ] Baseline timeline score of today's moments, added to `baseline-2026-11-04.md`.

## Milestone 2: the new moment

- [ ] `records/moment.ts` v2: `status` and `why` go; `what` (1–3 factual sentences: what happened and what came of it)
      (the moment as it stands; `title` names it, a unit's `summary` is lifelog's, of one conversation) and `within`
      (the id of the moment holding it, or null) come. Only what happened is a moment: a plan stays a fact
      with its `when` (extraction already writes those).
- [ ] The moments call is given the day's stays through `placesOf({at: day})` (`places.ts`, as `read_places_visited`
      reads them) next to the units. Stays are lifelog's: lifelog not read means the day is held, as today (`held`,
      `moments.ts`); `visits` throwing fails the day's attempt, so its verdicts aren't written and it is read again.
      `within` for a new moment names the model's local id (`new-1`), mapped in `parseDay` to the minted id; one
      naming no moment of the reply or of `earlier` is dropped. `prompts/memory-moments.v6.md`: times and places from the
      stays and the turns first; overlap rules above; `within` for a trip or outing; a remote exchange is never in
      person; not moments: money moved, mail and notices received, his agents' work, plans.
- [ ] Code's own guard in `parseDay`: a moment whose units are all repo or agent units is dropped (his agents' work is
      never something he did), the way `importanceOf` already caps repos.
- [ ] A moment's span as instants: `span` moves from `past-events.ts` beside `daysOf` (`ledger.ts`), one function.
- [ ] A moment's stay is derived, never stored: the stay overlapping its span longest, one function in `places.ts`, used
      by the calendar (today inline in `past-events.ts`), the timeline score and `read_day`. `read_day` with lifelog down
      shows the moments with their `place` text and a line saying where he was is unknown.
- [ ] A fact's moment is derived, never stored: `readBy` (`extract.ts` `groupsOf`: the moment reaching furthest, then
      the smallest) moves out as the one rule for a unit's moment; extraction, the calendar's "What Life noted" (today
      by unit, inline in `past-events.ts`) and `read_day` use it, so a fact sits under the dinner, not also the trip.
- [ ] `read_day`: moments in time order, each with its place, people, `what` and its facts under it; then the facts in
      no moment; units after, importance 0 left as a count.
- [ ] The Past calendar: every moment (no status filter); description starts with `what`; location is the stay's
      address and coordinates (his ask), the moment's `place` in the title.
- [ ] Readers follow: `statements.ts` (`momentText` without status; `momentGroup`'s unsure check:51 and the
      `unsure-moment` doubt go, with `fact-checks.ts`:27 and its test), `extract.ts` and
      `prompts/memory-extract.v5.md` (the moment's fields it is shown; wording only, no bump), `search.ts`, `report.ts`,
      `scripts/demo.ts`. `earlierFor` keeps carrying a moment that continues (a trip) but no longer carries plans.
- [ ] Migration `moments-v2-2026-11` (`host/migrate.ts`, his OK first, together with milestone 4's backfill: `why` is
      a reason, not a summary, so it may stand as `what` only until the backfill reads its day): stored lines that are not
      `happened` are dropped; `why` becomes `what`; `within` null. AGENTS.md's "same count, same order" protects the
      ledger cursor; moments' day files are rewritten by code on every reading, so dropping lines there is safe: written
      into AGENTS.md's rename invariant.
- [ ] Docs: `SCHEMA.md` moments section and :341–343, `glossary.md` (moment; `what`; `within`; a new line for stay:
      one place the phone stayed, from lifelog; doubt loses `unsure-moment`), `architecture.md` if it names status.
- [ ] Bench: today's prompt v5 against v6 on the truth set (facts and timeline), then v6 at efforts high / low and
      the hosts he allows. He picks.

## Milestone 3: read only what's new (his choice, 4 Nov: in v6, not a later step)

One way of reading, whether the day is new or read before: the day's current moments are the state, and only the
units not judged on their current content are new evidence (the existing verdict cache, `judged`, `moments.ts`:335;
no new state). A first reading is the same step with no moments yet; so is the backfill.

- [ ] Input: a unit judged on its current content (and not `reread` since) goes as a stub (id, source, times, title,
      its verdict's `reason`), never its text; the others go in full, as today. The day's current moments go with their
      `what` (they already go, as `earlier`).
- [ ] Output: verdicts only for the units sent in full (today's `fresh` already keeps only those); `moments`: the new
      and changed ones only, in full; `gone`: ids of this day's moments no longer true. The day's file is its
      current lines minus `gone`, with the changed ones replaced and the new ones added (`dayFileOf`, which already
      keeps hidden ones). A moment left out is kept as it is.
- [ ] Measured on the bench: tokens per day across the three truth days read as they arrived (in the hourly slices the
      log shows), against v5; duplicates show as extra moments in the timeline score. A night pass that merges a day's
      duplicate moments (moments and stays only, no units) is added only if the score shows them.
- [ ] `docs/operations.md`: how a day is read (stubs, the state, when a unit counts as new).

ponytail: new is per unit, so a chat-day with one new message goes in full (that chat-day only, not the day); per
message would need a record of what was read, add it if the bench shows chat-days dominate.

## Milestone 4: backfill (his OK on the cost)

- [ ] `bun life memory backfill --from 2026-09-06 --to 2026-11-04` under v6: about $4 at today's rate (one read per day,
      ~75k tokens; every unit is new to v6, so each day goes in full once). Extraction is not re-run: facts reach their moment through their unit.

## Later, not here

Apple Screen Time and Hevy workouts as sources (his ideas of 4 Nov): structured, cheap, and they fill what the stays
can't see (work at the computer, the gym).

## Golden rule plan

Inventory (`rg -n "momentsNow|Moment\b|mom_|moments" apps/server/src scripts`):
- made: `memory/moments.ts` (`parseDay`:236, `earlierFor`:103, `CARRY_DAYS`:66, `moments`:373), `records/moment.ts`,
  `prompts/memory-moments.v5.md`; current state `momentsNow` and `daysOf` (`memory/ledger.ts`:88–97).
- read: `extract.ts`:82–110, 467–470 (moment shown to extraction); `statements.ts`:29–55, 127–165 (`momentText`,
  `unsure-moment`, moment claims); `past-events.ts`:61–120 (status filter, `why`, facts by unit inline), 160–185 (stays,
  `where(longest)`); `host/past-calendar.ts` (writes); `search.ts`:109–118, 330–340, 600–640 (`momentLine`, `day`);
  `host/report.ts`, `host/status/snapshot.ts`, `scripts/demo.ts`, `scripts/bench.ts`:39 (fixed facts file).
- stays: `memory/places.ts` (`placesOf`, `where`), `sources/lifelog.ts` (`visits`, `whereAt`).
- scoring: `scripts/eval.ts` (`factsRun`:139, `Facts`:33).
Shape: the moment record stays the one source of a moment; its span, its stay and its facts are derived (span beside
`daysOf`, stay by time, facts by `readBy`), each in one function the inline copies move into. Plans live only as facts with `when`. One
eval script grades facts and timeline; the bench reuses it.
State: `what` and `within` per moment (model output, rewritten with its day). What is new to a reading is derived from
the verdict cache; no new state.
Deletes: `status` and its four values, `why`, the plan wording in `earlierFor` (its `CARRY_DAYS` code stays), the `unsure-moment` doubt, the calendar's
status filter, its inline stay and facts lookups and `span`'s second home, bench's fixed week, prompt v5 once v6 runs.
Net lines: about +260 / −130 (the timeline score is most of the plus; the migration, ~40, leaves after it runs).
Plan review: reshape on the first review (fresh top reviewer, 4 Nov), all taken: one rule for a unit's moment
(`readBy`), `span` moved beside `daysOf`, stays through `placesOf`, `within` local ids mapped in `parseDay`, the
timeline score counts extra moments instead of reading prose `notMoments`, lifelog failure paths said, missed readers
(`fact-checks.ts`, `momentGroup`, SCHEMA.md:341) added, glossary lines for stay and `what`, the AGENTS.md note on
dropping moment lines. Then incremental reading was folded in (his choice): second review: pending.
