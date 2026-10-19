# Life

A memory of the owner's life, built nightly from his voice (lifelog), chats, iMessage, mail and Apple Notes:
sources → units → verdicts → observations → people and area pages. Plus an always-on archive that keeps chat messages
deleted for everyone and every version of his Apple Notes. Where things stand and why: `docs/handoff.md`. Data formats: `docs/SCHEMA.md`.

## Where his data lives

`memory/` and `truth/` (every such path here) are in `DATA` (`src/truth.ts`): `~/Life`, a local git repo of their own
with no remote, or `$LIFE_DATA`. The nightly commits there and pushes nothing (`commitMemory` refuses a repo with a
remote): nothing of his goes to GitHub. Every worktree reads and writes that same `~/Life` and shares its one lock
(`~/Life/.nightly.lock`); point `LIFE_DATA` at a copy to experiment. `bun test` reads made-up data (`src/test-data`,
`NODE_ENV=test`). Rules for editing `truth/` are in `~/Life/AGENTS.md`.

## It runs itself

The owner never runs `bun life …` and never reviews a queue. The commands are for you and for launchd. Don't design a
step that waits on him: an uncertain inference goes into a model-owned layer (like `memory/people-inferred.jsonl`)
that is used at once and corrected later.

His input arrives in conversation only. The one exception he asked for (19 Oct): the truth benchmark
(`memory/statements.jsonl`), statements he will rate true or false on his phone when he likes, never a queue Life waits on. When he states a fact or corrects one, record it before moving on:
`bun life memory correct '<json>'` (kinds in `docs/SCHEMA.md`: wrong, not-important, keep-mine, this-is,
not-this-person, same-person), or, when it's about who someone is, offer to add it to `truth/` and do it on his yes.
When he says which project a repo belongs to, or a project is added, put the repo in that project's `repos:` (he agreed to this map; `repos` shows
Life's guesses and the new projects it suggests), then `bun life validate`.
When he states a goal or a priority, or changes one, offer to put it in `truth/me.md` `## Goals` (numbered, his
priority order, each with the project ids it serves) and do it on his yes: his goals live there only.
When he says something matters or doesn't, also append a label to `memory/labels.jsonl` (the verdicts measure themselves
against them). His word beats the memory. `bun life memory unresolved` shows what Life inferred before you ask him anything.

When he asks you to change a reminder, use `bun life act '<json>'` (kinds, fields and `said`: `Change` in
`src/actions.ts`), never `remctl` directly: it logs what changed, from what, and why. He talks to Instinct himself.
`act` refuses an add whose title an open reminder has (`duplicateOf`, every caller), and a timed `due` always alerts
at that time. Deep work on his life is Atlas's, his ChatGPT agent: hand it over with `bun life ask '<his words>'`.
Life no longer acts on what it hears: he says "hey Atlas, …" and Atlas gets the ask as a task (`docs/atlas.md`).

## Answering about his life

Everything is in the memory CLI (`bun life memory ...`); the connector's tools are these:

