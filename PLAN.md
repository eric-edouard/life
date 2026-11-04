# Moments: what he did, when, where, and what came of it

Order (4 Nov): M1 now; M2–M3 start once `claude/screen-time` is merged (its `isActivity` and screen units feed v6); M4 last.

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

- [x] `scripts/timeline.ts <truth.json>`: the day's moments against the truth timeline, by code, no model. Truth and
      Life moments sharing an evidence unit while overlapping match one to one (most shared units, then most overlap);
      a truth moment whose only match went to another is merged (two things read as one). Per day: found, merged,
      missed, extra, duplicates, start/end within 15 min, place within 150 m of the truth's `gps` (`stayOf`, `places.ts`,
      which the calendar now uses too). `within` is scored once M2 adds it.
- [x] `scripts/bench.ts` reads and grades the truth set's days (facts, rated statements, timeline) instead of the fixed
      `events-2026-10-16.json` week.
- [x] Baseline timeline score added to `baseline-2026-11-04.md`.

## Milestone 2: the new moment

- [x] `records/moment.ts` v2: `status` and `why` go; `what` (1–3 factual sentences: what happened and what came of it)
      (the moment as it stands; `title` names it, a unit's `summary` is lifelog's, of one conversation) and `within`
      (the id of the moment holding it, or null) come. Only what happened is a moment: a plan stays a fact
      with its `when` (extraction already writes those).
- [x] The moments call is given the day's stays through `placesOf({at: day})` (`places.ts`, as `read_places_visited`
      reads them) next to the units. Stays are lifelog's: lifelog not read means the day is held, as today (`held`,
      `moments.ts`); `visits` throwing fails the day's attempt, so its verdicts aren't written and it is read again.
      `within` for a new moment names the model's local id (`new-1`), mapped in `parseDay` to the minted id; one
      naming no moment of the reply or of `earlier` is dropped. `prompts/memory-moments.v6.md`: times and places from the
      stays and the turns first; overlap rules above; `within` for a trip or outing; a remote exchange is never in
      person; Screen Time stints date a moment (when he was at a device), never make one alone; not moments: money moved,
      mail and notices received, his agents' work, plans.
- [x] Code's own guard in `parseDay`: a moment whose units are all activity (`isActivity`, from the Screen Time branch:
      repo and screen) or agent units is dropped (what his devices log and his agents' work are never a moment alone).
- [x] A moment's span as instants: `span` stays in `past-events.ts`, its one home now that the calendar's private
      `daysOf` and per-day stays cache went (`search.ts` imports it). Moving it and `daysOf` into `zones.ts` meant
      touching ~15 importers for no second copy: not worth it.
- [x] A moment's stay is derived, never stored: `stayOf` (`places.ts`, M1) picks the stay covering most of its span;
      `placesOf` splits into `staysOf(q)` (read and cut, `Stay[]`) and its formatting. Used by the calendar (its own
      per-day `visits` cache and private `daysOf` in `past-events.ts` go), the timeline score and `read_day`. `read_day` with lifelog down
      shows the moments with their `place` text and a line saying where he was is unknown.
- [x] A fact's moment is derived, never stored: `readBy` (`extract.ts` `groupsOf`: the moment reaching furthest, then
      the smallest) moves out as the one rule for a unit's moment; extraction, the calendar's "What Life noted" (today
      by unit, inline in `past-events.ts`) and `read_day` use it, so a fact sits under the dinner, not also the trip.
- [x] `read_day`: moments in time order, each with its place, people, `what` and its facts under it; then the facts in
      no moment; units after, importance 0 left as a count.
- [x] The Past calendar: every moment (no status filter); description starts with `what`; location is the stay's
      address and coordinates (his ask), the moment's `place` in the title.
