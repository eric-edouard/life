# The path: reaching the spec in small steps

## Prove first (his decision, 10 Nov evening)

Before the layers are built as PRs, the spec's big bets are tested cheaply on the benchmark. A layer is built
properly only when it moves the score. The bet most at risk: that stored summaries beat an agent reading raw data
(today's agent, with search and raw chats, already passes 8 of 12).

1. **Grow the cases to about 40**, most of them relationships, arcs and himself, from his own words and the mined
   questions (`docs/memory-rework/02b-`, `02c-`), each stating today's truth.
2. **Counts in the person read** (who starts, reply times, deletions per pair: `pairCountsOf` already computes them
   for personas). Test: does C1's "he reaches out first" pass once an agent can see them.
3. **One history by hand** for his father and his close friend (month, year, story, from facts Life holds), served
   to the agent beside the connector. Test: C1, C4, C19 and the new arc cases, with and without it.
   **Done 10 Nov, night** (`docs/memory-rework/experiments/2026-11-10-prove-first-1.md` in his data): points held,
   of 40, none 22, counts 23, history 24, both 24. Counts fixed "who reaches out" (C1); a history fixed the friend
   over the years (C19). Nothing else moved; the mined cases ask for exact dated facts and may be narrower than a
   fair answer. Not proved, not disproved; one run per way.
   **Round 2, 11 Nov** (`…/2026-11-11-prove-first-2.md`): on all 57 owner cases two identical baselines gave 18
   and 15 passed (138, 130 of 198 points); on the 27 people cases history and counts as notes stayed inside that
   noise. Next: the history inside the person read, several runs per way.
   **History in the person read, 11 Nov** (`…/2026-11-11-history-in-page.md`): on the 8 cases about the two,
   points 13, 16, 17 of 24 with it against 11 to 16 (mean 13.6) without; C1 and C4 better every run. A small,
   steady gain: the history goes into the person read, built properly.
4. Then build, in path order, only what moved the score. The pilot's prompt tuning waits (round 2's wording is
   enough until a layer consumes the codes).


## Before the full rebuild: the data sessions (11 Nov, evening)

**12 Nov, 01:40: the data is in.** The history import session handed off and closed: 8,674 day files; Photos on
(2,998 photo-days since 2003) and Apple Health on (796 days since 2022); photo zones applied, 10 days still undated
(travel days; life#453); photo descriptions from 7 Sep 2026 only (older ones parked, life#451); the voice model switch
done. Nothing in the data blocks the rebuild any more. Open on that side: life#435, #451, #452, #453, #455. The voice
naming session still has its phone side. A hand-run `life memory units` must load LIFELOG_TOKEN.

Three other sessions prepare the data. The code work of the path starts now, in shadow; only the full rebuild (the
backfill over his history) waits.

| Session | State | The rebuild waits for |
|---|---|---|
| Speaker re-split (Nemotron's speakers on the Scribe-era recordings) | Done and run, 11 Nov: 2,856 jobs relabeled; words, turns and unit ids unchanged; a relabeled conversation-day's unit hash moves at its next build | Nothing. Archived 11 Nov |
| Voice naming (bench, queue, rechecks) | Phone side and an AI naming measurement left, about half a day | Nothing more: the MECT-B2 switch ran and recognition finished 11 Nov 22:21 (his answer: "Yes MECT-B2, before rebuild"). On his answers, turns named right went from 54% to 62%, wrong names from 6.8% to 4.7%; 79 voices wait in his naming queue. Names keep moving a little with his answers, by design |
| History import (Apple Health merged, off; Photos and assistant imports building) | About 3 to 5 hours, then his choices | Photos on (merged 11 Nov, PR 432, still off: his yes after the cost of re-reading about 56 recent days), its per-photo descriptions only from September 2026 on (his word, 11 Nov: labelling starts when lifelog did; old photos are parked, so the rebuild does not wait for them). The 23 undated days of 2025–2026 are published (PR 434). Photo zones as evidence for old days, done before the rebuild (his yes, 11 Nov: settles about 26 of 35 older undated days, rewrites those history units; free now, since no model has read old years). Assistant replies stay out of memory (his answer, 11 Nov: no) |

Taken into the path: naming unknown voices from the day's context goes into the per-exchange read (a model-owned
layer, never lifelog), once the naming session's numbers are in. **The numbers (11 Nov, 120 voices he had
answered, old voice model):** the reading alone names 72 of 80 known voices, 66 right; where it agrees with the
voice model's first guess at 0.8 or more, 50 named, 50 right, and none of 40 strangers named. So: agreement is used
at once, as Life's reading; the reading alone is a suggestion for his naming queue, never a name. To measure again
on MECT-B2, and on a per-exchange call (the test paid one call per voice). To check when Photos merges: its read cost in the
watcher's 5-minute sync of today. Once Photos is on: a new baseline of the question cases, and a few cases only
photos can answer (an old trip, who was there), from his own words.