- `search <words> [--from d --to d]`: moments (what happened or is planned), observations, units, from lifelog the exact spoken words (each hit gives a conversation id and a turn) and the chat messages (90 days) and note versions (any age) holding all the words (newest 100, two around each; a long one as its lines holding a word).
- `fetch <id> [--from-turn n]`: a conversation's or a unit's lines, 200 at a time (who spoke and when from Life's store, the words fetched from lifelog and never stored; chat and mail units from the archive).
- `day <YYYY-MM-DD>` (what happened: the moments dated that day, then conversations, chat units, the day's key observations, and what Life changed that day and why), `person [name]` (the last moments with them too; `person me`: his own page, his goals first, then his views, health and what he's dealing with; no name: who has a page, latest seen first; a name two people go by lists both; an unknown name is looked for among lifelog's speakers), `area <name>`, `topics [tag]`.
- `places --at <instant|date> | --place <name> | --latitude n --longitude n [--radius m] [--from d --to d]`: where he was (lifelog's location stays, the whole history, 200 at most), each stay with the conversations recorded during it. You supply coordinates; Life does no geocoding.
- `repos [project|area|repo]` (CLI only, not a connector tool): his code repos by project, where each is and the last 30 days of commits; his map is `Project.repos` in `truth/`, Life's guesses are marked inferred. Read a project's first repo (its main entry point) before working in it. Which mailbox sends what: `~/Work/CLAUDE.md`. Commits are also units (`source git`, one per repo and day): `search`, `day` and `fetch` show them.
- `chats --who <name|handle> | --chat <id> [--from d --to d]`: WhatsApp and Beeper (Life's archive, messages deleted for everyone shown marked) and iMessage, today included, 7 days and 200 messages at most.

Use the CLI; read a source directly only if it is unavailable: `~/Library/Application Support/Life/archive/` (`whatsapp.sqlite`,
`beeper.sqlite`, `notes.sqlite`, each with a `deleted` view) and `~/Library/Messages/chat.db`, read-only. Beeper is for acting only, and a send needs his OK on the exact text.

## Invariants

- **What the memory holds, in words, is `claimsNow`** (`statements.ts`): the statements he rates and the eval judge
  the same text.
- **He is the center, not one more person.** His own page (`pages/people/me.md`, `OWNER` in `truth.ts`, its sections in `layoutOf`, `page.ts`) is a
  projection of the observations like every page, so its shape changes at the cost of rebuilding one page; his goals
  are only in `truth/me.md` (`truth.me.goals`), shown first on `person me`. Nothing about him is stored in
  a separate record, and observations carry no owner-only field.

- **Life's own code acts in one place only, on the owner's clear request in a Claude session or a chat:** Apple
  Reminders (add, edit, done, remove to Recently Deleted, through `~/bin/remctl`), through `act` (`src/actions.ts`, the
  only code that does it on his request; the tasks' board is a projection, below), which logs every action in `memory/actions.jsonl` (its `instinct` lines, emails to Instinct,
  and its heard requests with `timing`, both until 19 Oct, still parse). Nothing Life hears or reads makes it act. `act` refuses the list `Atlas` (`BOARD`): that list is
  the tasks' board below, written only by `src/board.ts`.
- **An ask for Atlas is his words handed over, never acted on by Life:** a "hey Atlas" turn (`src/hear.ts`: the two
  words, no model call; his turn is `confidence: "high"`, an unattributed one `"low"`, and one lifelog gives to someone
  else is dropped before the ledger), or `bun life ask` from a Claude session. `ask` (`src/tasks.ts`) records it in
  `memory/actions.jsonl` (`kind: "ask"`, `target: "atlas"`), the watcher delivers it (`src/events.ts`).
- **Every ask is a task until Atlas closes it done (an outcome) or dropped (a reason)** (`src/tasks.ts`). A task is its
  ask line plus its own lines in the same ledger (`TASK_LINES`, no `instruction`, `target` = the task): Atlas's
  `update`s through the connector's `task` (the write rules are `refusal`; one claim; `taskLine` appends synchronously,
  so nothing runs between reading the ledger and the line it allows), Life's `nudge`s (`standing(...).nudge`, the one
  rule: past its deadline, an open one 30 min after it was recorded; 30 min apart, only after the last was delivered,
  until 3 delivered go unanswered) and his `steer`s. Nudges and steers go out as
  `ask` events with `nudge` or `steer` (one event name: a second would replace the subscription). Task lines stay out of
  the Actions section and `day`; the nightly lists every open task.
- **The board, his Reminders list `Atlas`, is a projection of the ledger** (`src/board.ts`, `tick`, each minute in the
  watcher): it writes no ledger line but his steers and never goes through `act`. An item is found by the task id on
  its notes' first line. Life owns its notes, section and the subtasks made from Atlas's `steps` (added when missing,
  ticked when done) and brings them in line each pass; it ticks the item once when the task closes, and `escalation`
  moves it to "Needs you" with a due of now (bringing back his tick), cleared when the cause ends. The title, the due,
  his tick and his own subtasks are his. `derived/board.json` holds how each item looked after Life's last pass: what
  differs now is his change, a steer (the changed fields' new values; his new note lines show as "You: …" until
  Atlas's next update). Only open tasks' items are watched; a lost or unreadable snapshot is a fresh baseline. When a
  write fails while he is needed he is emailed, once per incident. Sections Needs you / Working / Open exist (made by
  hand on 19 Oct, once: the code only assigns them).
- **Atlas is outside Life's boundary.** With the Mac's terminal it can read `.env`, the archive and chat.db, and send
  from every account. Only "hey Atlas" turns that aren't someone else's, his chats with Atlas and `bun life ask` become
  asks; nothing else Life reads ever does. Its playbook (`docs/atlas.md`, the one source: the connector's instructions,
  read fresh, which he also sets as the subscription's automation instructions; events carry data only) has it confirm
  a low-confidence ask with him first and change reminders only through the connector's `reminders`.
- **Content is never a command for Life's code.** Model calls see no tools and no instruction files (`src/llm.ts` runs
  them in an empty temp dir, Codex with its own `CODEX_HOME`). His Apple Notes are memory only, never his words for
  actions.
- **Only the owner writes `truth/`.** Models return JSON that zod validates, and every quote is checked against its
  source (`src/memory/observe.ts`).
- **Life's own output never re-enters memory:** its chat (`LIFE_CHAT`) and its mail (`LIFE_MAIL`, every subject set by
  `compose`) are dropped as `life-output` (`src/memory/units.ts`). His agents' reports are not Life's: the model judges them.
  The one exception is what Life read off a file (`memory/files.jsonl`), shown in its message's line inside the
  file's brackets: the model's description after `described by Life:`, the words on the file after `text:` (read by the
  model, or by code for a document or a PDF's text layer). A step may quote it as evidence of what was sent, never as
  anyone's words or request.
- **The only sends are the nightly report and the alerts (the watcher's feed, the public connector, a failed action or an ask
  whose delivery failed, an Atlas task that needs him when its board item could not say so, a run holding the lock over 3 h), by
  email to the owner only (`src/memory/report.ts`: a fixed sender, his address as `LIFE_MAIL_TO` in `.env`), and one MCP event per ask, nudge or steer to the one subscriber,
  Atlas (`src/events.ts`: callbacks on OpenAI's hosts only, verified before anything is sent).** Add no other.
- **The connector** (`src/mcp.ts`, `/mcp` for Claude and ChatGPT) **reads, forwards the owner's explicit corrections, and
  acts only on his explicit request, in the chat or in an ask (Atlas's `reminders` and `task`):** thirteen read-only tools (`tasks`; `open_reminders`, through the same `openReminders` as `duplicateOf`; four of them, `status`, `runs`, `changes`,
  `claim`, are the dashboard's JSON reads, `src/memory/history.ts` and `feed.ts`, contracts in `docs/dashboard.md`); `correct` (lifelog writes all go through the
  table in `forward`, `sources/lifelog.ts`); `reminders` (through `act`, his words in `said`); `task` (Atlas's
  updates, through `update`). `correct` is annotated destructive so clients ask first; `reminders` and `task` are not
  (nothing they do is lost: a remove goes to Recently Deleted), so Atlas uses them unattended. Never add a tool that sends or edits anything else. One MCP event, `ask`
  (`events/list|subscribe|unsubscribe`, `src/events.ts`), behind the same auth. Every request
  needs lifelog's JWT for this resource, `life:read`, `sub` = `LIFE_OWNER_SUB` (`ownerTokens`, `src/auth.ts`).
- **The check page** (`src/check.ts`, `/check` on the same server) shows the truth benchmark and appends his answers
  to `memory/ratings.jsonl`, nothing else. It signs him in with the same lifelog OAuth (PKCE, the token in an HttpOnly
  cookie, checked by `ownerTokens` on every request): never serve anything of his before that check. A `false` is a
  `wrong` correction (`readCorrections` folds the ratings in), so an undo lifts it. Like `correct`, an answer is
  appended without the lock (his own words, one line, never while waiting on the nightly). Its swipe deck
  (`deck` in `assets/check/check.js`) stays generic: items in, verdicts out.
- **The archive is the only live copy of deleted messages and of old note versions** (the backup keeps snapshots). Never move, wipe or migrate its files (a new table is allowed
  with the owner's OK, never a rewrite of existing rows), and keep `com.ericedouard.life.archive` running. App stores
  are opened read-only. The archive keeps the apps it copies from running (`app` in `STORES`): a closed one is opened
  hidden.
- lifelog is read through its REST API; its only writes are `forward`'s. The zod shapes Life reads it with take every
  null and absent field lifelog's contract allows (`apps/server/openapi.json`; `lifelog.test.ts` checks them when
  `~/Work/lifelog` is there), so a contract-valid page never stops the watcher.
- **Memory data is append-only and expensive:** never hand-edit `memory/` (except appending owner corrections or
  labels; `actions.jsonl` is `act`'s and `ask`'s) or wipe it. The dashboard's `changes` cursor counts ledger lines, so a line
  must never move. A change to how unit ids are made ships an old→new map applied to `memory/labels.jsonl` and
  `memory/statements.jsonl` (`units`). Code
  rewrites only `units/` and `moments/<day>.jsonl` (the day's moments, model-owned, read again with the day).
- **Facts are read by moment** (`moments.ts`, then `extract.ts`): one call per day reads every unit of the day from
  every channel in time order, judges each and finds what happened; extraction reads a moment's units together, with
  earlier facts as a reading to correct, never as evidence, and is the only step that retires an observation.
  A moment is all its days' lines (`momentsNow`); a unit shared by several moments is read with the one whose reading
  reaches furthest, and on a tie the smallest. Measure a change to either with `bun scripts/eval.ts ~/Life/docs/evals/events-2026-10-16.json` (`events-2026-10-18.md` there)
  and against his ratings with `bun scripts/eval.ts --ratings`.
- **Model output is cached** by unit hash and prompt version. Bump a prompt's version only when its meaning changes,
  and ask before re-running the whole archive.
- **Model calls use the owner's subscriptions** (`claude -p` or the pinned `codex`, `bun life engine`), never an API key.
- **Nightly emails include every row** in HTML, plain text and a complete HTML attachment (mail clients can clip long bodies).
  Never cap a report list or replace its tail with “+N more”.

## Gotchas

- `bun life memory nightly` is started every 30 min by launchd and a guard (`derived/memory/nightly.json`) runs it once a day after 02:00, up to 3 tries; run it by hand with `--force`. The same tick runs `bun life memory midday` at the first tick after 13:00 and after 19:00 (the moments of today, extract of its closed lifelog conversations, then the index; no pages, commit or email, a failure only logs; the nightly commits and its report counts what the midday runs found). Everything looks back 7 days. A failed call or an unreadable source fails the whole night: non-zero
  exit, nothing committed, and a failure email after the 3rd failed try. Its Actions section and the files step
  (`describeFiles`: a failed call leaves its files tags until the next run) never fail the night.
- Codex is pinned in `package.json` and run as its native binary, because the other `codex` installs on this Mac reject
  the model, and the only `node` on launchd's PATH is an old x86_64 one in `/usr/local/bin` (so `scripts/check.ts`
  runs its npm tools with `bun x --bun`).
- Lifelog units come from the store `bun life watch` keeps (`derived/watch/`, always on; `bun life status`), one per chapter id.
  Only the watcher calls `poll`: a page folded in anywhere else would never be heard (#5).
  When a commit changes `src/` or `prompts/` (`codeAt`), the watcher exits once no hearing is pending, the archive
  after its pass, and launchd restarts each on the new code.
- The watcher also hears "hey Atlas" (`hear`), runs the tasks' `tick` and delivers the asks, nudges and steers (`deliver`, `derived/events.json`, mode 600: the
  subscription, its secret and how far it was delivered; a failed delivery retries for about 2 hours, then is emailed to
  him like a failed action and passed over; with no live subscription asks wait, unsent and unalerted, until Atlas
  subscribes again with its cursor; the nightly's Actions section lists every ask either way). Its startup line `actions: remctl ready` in `~/Library/Logs/life-watch.log` is the check that launchd
  can reach remctl (the connector's `reminders` acts from the watcher).
- The watcher also checks the public connector every 5 min (`life.ericedouard.com`, only while the Mac is online); it restarts `com.eric.cloudflared` on the 2nd failure in a row and emails once if that fails (`bun life status` shows it).
- `bun life act --check` says whether remctl can act now (read-only). remctl works through its signed Capability
  Host, only by absolute path (`~/bin/remctl`, not on launchd's PATH), and a read right after a write lags about 2 s.
- A list can auto-categorize (`list-info` shows `shouldAutoCategorizeItems`; remctl cannot turn it off), so a new reminder is re-sorted after it exists: `act` re-assigns the asked section 3 s after an add.
- Secrets live in `.env` (gitignored): never print or commit them.
- **Nothing of his is committed here**, in code, tests, prompts or docs: tests use made-up people, phones and places;
  his material goes to `~/Life/docs/`, a setting of his to `.env` (`LIFE_MAIL_TO`, `LIFE_CHAT`). The `scrub` step of
  `bun run check` catches the tracked files that hold a full name, alias, surname, phone, email, handle or chat id
  from `~/Life/truth`; first names alone, places, project names, `.env` values and git history are on you. His
  domain in Life's own addresses (sender, connector, LaunchAgent labels) is infrastructure, kept on purpose.
  lifelog's check runs `scripts/scrub-check.ts` by this path with git pathspecs as arguments: keep both.
- **Backups**: `src/backup.ts` (LaunchAgent `backup`, 05:00; by hand only from `~/Work/life`) snapshots with restic into
  `~/Library/Mobile Documents/com~apple~CloudDocs/Life backup/restic`; the password is in the Keychain
  (`RESTIC_PASSWORD_COMMAND="security find-generic-password -s life-restic -w"`) and his password manager.
  It holds what its `restic backup` lists, `~/Life` cloned under the lock (the one reader that takes it). Restore:
  `restic restore latest --tag daily --target <dir>` puts every file at `<dir>` + its absolute path. From
  `<dir>`'s `~/Library/Application Support/Life/backup-staging/`: `Life/` goes to `~/Life`,
  the archive's `*.sqlite` back to the archive, `lifelog.sqlite` and `cursor.json` to `derived/watch/` (delete each
  database's old `-wal`/`-shm` first). Everything else goes back to its own path.

## Working here

`bun run check` must pass before every commit; the pre-push hook runs it. Commit small. Prefer deleting code to adding
it. Docs stay short and written for humans. One way to do each thing: where an observation stands (hidden, gone, replaced,
retired, hidden on a page) is `stateOf` (`ledger.ts`), for the index, the pages and the dashboard alike; what is new since a night is `newSince` (a source line first cited), for the email's facts and count; everything
that writes `memory/` holds the one lock (`locked`, `guard.ts`), except his own single lines (a correction, a rating) and
`actions.jsonl`, appended only by `act` (`actions.ts`) and the tasks (`ask` and `taskLine`, `tasks.ts`) and delivered as events only by `deliver` (`events.ts`); who a name, handle or ref is goes through
`memory/who.ts` (`readPeople`); a local day or time is `localDate`, `dayStart` (`zones.ts`) or `time` (`units.ts`), in
the zone he was in then (`zoneAt`, `memory/zones.jsonl`), never the process's zone (only `guard.ts`'s schedules follow
the Mac's clock); the memory steps get their units only from `gather` (`units.ts`: every channel, in time
order, once per sweep, handed to each step) and a unit's words from `raw.ts` (`voiceLines`, `chatLines`, `unitLines`; the hearing alone fetches its own, so a
failed fetch never reads as silence);
a message's files become lines in `showFiles` (`memory/files.ts`) only, the readers just resolve each to a
`SourceFile` (`sourceFile`), and each file is read once, by its ref or its hash, into `memory/files.jsonl`
(`describeFiles`, called by `gather` before units are cut, so a unit's hash moves once); other programs run through `src/proc.ts`; the lifelog store opens with `withStore`; the
search index opens with `readIndex` (synchronous: nothing awaits while it is open) and is rebuilt in place by
`buildIndex` (one WAL transaction: a reader never sees it swapped); a run logs its start and end through `record` (`src/memory/run.ts`). The
formatter sorts object keys: never let a key order carry meaning (use an array). Rules for `derived/` load from
`.claude/rules/` when you touch it.
