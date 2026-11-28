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

Moved from the root `AGENTS.md`, "Invariants". The one-line versions stay there; these are the details.

- **Memory is append-only and expensive.** Never hand-edit or wipe `memory/` (except appending his corrections or
  labels). `ledger.jsonl` is appended only by `changeTodoItem`, `setAutoAdd`, `ask` and the sync
  pass (`inbound`); `instructions.jsonl` (his instructions) only by `recordInstruction` (`memory/instructions.ts`), a line never rewritten (a correction `replaces` one), read only by `instructionsFor` and `inForceOf`; `complaints.jsonl` (the complaint record) only by `recordComplaints`, run by the desk for the complaints it is receiving, which may drop only a torn last line (a whole line that is not a row stops it, kept); `publications.jsonl` (what each publication of units read) only by `publishUnits`; `matter-icons.jsonl` only by the matter icons step (`pickMatterIcons`, the night's and the watcher's; one line per matter text and prompt, the newest winning, his `matter-icon` correction wins); `matter-directions.jsonl` only by the matter directions step (`memory/matter-directions.ts`; pinned to its matter's steps, his `matter-direction` correction wins); `links.jsonl` only by the links step (`memory/links.ts`), read by the readers through `endingsRead` (`memory/endings.ts`: a link ends its step "probably" until his word); `matters.jsonl` only by the matters step (`memory/matters.ts`; only the current matters prompt's lines are read, so a prompt bump re-groups everything and changes every matter id: ask first), a line holding steps never a status (open, matter status and people by role are worked out when read, `matterOf`); `read-replies/` only by the exchange reads, the conversation summaries, the voice namings, the day records (`memory/day-records.ts`, one line per day whose evidence changed, the newest of the current prompt winning) and, by day, the arrival reader and the voice naming on arrival (`memory/read-replies.ts`'s `storeReply`, through `makeReplies`; the voice naming's daytime lines are his yes of 21 Nov 2026; the arrival reader's daytime lines are his yes of 20 Nov 2026), a line never rewritten; `decisions.jsonl` only by `requestDecision`, `answerDecision` (its sends' lines by `sendOnAnswer`, `memory/decision-send.ts`), `withdrawDraftsAnsweredInChat`, `withdrawDeletedCards`, `recordDoneSeen`, the gate's `recordDelivered`, his Undo's `withdrawAnswer` and his mark's `rateDecision` (`memory/decision-after-answer.ts`; the others `memory/decisions.ts`; a draft's send outcome, an `adds` option's `added` line (its calendar write's), a `runs` option's `ran` line (its Apify run's start), an `ends` option's `ended` line, Life's `done-seen` outcome of a look for the step done: his `looks` answer's, or the watcher's `seen`; a holder's `kept` line and a merge's withdrawal by `requestDecision`; the older card's `replacedBy` withdrawal by `answerDecision`; the cards a deletion reaches withdrawn by `withdrawDeletedCards`, the door's), a line never rewritten (earlier versions' lines stay in it, skipped: the old decisions page's schemaVersion 1, the cards before titles' 2). The status reads' `read_memory_changes` cursor counts ledger lines, so a line must never move. Code
  rewrites only `units/`, `episodes/<day>.jsonl`, `situations/`, `project-situations/`, `matter-situations/`, `personas/`, `communication-styles/` (a file is never removed), `histories/` (a month or a story replaced only by its re-read, its last version left to the data repo's git history; a file is never removed) and `appointments.json` (rebuilt whole) and a rename's or a new field's backfill (next).

- **What he deletes is one correction, applied at read.** A deletion is one `deleted` line in `corrections.jsonl` (never a
  rewrite of `memory/`): every read of the words goes through `deletedWordsOf` (turns keyed by recording and index) and every
  read of a source's messages through `deletedReadOf` (the one read `tablesOf` builds its tables from), so a deleted line has
  none and a cut's places blank when the digest is the words at them; what was read from them is gone, never replaced
  (`isDeleted`; `oldHashes` never holds a chapter unit's, which is never read again). `deletionsNow` reads his corrections once
  per process; a send path reads the source raw, as he approved it (`draft-send.ts`).
  Its one door is `deleteFromMemory` (his token, the main session on his words, `bun life memory delete`), which previews the
  exact set and writes only on its digest, then reads its days again. It also names the copies holding the words outside
  `memory/`: his instructions quoting them (their ids, hidden at read by `instructionsFor`) and the Life thread's entries
  (`thread:<id>`, listed in the preview but outside its digest, hidden at read by `readThread` and blanked in place by the
  desk on its tick, `desk/thread-deletions.ts`; an answer never writes back onto one). The words themselves stay where their sources hold them
  (lifelog, the archive, the backups, the git history): purging them needs code that does not exist (SECURITY.md).

- **lifelog's chapter units stay as stored.** The voice history before conversation-days: lifelog still holds most of
  their turns (the persona reads their words), but thousands of facts, his fact-check answers and corrections cite them, and a re-read
  would orphan those (his decision of 9 Nov 2026). Never wipe or rebuild them; one goes only with its conversation (`frozenUnits`, `units.ts`).

- **A rename or a new field backfills.** Names follow the best model, never old data. Renaming something stored (a field, an enum
  value, an id, a file, a unit id's recipe), or adding a field to stored lines, ships one migration in Life's code (today's steps are listed at the top of `host/migrate.ts`, called from `cli.ts`; each goes once it has run on his data), with the owner's OK on the list: the app runs it at its
  next start, under the lock (a checkout only on a copy), before anything that appends starts (the lock-free appenders
  never wait on it); it rewrites the stored lines (same count, same order, so the `read_memory_changes` cursor holds),
  each file whole through `writeWhole` (a new file, which every process's kept read reads whole again; never in place),
  and commits in the data repo. Never run one by hand or from a worktree: the
  running Life reads the same data. After it the code reads only the new name, with no alias. `truth/` (only he
  writes it) and the archive are never migrated. A renamed value the models return changes a prompt's words, not its
  meaning: the prompt keeps its version and its cached outputs are backfilled.
  A new recipe for new units only, every stored id kept, is not a rename. A day's episode file is code's to rewrite on
  every reading, so a migration may drop episode lines there (no cursor counts them).
  An optional field that the old lines truly lack, on an append-only file whose latest line per key rules, needs no migration:
  the writer's next line fills it. Nor does one on a line never rewritten, where lacking it is true (a card asked
  before Life could send has no resolved chat, and sends nothing).
  The desk's store (`desk.sqlite`, not `memory/`) changes shape only by a step the desk helper runs at its start, before
  anything opens it, behind a dated copy beside it and in one transaction, skipped on the app's state from a checkout
  (`isAppState`); `openDesk` never migrates and refuses a store of the old shape. A new table rewrites no row and needs no step: `SCHEMA` makes it when the store opens (`card` and `handed_step`, Agents PR 2, #749; `thread_entry` and `handed_work`, v4). Today's steps are `desk/store-step.ts`'s (its header lists them), run in order by `desk/desk-helper.ts` at its start, each with its own check and its own dated copy, each deleted once it has run on his store.

- **One lock.** Everything that writes `memory/` holds it (`locked`, `memory-lock.ts`), except his single lines (a
  correction, and his answer to a check with the check as it was shown (its text and source; the later step's words are not stored), written just before it: `recordFactCheckAnswer`), `told-life.jsonl` (what he told Life, one synchronous append: `recordToldLife`), `instructions.jsonl` (his instructions, one synchronous append: `recordInstruction`, his yes of 25 Nov 2026), `decisions.jsonl`'s lines (one synchronous append), `files.jsonl`'s lines (one synchronous append; one line per ref and prompt version), the arrival reader's and the voice naming on arrival's `read-replies/` lines (one synchronous append each), `appointment-events.jsonl` (the calendar sync's lines, each tick, and his Remove and Undo from the connector or the main session, all in one chain across processes: `inTurn`, `oneAtATimeAcross`), `complaints.jsonl` (one synchronous append per complaint: `recordComplaints`), the watcher's `matter-icons.jsonl` lines (one synchronous append per call, skipped while the lock is held) and `ledger.jsonl`'s writers above. One Life per Mac: the archive, the watcher and the desk each hold a
  lock in `MACHINE_DIR` (`docs/operations.md`); the desk never takes the memory lock.

- **What the memory holds, in words, is `memoryLinesNow`** (`doubts.ts`): the fact checks he answers and the eval judge the
  same text. Which memory lines are doubtful (resting on a guessed person) is decided only by `guessedOf`, from what is stored, never stored itself; what
  he is asked about, only by `checksNow` (`checks.ts`), never drawn or stored: a doubtful line is asked through the guess
  behind it, one check for one guess, with no limit (his decision of 14 Nov 2026); a name Life cannot place is asked only while the person matters, he exchanged with them or it was seen on 3 days or more, never a description or a name he said not to name (`nameGroupsOf`, his word of 20 Nov 2026 reversing "no threshold" for names, life#724); a guess Life is sure of (`INFERRED_SURE_AT`) or that is an organization (`isSettledGuess`) is taken as true and never asked (his decisions of 20 Nov 2026; prompt `memory-episodes.v9`); what blocks him, only by `urgencyOf` (`check-urgency.ts`): his inbox holds every open ask but an ending check (on its matter's page only: `isInboxCheck`, the cognitive-load rule of 22 Nov 2026), in the order `inboxOrderOf` gives; the badge counts what blocks (a your move card only when due within 3 days); an agent's card pushes once, when the gate delivers it (`desk/gate.ts`; Life's own checks wait in the list and push nothing, his yes of 25 Nov 2026), time-sensitive only within 3 hours of its deadline, else raised or lowered by his `interrupt` or `quiet` instruction (`pushLevelOf`), never when the gate read it as a sensitive subject, with no words of his through Apple: his phone reads the card from the connector and writes the notification's text itself.
  His answer is the only thing written, with the check as shown (`fact-checks.jsonl`).

- **Facts are read by episode:** one call per day reads the day, its new units in full (`episodes.ts`), then extraction reads an
  episode's units not read yet together (`extract.ts`), the ones already read as earlier facts; a chat that grew is read
  for its new lines (`Extracted.lines`), with earlier facts as a reading to correct, never as evidence. Extraction is
  the only step that retires an observation, besides his word that one is outdated (a fact-check answer or an
  `outdated` correction).
- **Historical collection is model-free.** `memory historical-units` reads bounded owner-local months, skips voice and file descriptions, and publishes only units and derived passages. An import describes its own files (the Instagram export's photos, by `describeFiles`, which also hears its voice notes) before its collection, which leaves old files as tags; old voice notes are heard first by `memory hear-voice-notes` (no model, no lock). Imports and model backfills require `backfillEngine`; no fallback to the ordinary engine. No scheduled model backfill until prompts are frozen. One exception, his OK of 15 Nov 2026: the first run of the conversation summaries (`bun life memory conversation-summaries --from 2026-09-07 --force`, once, no cap, about $1.10 to $1.50) runs on the ordinary `engine`, as the night's step run wider.
- **Historical zones come from evidence of the day**, model-free, as `Etc/GMT±N` (reversed sign): the offsets of photos that place him, else sent-mail Date offsets (`historical-zones.ts`, `docs/operations.md`). Stored zones change only by appended lines, over the whole derived era, and a day a record cites, an episode day or a deferred day holding units keeps its zone. Days with no evidence use the nearest known day (ties earlier), reported as gaps for later model review, and so do days whose mail splits; a quarter-hour photo or a travel day (its mail names both differing neighbours' zones) defers its day. No city guesses or new Zone fields.
- **A passage has one owner:** its first message's unit, identified globally by source and first-message id. Complete grouping runs reconcile across day and month boundaries in a derived store outside the rebuildable index.
- **A summary is redone only when new evidence for its subject arrived.** Its `inputs` digest covers its subject's evidence only, in a window ending at the subject's newest evidence (the story: capped at the last closed year); today's date, the page text and other summaries may be shown to the call but never enter the digest (personas, story; pages already hold). A history month's digest also holds the text of its conversations in person, its only view of what was said there; a conversation summary changes only with its turns or its prompt version. A situation is the exception: its digest also holds the page's digest and, while the personas add-on is on, the persona's text, so a new page or persona refreshes it. The personas' weekly throttle is a rate cap beside the rule, not part of it.
- **A night reads only what is new** (his rule of 16 Nov 2026): each night step reads its window, what arrived since its own cursor or digest, and summaries of closed periods; never every year of a source, every stored line or every turn. Only an explicit backfill reads the whole history. A digest holds refs, never names, so a rename re-reads nothing.
- **`callCharsOf` bounds one call; it is not a budget to fill.** A summary that would grow with the years is never fed the whole history up to it: it is built from closed periods' summaries (the story from its closed years, as above) or from its last version plus what is new.
- **Readers are bounded too:** a connector call, the status snapshot, the watcher's tick and the desk's poll (only the channels a wait names, over a fixed look-back) read the index, a cursor or a window, never a whole folder of `memory/` or every lifelog turn. The watcher's withdrawal step reads only the channels an open draft card names, from their earliest such card's asking (14 days at most: a card's deadline).
- **Model output is cached** by unit hash and prompt version (`docs/architecture.md`). Bump a prompt's version only
  when its meaning changes; ask before re-running the whole archive. A prompt part switched by an add-on is not a new
  version: its variant (`<prompt>-without-<parts>`) shares the base's cache (`isPromptVersion`, `models/prompt-parts.ts`).
