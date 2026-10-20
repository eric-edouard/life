# Relationships: arcs, dynamics and change over time

The plan and its decisions, the source of truth for this work (agreed with the owner, 20 Oct 2026). Each step lands as
its own PR; tick it here when merged. His own material (which people, the evals with their real names) stays in
`~/Life/docs/`, never here.

## The problem

Asked "what is my arc and dynamic with <a close friend>?", Life answered with the last week's logistics (20 Oct). What
still causes it once the read path stopped narrowing quietly (step 1):

- **No home for what lasts.** A person's page has only Now (a line ages into History after 21 days) and History (30
  lines, 800 words). "He is my best friend" or a boundary he set ages out like a booking. Only the owner's own page has
  a section that never ages (Views).
- **Old facts can't be corrected by evidence.** Extraction shows a moment the earlier facts of its people from the 14
  days before it only (`priorFor`), so only a recent fact can be retired by a later one.
- **Memory starts on 6 Sep 2026,** but the archive holds WhatsApp from July 2025 and iMessage from 2015.
- **Relationship texture may be triaged low** (salience 1 is never read in full): suggested by samples, to measure.

Design intent kept: pages are the one compressed layer, every line cited; no fact database, graph, contradiction
resolver or summary hierarchy (`handoff.md`). Time is already modeled: said (`at`), valid (`validFrom`/`validTo`), event
(`when`), recorded (`madeBy.run`), retired (`supersessions.jsonl`), and every page version is in `~/Life`'s git.

## Decisions (the owner, 20 Oct)

1. Fix the read path first; backfill after.
2. Pages update at the midday runs too (13:00, 19:00), not only at night: only pages with new observations.
3. Person pages get a section that never ages: the relationship (role, agreements, boundaries, dynamics, turning
   points), each line cited and attributed; a line with no new evidence in 12 months moves to History.
4. Who gets a page and that section comes from a **closeness level, judged by a model** on numbers code counts from raw
   signals only (two-way 1:1 message days, voice presence, how recent), never from model output (no feedback loop).
   Personal and work closeness are separate scores; a person can have both. Service accounts are not people. Family
   and partner keep a floor (the judging prompt's rule: close family is close whatever the counts). The owner can override any level in a sentence. No list he has to keep.
5. Index everything: no per-person opt-out. (He has his close friend's approval to process his voice.)
6. Relationship moments (agreement, boundary, conflict and repair, trust, a change of role) count more for close
   people, from the next prompt versions on.
7. Names: misheard and other spellings resolve to the person ("did you mean"), and the owner's Contacts name the
   handles Life can't place.
8. Backfill from July 2025, every channel of each day, after a one-month pilot; earlier years later.
9. Not now: lifelog's voice search (its lexical leg keeps the newest 200 candidates; reading by month avoids it).
10. Arcs are put together when asked (the relationship section, History, paged evidence, moments, a month timeline),
    never stored as a summary.

## Steps

- [x] **1. Honest read path** (no data change): `person` shows the whole page and when it was built, what its evidence
      covers (by source, first and last), a month-by-month timeline, and pages back through every observation and
      moment linked to the person (`before`); `search` applies `from`/`to` to every section; `chats` honors `from`/`to`,
      says when it cuts, and pages back (`before`); a name no one goes by answers so and lists near names.
- [ ] **2. Backfill-safe foundation:** zones sorted by `from` and his zone timeline from July 2025 (<city>, with the
      France trips from his bookings); `gather` bounded by a `to` and run month by month, releasing the lock between
      months; no file descriptions for backfilled days (the tag only).
- [ ] **3. Closeness:** code counts (1:1 only, personal and work apart), a model judges the level with a reason (only
      when the counts moved), his overrides as corrections; the level replaces today's page rule.
- [ ] **3b. Contacts:** his Contacts name the handles Life can't place.
- [ ] **4. Prompts and the relationship section:** triage and extraction weigh relationship moments for close people;
      pages v5 adds the section (cited, attributed, "since / last evidence" by code, aging after 12 months);
      `priorFor` also shows the observations that section cites, whatever their age; the newer of two conflicting
      facts wins on the page.
- [ ] **5. Pages at midday.**
- [ ] **6. Pilot:** one month of backfill, every channel; measure cost, new inferred people, eval.
- [ ] **7. Backfill** July 2025 to September 2026, oldest month first.

## How we know it works

An eval of arc questions (one per close person, his ratings as the key), run before and after each step, in
`~/Life/docs/evals/`. Cases: a foundation older than 21 days or than the memory; a turning point under 30 newer
logistics lines; a boundary still shown after 60 days; a correction of a fact older than 14 days; a fact homed on
another page reached from `person`; more than 12 recent observations; more than 200 old messages; a misheard name; and
an answer that says what its sources don't cover. `bun scripts/eval.ts` (events and `--ratings`) must not score worse.

## Known limits

No calls (no structured call records), no unrecorded time together, no location history before lifelog's; a spoken
claim about someone else is capped at 0.6 confidence.