Draft of 10 Nov 2026, at his ask: reach the whole [spec](../spec.md) iteratively, never break the working state,
and never open one huge rework PR. This is the skeleton of the build plan; each step still gets its own golden-rule
plan when it starts. Checked against today's code: a night is a list of named steps (`host/nightly.ts`: episodes,
extract, closeness, pages, situations, appointments, personas), a step's failure is logged and does not stop the
night, and outputs already have an on and off switch (`core/outputs.ts`).

## The rules that keep Life working

1. **Beside, never in place.** A new record gets a new file. No stored line is rewritten (already an invariant).
2. **Shadow first.** A new layer is written each night while no feature reads it. It sits behind a setting that is
   off in code and on only in his settings, so a bad night is fixed by switching it off.
3. **Compare, then move one reader.** A reader (one section of one read, one section of a page) moves to the new
   layer once that layer passed its row of the spec's section 15. One reader per PR.
4. **Then retire.** When the last reader left an old layer, the next PR stops writing it and deletes its code. Its
   files stay on his disk.
5. **One concept per PR**, each passing the check, with its regression case and its verdict, merged alone. No
   long-lived code branch.
6. **A step never needs the next one.** After any PR, Life is whole and a little better; the work can stop there.
7. **The connector changes once.** Until then, existing reads return better content under the same names and
   arguments. New reads land together in one batch near the end.
8. **Code ships ahead of history.** A new read runs on new days from the day it is switched on. Old years are read
   later, in weeks, by the backfill that exists today, after its cost is shown.
9. **A new step never changes what an old one already read.** In particular a unit's hash must not move, or the
   whole archive would be read again.

## The stages

Each line is one PR unless it says otherwise. "Shadow" means rule 2. "Deletes" is what goes once it has moved.

### Stage 0, re-read against today's code (10 Nov, at the start of the build)

The stage below was drafted from an older tree: `main` had moved 54 commits (the history import, passages for
search, the phone source). Read against today's code, part of it already exists:

| Step | What today's code already has | What is really left |
|---|---|---|
| 0.1 The exchange | The rule exists once, inline: a quiet of 6 hours in the persona's pair counts (`personas.ts`, `OPENS_AFTER`). Search has its own, different cut (`passages.ts`, 30 minutes) | Give the cut one home; size his chats with it |
| 0.2 Reactions, reply links, deletions | Deletions are carried (`deleted` on a message). Reactions are filtered out; reply links are not read | Reactions and reply links, with the other session, which owns the sources |
| 0.3 Measures | The persona already counts per pair: who opened, median answer time, deletions each way, days | Per exchange: left unanswered, last word, shares. Added when a reader needs them, not before |
| 0.4 Coverage | A person's page says what Life holds by source and month (`coverageLines`) | A record of days a source was not captured |
| 0.5 Hours | Nothing | As drafted; low value until an episode names a project |

**Done and merged, 10 Nov** (life PR 412, verdict: debt reduced): `exchangesOf` in `memory/exchanges.ts`, the persona's counts over it with an
unchanged result, one helper for messages by chat, and `scripts/exchange-sizes.ts`. Its numbers are in the spec,
section 16.

