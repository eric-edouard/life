# The path: reaching the spec in small steps

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

**Next**: the first paid run of three cases, on his word (his Codex plan for the agent, his engine for the judge),
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
| 0.3 | Measures per exchange (who started, delays, shares, last word, unanswered) | Same numbers as today's pair counts on the same chats | Deletes the persona's own counting code |
| 0.4 | Coverage per source and day, from today's source health | A known outage shows as "not seen" | `read_day` and the pages stop calling a dead week quiet |
| 0.5 | The hour rule: hours per project and person per week | One checked week | A first true line of "time against goals" on his page |

### Stage 1. Links (the practical failures first)

| Step | What ships | Proven by | Value / deletes |
|---|---|---|---|
| 1.1 | The link record and a nightly step, shadow: endings for open promises and waits, read from today's facts | His marked failures on stale open items, as regression cases | None yet |
| 1.2 | Open items read endings | The same cases pass; a sample he would check | Stale items stop showing as open |
| 1.3 | Problems and their fixes; a repeat of the same complaint | Cases | The 14-day retire window can go |

### Stage 2. Histories from the evidence Life already has

Episodes and facts exist today. Months, years and a story can be built from them before any new read exists; they
get richer, with no change of shape, as stage 4 adds evidence.

| Step | What ships | Proven by | Value / deletes |
|---|---|---|---|
| 2.1 | A month's summary for a subject, built when asked, shadow | Against the raw read whole for one person and one month | None yet |
| 2.2 | The situation reads summary plus what came since, in place of the page plus 30 days | Today's situations side by side | The 30-day window goes |
| 2.3 | Situations for parts of his life | A project he knows well | New: where each area stands |
| 2.4 | Year and story; the persona's gist written with the story | His arc questions | Arcs have an answer for the first time |
| 2.5 | Matters: parts of his life Life names itself, like unknown people today | A dispute and a trip from his data | Things that run for months get a home |

### Stage 3. The pilot (no change to the running Life)

Scripts on a copy of his data, as the benches run today. Four pieces (spec section 16). It freezes the wording of
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
| 5.1 | The counting code: a rate per chance, a vantage, a minimum. Tests on made-up data | None alone |
| 5.2 | The person read gains its counts beside today's prose persona, same name and arguments | First meters an agent can use as data |
| 5.3 | Patterns and the track record | "Will they do what they said" |
| 5.4 | Closeness by depth, shadow beside today's, compared with what he said of each person; then it replaces it | Deletes the volume judge |
| 5.5 | The persona's traits and patterns come from the counts; how each writes stays | Deletes the weekly re-read of three years of raw |
| 5.6 | Pages drawn by code from history and readings, one section per PR (Now, History, Between us, his own page) | When the last section moved: deletes the page-writing prompt and its no-churn rules |

### Stage 6. His word and Life's list

| Step | What ships |
|---|---|
| 6.1 | His correction is an input to the read of that exchange, one kind of his word per PR |
| 6.2 | Questions for him: one new rule per PR on top of today's fact checks, same connector tools |
| 6.3 | Life's list learns projects, goals and roles beside `truth/`, which stays its seed |
| 6.4 | The rules of `AGENTS.md` rewritten (his yes), and the interview that seeds a new Life |

### Stage 7. Forecasts, by code

| Step | What ships |
|---|---|
| 7.1 | The forecast record, the code that settles one, the scoring, all in shadow. The backtest is the same code run on the past |
| 7.2 | One sort at a time shown in the person read, once it beat its baseline |

### Stage 8. The connector's one batch

The overview, a span, the evidence, and the "which part" argument: one PR, one reconnect, when everything they
return already exists and has been read through the old tools.

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
