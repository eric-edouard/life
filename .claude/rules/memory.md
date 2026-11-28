---
paths:
  - "apps/server/src/memory/**"
  - "apps/server/src/personal/**"
  - "apps/server/src/records/**"
  - "apps/server/src/host/**"
  - "apps/server/src/desk/store-step*.ts"
  - "prompts/**"
---

# Memory: writers, deletions, migrations, reads

## Memory is append-only and expensive

Never hand-edit or wipe `memory/`, except appending his corrections or labels. Its writers, and a line is never rewritten:

- `ledger.jsonl`: `changeTodoItem`, `setAutoAdd`, `ask`, the sync pass (`inbound`). The `read_memory_changes` cursor
  counts its lines: a line never moves.
- `instructions.jsonl`: `recordInstruction` (`memory/instructions.ts`; a correction `replaces` a line), read only by
  `instructionsFor` and `inForceOf`.
- `complaints.jsonl`: `recordComplaints`, run by the desk; it may drop only a torn last line.
- `publications.jsonl`: `publishUnits`.
- `matter-icons.jsonl`: `pickMatterIcons`; `matter-directions.jsonl`: `memory/matter-directions.ts`. His
  `matter-icon` or `matter-direction` correction wins. `step-readings.jsonl`: `stepReadings`.
- `links.jsonl`: `memory/links.ts`, read through `endingsRead` (`memory/endings.ts`): a link ends its step "probably"
  until his word.
- `matters.jsonl`: `memory/matters.ts`. Only the current prompt's lines are read, so a prompt bump changes every matter
  id: ask first. A line holds steps, never a status (`matterOf` works it out at read).
- `read-replies/`: only through `storeReply` (`memory/read-replies.ts`), by the night's reads and, by day, the
  arrival reader and voice naming on arrival (his yes of 20 and 21 Nov 2026).
- `decisions.jsonl`: `requestDecision`, `answerDecision` (sends: `sendOnAnswer`, `memory/decision-send.ts`),
  `withdrawDraftsAnsweredInChat`, `withdrawDeletedCards`, `recordDoneSeen`, the gate's `recordDelivered`,
  `withdrawAnswer` and `rateDecision` (`memory/decision-after-answer.ts`; the rest `memory/decisions.ts`). Older schema
  versions' lines stay, skipped.

Code rewrites only `units/`, `episodes/<day>.jsonl`, `situations/`, `project-situations/`, `matter-situations/`,
`personas/`, `communication-styles/`, `histories/` (a month or story only by its re-read; no file in these two is
removed), `appointments.json` (whole), and a migration's backfill.

## What he deletes is one correction, applied at read

- A deletion is one `deleted` line in `corrections.jsonl`, never a rewrite of `memory/`.
- Every read of words goes through `deletedWordsOf`, of a source's messages through `deletedReadOf`. What was read
  from deleted words is gone, never replaced (`isDeleted`).
- A send path reads the source raw, as he approved it (`draft-send.ts`).
- Its one door is `deleteFromMemory` (his token, the main session on his words, `bun life memory delete`): a preview,
  then the write only on its digest.
- Copies outside `memory/` are hidden at read: his instructions (`instructionsFor`) and the Life thread's entries
  (listed in the delete preview but outside its digest; `readThread`, blanked by `desk/thread-deletions.ts`; an answer never writes back onto one).
- The words stay in their sources, backups and git history; no code purges them (`SECURITY.md`).

## The voice server's chapter units stay as stored

Facts, his fact-check answers and corrections cite them (his decision of 9 Nov 2026). Never wipe or rebuild them; one
goes only with its conversation (`frozenUnits`, `units.ts`).

## A rename or a new field backfills