**Done and merged, 10 Nov** (life PR 414, verdict: debt reduced), the pilot harness's first PR: one packer
(`packed`, `core/lists.ts`) for extraction, a day's part and exchange batches (`batchesOf`); the night's read with
people leaves out bulk mail and Life's own output once; `CHARS_PER_TOKEN`; the sizes script counts real batches and
shows one person at a time. The pilot's written part is sized in the spec, section 16.

**Done and merged, 10 Nov** (life PR 415, verdict: no debt added, after two full verdicts): the read runner,
`scripts/memory-pilot.ts <read> <person>… [--run] [--engine <engine>]`, dry unless `--run`, and the connection
read's first wording (`prompts/memory-connection.v1.md`). A batch as lines a reply can cite (`batchLines`); a move
kept only inside an exchange the batch holds, its words found there, who and when from the message; a reply kept
as given under the wording and the input, never asked twice; one `inputsOf` for every step's inputs digest. Dry run
on the pilot's two people: 58 and 27 calls, at most 0.86 and 0.43 million tokens of input for this read.

**Done and merged, 10 Nov** (life PR 416, verdict: no debt added): question cases, the benchmark's first piece.
`bun scripts/question-cases.ts [--only id,…] [--run]`: his question cases (`~/Life/docs/evals/question-cases.json`,
12 so far) asked to a headless Codex whose only tools are the connector's reads (`buildServer(true)`), on a state
dir of its own linked to the live one (`linkState`), each reply checked by the eval judge; results in his data
(`docs/evals/question-cases/<run>.json`), counts only on screen and in the log. Run it from the main checkout (it
refuses without a search index).

**First paid run, 10 Nov** (his word): B5, C21, C6, all three passed. Per case: one Codex call of about 32,000 to
56,000 input tokens (most cached) and 100 to 170 output, 15 to 20 seconds, one or two connector reads; one judge call
on his engine of about 600 input and 200 to 1,700 output tokens, a fraction of a cent. Results in his data,
`docs/evals/question-cases/2026-11-10T08-46-05.632Z.json`. These three are facts Life already holds; the baseline
must include the hard ones (relationships, arcs).

**Baseline, 10 Nov** (today's Life, 12 cases): 8 passed. Failed: C1 (his father: hostile and blaming found;
"father reaches out first" missed; "he yields to keep the peace" contradicted: the answer read him as distant, not
yielding), C4 (his close friend's topics: one read of the person page, which holds the recent agency work, not the years of
philosophy), A11 (no end state for old bugs: "not confirmed"), D1 (graded on old wrong points; reworded since).
Passed but heavy: C2 read 1.3 million characters in about 60 calls (no layer holds blames over a year: the agent
read raw chats one by one). These match the spec's diagnosis: no counts (who reaches out), no long story (C4),
no endings (A11), performance not told apart from view (C1).

**Pilot round 1, 10 Nov** (his yes; the connection read, both people, all years): 85 of 85 calls ok, 8,091 moves
kept, 1.6% dropped by the quote check, about $1.55 (output, thinking included, was about 36,000 tokens a call:
three times the estimate). Counts by side in his data repo, `docs/memory-rework/experiments/2026-11-10-pilot-round-1.md`.
Then (his idea) two lighter people, read by DeepSeek and by Codex as the check: 379 exchanges,
tension flag agreement 93%; thanks, invites, asking about the other, affection hold across families (kappa 0.7 to
1.0); disclosure (0.25 to 0.49), sharing, asking for and giving by the other side, refusing and exploring do not.
Next for the pilot: round 2 rewords those codes with examples, checked the same way; then recordings and group
chats, so people mostly heard in person are read in full.

**Was next**: the first paid run of three cases, on his word (his Codex plan for the agent, his engine for the judge),
to price a case; then the baseline over all twelve; then the conflict and mentions reads, one PR each; then the
pilot's first round on his word, with its cost shown and the place where kept replies are committed settled.

**Was next** (ticket 29): the benchmark's first piece. His cases, in his data repo, asked from an agent's side with
only the connector, an answer checked for what it must hold; today's Life as the baseline. Then the other two
reads, one PR each. Before any paid round: its cost shown to him; and where kept replies are committed (the nightly
commits `memory` and `truth` only). Still to size: recordings and group chats.