- [x] Readers follow: `statements.ts` (`momentText` without status; `momentGroup`'s unsure check:51 and the
      `unsure-moment` doubt go, with `fact-checks.ts`:27 and its test), `extract.ts` and
      `prompts/memory-extract.v5.md` (the moment's fields it is shown; wording only, no bump), `search.ts` (`momentLine` becomes id + `momentText` + units: one rendering), `report.ts`,
      `scripts/demo.ts`. `earlierFor` keeps carrying a moment that continues (a trip) but no longer carries plans.
- [x] Migration `moments-v2-2026-11` (`host/migrate.ts`, his OK first, together with milestone 4's backfill: `why` is
      a reason, not a summary, so it may stand as `what` only until the backfill reads its day): stored lines that are not
      `happened` are dropped; `why` becomes `what`; `within` null. AGENTS.md's "same count, same order" protects the
      ledger cursor; moments' day files are rewritten by code on every reading, so dropping lines there is safe: written
      into AGENTS.md's rename invariant.
- [x] Docs: `SCHEMA.md` moments section and :341–343, `glossary.md` (moment; `what`; `within`; a new line for stay:
      one place the phone stayed, from lifelog; doubt loses `unsure-moment`), `architecture.md` if it names status.
- [ ] Bench: v6 on the truth set (facts and timeline) against v5's numbers in `baseline-2026-11-04.md` (no new v5
      run: a known baseline). Efforts and hosts only if he asks.
- [x] Extraction is not shown `what`: its input keeps its meaning, so `memory-extract.v5` keeps its version.

## Milestone 3: read only what's new (his choice, 4 Nov: in v6, not a later step)

One way of reading, whether the day is new or read before: the day's current moments are the state, and only the
units not judged on their current content are new evidence (the existing verdict cache, `judged`, `moments.ts`:335;
no new state). A moment made by an older prompt is not state, as a verdict by an older prompt is not judged
(`judged`:338): under a new prompt every unit goes in full and no moment is given, so a first reading, a prompt change
and the backfill are all the same step with nothing read yet, and the migrated `why`→`what` never outlives it.

- [x] Input: a unit judged on its current content (and not `reread` since) goes as a stub (id, source, times, title,
      its verdict's `reason`), never its text, and is not fetched (`voiceText` and `unknownIn` run on the full units
      only); the others go in full, as today. The day's current moments go in `earlier`, now with `what`, `end` and
      `within`.
- [x] Output: verdicts only for the units sent in full (today's `fresh` already keeps only those); `moments`: the new
      and changed ones only, in full; `gone`: ids of this day's moments no longer true (never one he hid). The day's
      file is `momentsNow` over its current lines minus `gone`, plus the reply: the one merge rule (the last line wins,
      units and copies unioned), so a changed moment keeps its earlier units; `dayFileOf`'s own merge and `hiddenOn` in it
      go. Kept lines pass `parseDay`'s unit filter: a unit gone (a conversation regrouped) leaves them, a moment with no
      unit left is gone, a `within` naming nothing becomes null. `missing` counts only the units sent in full.
- [ ] Measured in production, from the log (`model.run` tokens per day), a week before and after; screen units counted apart (they change all day and on late
      iPhone syncs, so they go in full each reading); quality on the bench's timeline score, where duplicates show as extra moments. A night pass that merges a day's duplicate moments
      (moments and stays only, no units) is added only if the score shows them.
- [x] Docs say a day reads only what's new: `docs/operations.md` (how: stubs, the state, when a unit counts as new),
      AGENTS.md:124, `architecture.md`:53, the `moments.ts`:54–58 header, `SCHEMA.md`:67 and :89.

ponytail: new is per unit, so a chat-day with one new message goes in full (that chat-day only, not the day); per
message would need a record of what was read, add it if the bench shows chat-days dominate.

## Milestone 4: backfill (his OK on the cost)

- [ ] `bun life memory backfill --from 2026-09-06 --to 2026-11-04` under v6: about $4 at today's rate (one read per day,
      ~75k tokens; every unit is new to v6, so each day goes in full once). Extraction is not re-run: facts reach their moment through their unit.

## Later, not here

Hevy workouts as a source (his idea of 4 Nov): fills what the stays can't see (the gym). Screen Time is its own plan,
`claude/screen-time`, landing before M2.

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
dropping moment lines. Then incremental reading was folded in (his choice); second review: reshape, all taken: `momentsNow` is the one merge
rule for a day's file, kept lines filtered and dangling `within` nulled, older-prompt moments are not state, stubs not
fetched and not counted missing, `earlier` carries `what`/`end`/`within`, tokens measured from the production log (no
replay code), the four docs that say a day reads every unit. Shape unchanged by these: no third review.