- Renaming anything stored (field, enum value, id, file, a unit id's recipe) or adding a field ships one migration in
  `host/migrate.ts` (each step removed once run on his data), with his OK on the list. The app runs it at its next
  start, under the lock, before anything appends (the lock-free appenders never wait on it); never by hand or from a worktree (a checkout only on a copy).
- It keeps each file's line count and order, writes it whole (`writeWhole`, never in place), commits in the data repo; then the code
  reads only the new name, no alias. `truth/` and the archive are never migrated.
- A renamed value the models return keeps its prompt's version; cached outputs are backfilled.
- Not a rename: a new recipe for new units only. A migration may drop lines of a day's episode file.
- No migration: an optional field old lines truly lack, on a latest-line-wins file or where lacking it is true.
- The desk's store (`desk.sqlite`) changes shape only by a step in `desk/store-step.ts`, run by `desk/desk-helper.ts` at
  its start, behind a dated copy, in one transaction, never on the app's state from a checkout (`isAppState`); each is
  deleted once run. `openDesk` never migrates. A new table needs no step: `SCHEMA` makes it.

## One lock

Everything that writes `memory/` holds `locked` (`memory-lock.ts`), except single-line synchronous appends: his
corrections and fact-check answers (`recordFactCheckAnswer`), `told-life.jsonl`, `instructions.jsonl` (25 Nov 2026),
`complaints.jsonl`, `decisions.jsonl`, `files.jsonl`, the by-day `read-replies/` lines, `ledger.jsonl`'s writers, the
watcher's `matter-icons.jsonl` lines (skipped while the lock is held) and `appointment-events.jsonl` (one chain across
processes: `inTurn`, `oneAtATimeAcross`). One Life per Mac: the archive, the watcher and the desk each hold a lock in
`MACHINE_DIR` (`docs/operations.md`); the desk never takes the memory lock.

## Checks and what blocks him

- What the memory holds, in words, is `memoryLinesNow` (`doubts.ts`); a line is doubtful only by `guessedOf`, never
  stored. What he is asked comes only from `checksNow` (`checks.ts`), never stored: one check per guess, no limit
  (14 Nov 2026).
- An unplaced name is asked only while the person matters, never a description or a name he said not to name
  (`nameGroupsOf`, life#724). A sure guess (`INFERRED_SURE_AT`) or an organization (`isSettledGuess`) is never asked.
- What blocks him comes only from `urgencyOf` (`check-urgency.ts`). His inbox holds every open ask but an ending check
  (`isInboxCheck`; 22 Nov 2026) and a your move card `askOfStep` hides, in `inboxOrderOf`'s order; the badge counts what
  blocks (a your move card only when `askOfStep` says so). `askOfStep` is the one rule for his steps: the model's step
  readings, code's dates and floor (28 Nov 2026).
- An agent's card pushes once, when the gate delivers it (`desk/gate.ts`); Life's own checks push nothing
  (25 Nov 2026). Time-sensitive only within 3 hours of its deadline, else per his `interrupt` or `quiet` instruction
  (`pushLevelOf`), never for a sensitive subject. None of his words go through Apple.
- His answer is the only thing written, with the check as shown (`fact-checks.jsonl`).

## Reading

- Facts are read by episode (`episodes.ts`, then `extract.ts` over its unread units); a grown chat for its new lines
  (`Extracted.lines`), earlier facts a reading to correct, never evidence.
- Only extraction retires an observation, besides his word (a fact-check answer or an `outdated` correction).
- Historical collection and zones are model-free (`docs/operations.md`); stored zones change only by appended lines.
  Imports and model backfills require `backfillEngine`, no fallback, none scheduled until prompts are frozen (his OK
  of 15 Nov 2026: one conversation-summaries run on `engine`).
- A passage has one owner: its first message's unit (`docs/architecture.md`).
- A summary is redone only on new evidence for its subject: its `inputs` digest holds only that evidence, up to its
  newest (the story: to the last closed year), never today's date, page text or other summaries. Also in it: a history
  month's in-person conversations; a situation's page digest and persona.
- A night reads only what is new (16 Nov 2026): its window since its cursor or digest, and closed periods' summaries.
  Only an explicit backfill reads the whole history. A digest holds refs, never names.
- `callCharsOf` bounds one call; it is not a budget. A summary growing with the years is built from closed periods'
  summaries or its last version plus what is new.
- Readers (a connector call, the status snapshot, the watcher's tick, the desk's poll, the withdrawal step) read an
  index, a cursor or a window, never a whole `memory/` folder or every recorded turn.
- Model output is cached by unit hash and prompt version (`docs/architecture.md`). Bump a version only when its meaning
  changes; ask before re-running the archive. An add-on's prompt variant shares the base's cache (`isPromptVersion`,
  `models/prompt-parts.ts`).