So the first PR was smaller and more useful than drafted: the exchange cut in one place, and a read-only script that
prints the numbers both reviews asked for (how many exchanges, how long, where the quiet falls, how many are
one-sided, how they batch). The map branch is merged with `main`, so the spec now sits on today's code.

### Stage 0. By code, no model, no reader moved (can start before the pilot)

| Step | What ships | Proven by | Value at once |
|---|---|---|---|
| 0.1 | The exchange: a function cutting a chat's messages into sittings. Nothing stored | Tests on made-up chats | None alone; everything after uses it |
| 0.2 | Sources carry reactions, reply links and deletions (one source per PR). Kept out of the unit's hash | Tests per source | Models reading a day see a heart as an answer |
| 0.3 | **Done 11 Nov (PR 439), sized down, with 5.2's first reader:** the exchange counts (`memory/exchange-counts.ts`: who opened, messages and deletions each way, minutes to each answer, per exchange), counted from the sources each night into Life's state (derived: 96 s to read every year, 3 MB, 12,830 exchanges of 192 people), shown by year in the person read; the persona folds the same rows. Left for their readers: last word, unanswered, per channel. Originally: Measures per exchange (who started, delays, shares, last word, unanswered); per day, sleep, workouts and who was pictured with him once those sources are on (spec 4) | Same numbers as today's pair counts on the same chats | Deletes the persona's own counting code |
| 0.4 | **Merged 12 Nov (PR 450):** coverage worked out when read (`memory/coverage.ts`: captured, not seen, unknown, for the sources that capture on their own), from the units held and what each publication read (`memory/publications.jsonl`, his yes); `read_day` shows it. Left: lifelog's `GET /recorded` so a dead pendant day is "not seen" (PR 2), the person read's block (PR 3), dropping `skipped` from `gather`, the passages table's name (his OK). Originally: Coverage per source and day, from today's source health; a source that records only when he acts (photos, workouts) covers nothing (spec 4) | A known outage shows as "not seen" | `read_day` and the pages stop calling a dead week quiet |
| 0.5 | The hour rule: hours per project and person per week | One checked week | A first true line of "time against goals" on his page |

### Stage 1. Links (the practical failures first)

| Step | What ships | Proven by | Value / deletes |
|---|---|---|---|
| 1.1 | The link record and a nightly step, shadow: endings for open promises and waits, read from today's facts; every open thing offered again at least once a month, whatever its age; retrieval measured apart from judgement (spec 6) | His marked failures on stale open items, as regression cases | None yet |
| 1.2 | Open items read endings | The same cases pass; a sample he would check | Stale items stop showing as open |
| 1.3 | Problems and their fixes; a repeat of the same complaint | Cases | The 14-day retire window can go |

### Stage 2. Histories from the evidence Life already has

Episodes and facts exist today. Months, years and a story can be built from them before any new read exists; they
get richer, with no change of shape, as stage 4 adds evidence. Proved first (11 Nov): a history read month by month
from raw one-to-one messages helped only once inside the person read, never as notes beside it. Old years have no
episodes: their matters and his month are read from the evidence itself (spec 11). A targeted raw re-read is allowed
where an answer failed (spec 1).

| Step | What ships | Proven by | Value / deletes |
|---|---|---|---|
| 2.1 | **Merged 11 Nov (PR 446), in shadow, off until his `history` setting:** `memory/histories.ts`, a person's closed months summarised once from their one-to-one exchanges (quotes checked, kept apart), then the story of the years; pending work derived from stored hashes, 200 calls a night. Dry count on his data: 42 calls from 2026-09, 205 from 2025-11, 1,103 for every year (27 people). On for every year since 11 Nov night (his answer: "every year"; `history.from` 2007-01), 200 calls a night. The reader is merged (PR 449, 12 Nov): the story and the newest 12 months on the person read's first page, earlier months paged with its timeline. Next: the question cases with it, once his months are read and the data session's units run is done. Originally: A month's summary for a subject, built when asked, shadow; an old month reads its photo-days too (spec 11) | Against the raw read whole for one person and one month | None yet |
| 2.2 | The situation reads summary plus what came since, in place of the page plus 30 days | Today's situations side by side | The 30-day window goes |
| 2.3 | Situations for parts of his life | A project he knows well | New: where each area stands |
| 2.4 | Year and story; the persona's gist written with the story | His arc questions | Arcs have an answer for the first time |
| 2.5 | Matters: parts of his life Life names itself, like unknown people today | A dispute and a trip from his data | Things that run for months get a home |

### Stage 3. The pilot (no change to the running Life)

Scripts on a copy of his data, as the benches run today. Every run logs tokens and time per step (spec 16). Four pieces (spec section 16). It freezes the wording of
the focused reads, sets the numbers, and prices the backfill. Stages 0 to 2 feed it and do not wait for it.

### Stage 4. The focused reads, one family per PR, each in shadow

| Step | What ships | Proven by |
|---|---|---|
| 4.0 | The day's read flags which families an exchange holds (a prompt version change: his yes first) | What the one-in-twenty full read finds |
| 4.1 | Mentions and self-reports | The pilot's marks for that family |
| 4.2 | Conflict and steering | Same |
| 4.3 | Connection | Same |
| 4.4 | Giving and asking | Same |

Fewer PRs if the pilot merges families. Each is switched on for new days only; its history follows by backfill.

### Stage 5. Counted readings, one reader at a time

| Step | What ships | Value / deletes |
|---|---|---|
| 5.1 | The counting code: which record counts (one rule, by code, before any count: spec 8), a rate per chance over exchanges the read saw, a vantage, a minimum fixed before a run (under 15 positive cases is "not proven"); how often conflict happens counted apart from what happens inside one. Tests on made-up data | None alone |
| 5.2 | The person read gains its counts beside today's prose persona, same name and arguments; time together by month (recorded, pictured) shown apart from contact (spec 10) | First meters an agent can use as data |
| 5.3 | Patterns and the track record | "Will they do what they said" |
| 5.4 | Closeness by depth, shadow beside today's, compared with what he said of each person; then it replaces it | Deletes the volume judge |
| 5.5 | The persona's traits and patterns come from the counts, a rate shown as an observation, a trait name as an interpretation (spec 10); how each writes stays | Deletes the weekly re-read of three years of raw |
| 5.6 | Pages drawn by code from history and readings, one section per PR (Now, History, Between us, his own page) | When the last section moved: deletes the page-writing prompt and its no-churn rules |

### Stage 6. His word and Life's list

| Step | What ships |
|---|---|
| 6.1 | His correction is an input to the read of that exchange, and code keeps the record hidden in every later reading where one of the same form on the same messages matches it, until his word lifts it; it never hides another record of the same message (spec 8). One kind of his word per PR |
| 6.2 | Questions for him: one new rule per PR on top of today's fact checks, same connector tools |
| 6.3 | Life's list learns projects, goals and roles beside `truth/`, which stays its seed |
| 6.4 | The rules of `AGENTS.md` rewritten (his yes), and the interview that seeds a new Life |

### Stage 7. Forecasts, by code

| Step | What ships |
|---|---|
| 7.1 | The forecast record, the code that settles one, the scoring, all in shadow; each "based on past behaviour", a case where he acted set aside, one in ten never shown (spec 12). The backtest is the same code run on the past |
| 7.2 | One sort at a time shown in the person read, once it beat its baseline |

### Stage 8. The connector's one batch

The overview, a span, the evidence, and the "which part" argument: one PR, one reconnect, when everything they
return already exists and has been read through the old tools. Also in that batch: `read_processing_runs`'s description
(`mcp.ts`) still names the midday sweep, removed 11 Nov (left so his ChatGPT needs no reconnect for it).

### Stage 9. The boundary

The memory's imports of sources, payments and the to-do list moved behind its "in" side, a few files per PR, the
check tightened at each. Mechanical, last, and never mixed with a change of behaviour.

## What depends on what

- Stage 0 needs nothing. Stages 1 and 2 need only stage 0 and today's evidence.
- Stage 4 needs the pilot. Stage 5 needs stage 4 for moves, and stage 1 for the track record.
- Stages 6 and 7 can start any time after stage 1. Stage 8 comes after 2, 5 and 7. Stage 9 any time, best last.
- The backfill of a family runs beside everything from stage 4 on.

## The size of it

About forty small PRs. Most add a file and a test; the ones that move a reader are the ones that later delete a
mechanism: the persona's counting, the 14-day window, the 30-day window, the volume judge, the weekly re-read, the
page-writing prompt.

## What can go wrong, and the guard

| Risk | Guard |
|---|---|
| A shadow step slows or fails the night | It runs after the steps he depends on, with its own time limit; a failure is logged, never fatal |
| Two layers disagree while both live | Only one is read by any given reader; the other is shadow |
| A step sits in shadow for ever | A shadow step has a date: it moves a reader or is deleted |
| A reader moved too early | The old writer still runs until the PR after; moving back is one line |
| A prompt change re-reads the archive | Rule 9; a version change is asked first |
| The pilot says a layer fails | Its stage is dropped; the stages before it stand alone |

## If it is built in days, not weeks

His word (10 Nov): he means to reach the whole spec within one or two days; his quota is back whenever he wants.
The rules above do not change: they are what makes a fast build safe. What changes is the pace and the order.

**Lanes instead of a line.** Steps that touch different files run side by side, each in its own worktree and PR:

| Lane | Steps | Files it owns |
|---|---|---|
| Sources | 0.2 | One reader per source |
| Exchange and measures | 0.1, 0.3, 5.1 | New files; the persona's counting |
| Coverage and hours | 0.4, 0.5 | New files; source health |
| Links | 1.1 to 1.3 | A new file; open items |
| Histories | 2.1 to 2.5 | A new file; situations |
| The pilot | Stage 3 | `scripts/` only |
| His word and questions | 6.1, 6.2 | Statements, corrections |
| Forecasts | 7.1 | New files |

- **One PR first, alone**: new night steps register themselves in a small list instead of each editing the night's
  one file. Without it every lane collides on the same lines.
- Two writers never share a file. The focused reads (stage 4), the readings that rest on them (5.2 to 5.6), the
  connector's batch and the boundary stay in a line, after the pilot.

**Replay instead of waiting for nights.** A new layer is run over the last two months on a copy of his data and
compared there, the same day. "Shadow" then only means: merged, switched off for readers, until its comparison is in.

**What speed cannot buy**

| Thing | Why |
|---|---|
| The names, before the first record is stored | A stored name that changes later costs a migration. His yes comes first |
| The pilot, before the focused reads' wording is frozen | Everything is read once with that wording |
| The history read | It waits for the pilot's frozen wording, then runs by itself. By the second review's count of his data it is days of reading, not months (spec section 16, "The history, read once") |
| A verdict per PR | The merge gate stays |
| The other session's data work | It owns units, sources and the import; the sources lane waits for it or is agreed with it |

**The honest risk.** His own words: he is wary of sprees that burn tokens and get rebuilt. A two-day build of
everything is one unless each lane stops at its comparison. So: a lane merges switched off, and a reader moves only
on its number. What two days can truly deliver is all the code, the pilot's result and the first readers moved;
the history and the proof on real nights follow by themselves.

## Where the imports and the history fit

The other session's imports (WhatsApp since 2011, his Claude and ChatGPT conversations) arriving as units is the
right thing at the right time: stage 0 and the pilot both stand on them.

| When | What reads the old years |
|---|---|
| Now | Nothing with a model. The imports land as units |
| Stage 0 | Code only: who started, delays, shares, deletions, over every year, free |
| The pilot | Two or three people in full, across all their years: needs the imports |
| After the pilot | The frozen reads, newest year first; then links; then histories |

One thing to settle with that session: it should not run today's model layers (the day's read, the claims read,
personas) over the old years in the meantime. Those would be read again once the wording is frozen.
