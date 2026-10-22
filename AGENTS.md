# Life

A memory of the owner's life, built nightly from his voice (lifelog), chats, iMessage, mail and Apple Notes (and,
imported once, his past claude.ai and ChatGPT conversations: `bun life import`):
sources → units → verdicts → observations → people and area pages. Plus an always-on archive that keeps chat messages
deleted for everyone and every version of his Apple Notes. Where things stand and why: `docs/handoff.md`. Data formats: `docs/SCHEMA.md`. Relationships (arcs, closeness, the
backfill): `docs/relationships.md`, the plan and his decisions.

## Where his data lives

`memory/`, `truth/` and `imports/` (his claude.ai and ChatGPT exports, copied once by `bun life import`; every
such path here) are in `DATA` (`src/truth.ts`): `~/Life`, a local git repo of their own
with no remote, or `$LIFE_DATA`. Since the move to Life.app (`docs/transition.md`) `~/Life` and `~/Work/life/derived` are
links to the app's `MAC/data` and `MAC/state`: one live copy, read by the app and by `bun life` from the checkout
alike; `DATA` and `STATE` are resolved to their real paths where they are defined (`truth.ts`), so no code copies or
removes through those links. A secret file in `STATE` is written only by `writeSecret` or `secretIn` (mode 600), and
that mode is what keeps it out of an export (`secret`, export.ts). The nightly commits there and pushes nothing (`commitMemory` refuses a repo with a
remote): nothing of his goes to GitHub. Every worktree reads and writes that same `~/Life` and shares its one lock
(`~/Life/.nightly.lock`); point `LIFE_DATA` at a copy to experiment. Each `bun test` run (`NODE_ENV=test`) reads its
own copy of the made-up data (`src/test-data`), in a temp folder outside any repo, its lock and log there too: two runs
at once share nothing, and `commitMemory` refuses a folder that is not a repo's root. Rules for editing `truth/` are
in `~/Life/AGENTS.md`.

## It runs itself

The owner never runs `bun life …` and never reviews a queue. The commands are for you and for launchd. Don't design a
step that waits on him: an uncertain inference goes into a model-owned layer (like `memory/people-inferred.jsonl`)
that is used at once and corrected later.

His input arrives in conversation only. The one exception he asked for (19 Oct): the truth benchmark
(`memory/statements.jsonl`), statements he will rate true or false on his phone when he likes, never a queue Life waits on. When he states a fact or corrects one, record it before moving on:
`bun life memory correct '<json>'` (kinds in `docs/SCHEMA.md`: wrong, not-important, keep-mine, this-is,
not-this-person, same-person, closeness: how close someone is to him, personal or work; reread: units the model read wrong,
read again when their day is next read, older than 7 days by `bun life memory backfill`; who wrote a fact is resolved
when it is read, so a wrong author, and that person in the rest of the unit, is fixed by `truth/` or a correction
alone, with no reading),
or, when it's about who someone is, offer to add it to `truth/` and do it on his yes.
When he says which project a repo belongs to, or a project is added, put the repo in that project's `repos:` (he agreed to this map; `repos` shows
Life's guesses and the new projects it suggests), then `bun life validate`.
When he states a goal or a priority, or changes one, offer to put it in `truth/me.md` `## Goals` (numbered, his
priority order, each with the project ids it serves) and do it on his yes: his goals live there only.
When he says something matters or doesn't, also append a label to `memory/labels.jsonl` (the verdicts measure themselves
against them). His word beats the memory. `bun life memory unresolved` shows what Life inferred before you ask him anything.

When he asks you to change a reminder, use `bun life act '<json>'` (kinds, fields and `said`: `Change` in
`src/actions.ts`), never `remctl` directly: it logs what changed, from what, and why.
`act` refuses an add whose title an open reminder has (`duplicateOf`, every caller), and a timed `due` always alerts
at that time. Deep work on his life is Atlas's, his ChatGPT agent: hand it over with `bun life ask '<his words>'`, verbatim, never your summary.
`bun life asks [--from d --to d]` lists where each ask's time went (spoken, ended, arrived, recorded, delivered, claimed,
closed).

## Answering about his life

Everything is in the memory CLI (`bun life memory ...`); the connector's tools are these:

- `search <words> [--from d --to d]`: moments (what happened or is planned), Atlas's tasks (its own reports, matched when read), observations (each says who spoke when not him: "by" a sender, "heard as" a voice), units (each section says when it is cut at 12), from lifelog the exact spoken words (the best 20, each as its lines holding a word, 300 characters at most; each hit gives a conversation id and a turn) and the chat messages (the last 90 days, or from `--from`) and note versions and his messages to AI assistants (any age) holding all the words (newest 20, one around each; a long one as its lines holding a word). Then mail (the last 90 days, no newsletters nor Life's own, by the unit rules' terms: `searchableMail`): one line per thread-day, the newest 5 holding all the words, each its unit, when, sender, subject and its lines holding a word (200 characters). `--from`/`--to` bound every section.
- `fetch <id> [--from-turn n]`: a conversation's or a unit's lines, 200 at a time (a turn ref, an ask's `ref`, opens its conversation as it is now, 5 turns before it) (who spoke and when from Life's store, the words fetched from lifelog, not stored but in an ask's quote; chat and mail units from the archive).
- `day <YYYY-MM-DD>` (the birthdays of that day and the next 7 from `truth/`; what is due: his open items, ranked (`openItems`, `src/items.ts`: to-dos, promises and his reminders of that day or up to a week late, each shown to Atlas's review at most twice, waiting items on their day, and an undated one, or a reply he owes, the day after it was said and 3 days after, then
  stale, never due); what happened: the moments dated that day, then conversations, chat units, the day's key observations, and what Life changed that day and why), `person [name] [--before d]` (the whole page, when it was built, their next birthday, what Life holds about them by source and month, then every observation linked to them and the moments with them, newest first by whole days, `--before` paging back; `person me`: his own page, his goals in What I hold, all of truth/me.md; no name: who has a page, latest seen first; a name two people go by lists both; an unknown name is looked for among lifelog's speakers, and a name no one goes by lists the names near it), `area <name>` (an area's or a project's id or name), `topics [tag]`.
- `places --at <instant|date> | --place <name> | --latitude n --longitude n [--radius m] [--from d --to d]`: where he was (lifelog's location stays, the whole history, 200 at most), each stay with the conversations recorded during it. You supply coordinates; Life does no geocoding.
- `repos [project|area|repo]` (CLI only, not a connector tool): his code repos by project, where each is and the last 30 days of commits; his map is `Project.repos` in `truth/`, Life's guesses are marked inferred. Read a project's first repo (its main entry point) before working in it. Which mailbox sends what: `~/Work/CLAUDE.md`. Commits are also units (`source git`, one per repo and day): `search`, `day` and `fetch` show them.
- `chats --who <name|handle> | --chat <id> [--from d --to d] [--before instant]`: WhatsApp and Beeper (Life's archive, messages deleted for everyone shown marked) and iMessage, today included, as far back as `--from` (without it 90 days for `--who`, 7 for `--chat`), the latest 200; a cut names the `--before` that reads on.

Use the CLI; read a source directly only if it is unavailable: `~/Library/Application Support/Life/archive/` (`whatsapp.sqlite`,
`beeper.sqlite`, `notes.sqlite`, each with a `deleted` view) and `~/Library/Messages/chat.db`, read-only. Beeper is for acting only, and a send needs his OK on the exact text.

## Invariants

- **What the memory holds, in words, is `claimsNow`** (`statements.ts`): the statements he rates and the eval judge
  the same text.
- **He is the center, not one more person.** His own page (`memory/pages/people/me.md`, `OWNER` in `truth.ts`, its sections in `layoutOf`, `page.ts`) is a
  projection of the observations like every page, so its shape changes at the cost of rebuilding one page; his goals
  are only in `truth/me.md` (`truth.me.goals`), shown first on `person me` in its What I hold (as of the page's last build) and read fresh by the connector's `tasks` (`loadMe`). Nothing about him is stored in
  a separate record, and observations carry no owner-only field.

- **Life's own code acts in one place only, on the owner's clear request in a Claude session or a chat:** Apple
  Reminders (add, edit, done, undone, remove to Recently Deleted, restore), through `act` (`src/actions.ts`, the
  only code that decides it on his request; the tasks' board and the Past calendar are projections, below, never actions), which logs every action in `memory/actions.jsonl` (lines from before 19 Oct still parse). `act` decides and records (its intent before each write, its outcome after); `src/reminders/` is the only code that touches Reminders (`~/bin/remctl`), one job per module: `remctl.ts` the
  calls and his lists, `write.ts` the changes `act` decided, `board.ts` the projection of the tasks, `inbound.ts` his
  changes read back. Reminders is a plugin, input and output, on only with the `reminders` setting (`remindersOn`): off, `remctl` refuses every call, the minute pass skips it, the connector offers no `reminders`/`open_reminders` tool and `act` refuses, and the rest of Life runs the same; the board, reading his changes back, the grant and the playbook's Reminders parts (`<!-- reminders -->` in `docs/agent.md`, `protocol` in tasks.ts) exist only while it is on. Settings are read once per process: turning it on or off takes a restart of the watcher. Its backend is `remctl` (github.com/viticci/remctl, MIT) for every install, pinned in `REMCTL_RELEASE`: the app installs
  that release through remctl's own installer, and while Reminders is on with remctl behind the pin (an update of Life moved it) offers it again (Apple silicon only, like the app); its answers as Life reads them
  are `src/reminders/answers.json` (tested), the check when moving the pin. Delete the folder and Life still works from the ledger. Nothing Life hears or reads makes it act by itself. `act` refuses the list `Atlas` (`BOARD`): that list is
  the tasks' board below. One standing grant (decision 2 of the 21 Oct review)
  is the only other authority, off until his words in a Claude session turn it on (`bun life grant on|off '<his
  words>'`, a `grant` line in the ledger, the latest standing; his "stop" may come through Atlas, as off only takes
  authority away): `reminders` with `obs` in place of `said` adds a
  reminder (title, list, due, section) from his current salience-3 to-do or promise in a lifelog turn the store
  credits to him at that moment, at most 3 a day, one at a time, never on a shared list, and not again once one it made was removed (through Life or by
  his hand in Reminders), until his next yes (`grantRefusal`, all derived from the ledger); its authority is the
  observation alone, never the board, a /check tap or a chat `said`, and it binds the connector, not Atlas's terminal.
- **An ask for Atlas is his words handed over, never acted on by Life:** a "hey Atlas" turn (`src/hear.ts`: the two
  words, no model call; his turn is `confidence: "high"`, an unattributed one `"low"`, his own "hey" + the word lifelog hears for Atlas
  (the `agent` setting's `misheard`: a real name, or "at last") `"low"`, and one lifelog gives to someone else is dropped before the ledger), or `bun life ask` from a Claude session. `ask` (`src/tasks.ts`) records it in
  `memory/actions.jsonl` (`kind: "ask"`, `target: "atlas"`), the watcher delivers it (`src/events.ts`). Atlas also
  records one through `task` from his chat (`madeBy: "connector"`): his verbatim words with when he sent them (`said`,
  `at`; `ref` `connector:<at>`, one id per message and `title`), or a split of an open task (`parent`, `title`) that
  inherits its words; never a task without his words. It is claimed in the same call, so it sends no `ask` event. An ask line's
  `instruction.quote` keeps his words whole (clipped at 50,000 characters): the one place memory stores more than a short quote of his speech.
- **Every ask is a task until Atlas closes it done (an outcome) or dropped (a reason)** (`src/tasks.ts`). A task is its
  ask line plus its own lines in the same ledger (`TASK_LINES`, no `instruction`, `target` = the task): Atlas's
  `update`s through the connector's `task` (the write rules are `refusal`, behind the playbook's seal in `written`; one
  claim; `update` appends synchronously, so nothing runs between reading the ledger and the lines it allows), and its
  `reply` lines (what it told him; one on no task targets `chat`). `changes` with `about` `task:<id>` is a task's whole
  history. The nightly counts the last day's asks with no reply logged (`unanswered`). `nudge` and
  `steer` lines (until 20 Oct) only parse. What needs him is one rule, `escalation`, for every task, chat ones too:
  unclaimed 30 min after the ask, claimed and past its deadline, waiting on him over 1 h, a week old, or no live
  subscription (one email a day); `chase` (`src/tasks.ts`, each minute in the watcher) emails him once per task, cause and
  Atlas's last update, a pass's new causes in one email. Every send goes out once per key (`sendReport` skips one whose keys are all in the last 8 days of `email.sent`). Task lines stay out of the Actions section and `day`; the nightly lists every open task and
  those closed in the last day. Its Actions say "no daily review reached Life" when ChatGPT made no successful `day` call in
  24 h (`reviewed`, `nightly.ts`): Atlas's daily review must keep reading `day`.
- **Reminders is an interface, never Life's truth** (his decisions 15 to 17, 21 Oct): the ledger is. His changes there
  (tick, untick, edit, priority, urgent, add, delete) come back through `src/reminders/inbound.ts` each minute as state only: one
  `madeBy: "reminders"` line each, with no `instruction` (they are not his quoted words). They may close, reopen,
  reschedule, re-rank, rename, drop or add an item, never ask, send, approve or grant: an inbound change can take
  authority away or reorder, never add it. A value Life wrote or tried to write since the field last settled is
  Life's own (`act` records its intent first: #69), whatever Reminders shows, and so is a partial write's, and anything
  read within 30 s of a write of Life's (reads lag writes); section, order and a repeating
  reminder's next due are Apple's, never read; shared lists are never read. The first pass imports a baseline.
- **Open items are derived, never stored** (`openItems`, `src/items.ts`): from the observations, the ledger's reminders
  (`linked`: what `act` wrote and what sync read back) and his chats, ranked by code (his urgent flag and priority,
  who owes whom, his goals' order, closeness, age), each shown to Atlas's review at most twice (counted from the ids its `day` calls were
  logged with). `day`'s Due and `act`'s duplicate check read it, never Reminders (a reminder he made by hand counts once
  sync read it, within a minute); `open_reminders` alone reads Reminders, for the sections the ledger does not hold. A
  1:1 chat is `isDirect` (`src/sources/index.ts`), for replies owed and closeness alike.
- **The board, his Reminders list `Atlas`, is a projection of the ledger, his receipt** (`wantOf` in `src/tasks.ts`,
  written by `push` in `src/reminders/board.ts` each minute in the watcher): it writes no ledger line and never goes through `act`.
  The only thing read back is his tick or removal of an open task's receipt, which closes that task, done or dropped
  (`closings`, decision 17), so it is not added again; Atlas sees why in `tasks`. Nothing else on it is read as his
  (no steers: they once forged his voice). An item is found by the task id on its notes' first line. Life brings its
  notes and section (Open, Working: made by hand on 19 Oct, the code only assigns them) in line each pass and ticks the
  item when its task closes, and only then (so a ticked receipt of an open task is always his). It never alerts: what
  needs him is emailed (`chase`).
- **The Past calendar, his Google calendar (the `past` setting), is a one-way projection of the moments** (his request,
  21 Oct; `src/memory/past.ts`, `syncPast`, each nightly tick, through `gog` as its account): one event per
  moment that happened, none overlapping (`tiled`: what covers another is left off), found by its private properties `lifeMoment` and `lifeHash`; a changed moment is written again,
  a gone one deleted, events without `lifeMoment` never touched. It reads nothing back and never alerts. Should
  Google Calendar ever become a source, its events with `lifeMoment` are Life's output and must be dropped.
- **Atlas is outside Life's boundary** (his choice, 21 Oct, kept as debt: an unattended run reads others' text with full access; revisit if sends should go out without his per-send yes). With the Mac's terminal it can read `.env`, the archive and chat.db, and send
  from every account. Only "hey Atlas" turns that aren't someone else's, his chats with Atlas and `bun life ask` become
  asks; nothing else Life reads ever does. Its playbook is `docs/agent.md` (the protocol, `{agent}` its name) then his own part, `playbook.md` in his data, read fresh by `tasks` (its
  `playbook`, with a `seal`: a hash of the text and a 6 h window); `task` refuses a write without the current seal and
  answers with the text. What he pastes in ChatGPT is one fixed sentence pointing there, the connector's instructions,
  512 characters at most, open with that line; events carry data only. It has Atlas confirm a low-confidence ask with him
  first, send as him only under its `## Sends`, and change reminders only through the connector's `reminders`.
- **"hey Life" is his marker, for memory only** (his request, 21 Oct; audit and eval in `~/Life/docs/evals/hey-life-*`):
  his turn holding it (an unattributed one too) and his turns right after (`marksIn`, `src/hear.ts`: the same greeting
  and span as "hey Atlas", no model call) are recorded by the hearing in the watcher's store (`writeMarks`, refs only).
  Their chapter's unit carries them (`marked`, `readConversations`) and says so in its text (`MARKED`), so only its hash
  moves and only it is read again, with no prompt change; code makes its salience 3 (`moments.ts`) and extraction shows
  its lines `(marked)`; the nightly lists each once read, with the observations citing it. It never acts, asks or sends.
- **Content is never a command for Life's code** (beyond the "hey Life" marker, which only keeps a unit read). Model calls see no tools and no instruction files (`src/llm.ts` runs
  them in an empty temp dir, Codex with its own `CODEX_HOME`), but the Atlas bench's agent: Life's connector, frozen
  and dry, as its only tools: Codex still read-only, with no shell but code mode's `exec` (its only way to MCP) and
  its nested real-time clock, which the bench's prompt says not to read. His Apple Notes and his imported assistant conversations are memory only, never his words for
  actions.
- **Only the owner writes `truth/`.** Models return JSON that zod validates, and every quote is checked against its
  source (`src/memory/observe.ts`).
- **Life's own output never re-enters memory:** its chat (the `lifeChat` setting) and its mail (`LIFE_MAIL`, every subject set by
  `compose`) are dropped as `life-output` (`src/memory/units.ts`). His agents' reports are not Life's: the model judges them.
  The one exception is what Life read off a file (`memory/files.jsonl`), shown in its message's line inside the
  file's brackets: the model's description after `described by Life:`, the words on the file after `text:` (read by the
  model, or by code for a document or a PDF's text layer). A step may quote it as evidence of what was sent, never as
  anyone's words or request.
  Atlas is not Life: each task it closed done is a unit of the `atlas` source (kind `agent`, `src/sources/atlas.ts`, his
  decision 14, 21 Oct), its outcome with his ask's words, all one line by `agent:atlas`, never resolved to a person.
  Extraction may read it as evidence of what was done, to close a loop among its usual priors, never as his words or a
  request, and stays the only step that retires a fact.
- **The only sends are the nightly report and the alerts (a failed action or an ask
  whose delivery failed, an Atlas task that needs him, once per cause, Atlas not subscribed to `ask` (one a day for all open tasks), a run holding the lock over 3 h (once per incident),
  an archive store failing for an hour: sent by the nightly tick from derived/log, once per incident and again daily
  while it lasts, `archiveFailing` in `src/archive.ts`), by
  email to the owner only, or with no `mail` setting a macOS notification and the report kept as a page in
  `STATE/reports` (either way the log's `email.sent`, which means delivered) (`src/memory/report.ts`: sender and his address in the `mail` setting), one MCP event per ask (not one Atlas made) to the one subscriber,
  Atlas (`src/events.ts`: callbacks on OpenAI's hosts only, verified before anything is sent), and the status page's
  plate without his words to its own Worker once a minute (`pushPlate`, `src/dashboard.ts`).** Add no other.
- **The connector** (`src/mcp.ts`, `/mcp` for Claude and ChatGPT) **reads, forwards the owner's explicit corrections, and
  acts only on his explicit request, in the chat or in an ask (Atlas's `reminders` and `task`), or on the one standing grant, and logs Atlas's replies (`reply`):** thirteen read-only tools (`tasks`; `open_reminders`, read from Reminders (`openReminders`), never the board; four of them, `status`, `runs`, `changes`,
  `claim`, are the dashboard's JSON reads, `src/memory/history.ts` and `feed.ts`, contracts in `docs/dashboard.md`); `correct` (lifelog writes all go through the
  table in `forward`, `sources/lifelog.ts`); `reminders` (through `act`, his words in `said`, or an `obs` for the grant); `task` (Atlas's
  updates, through `update`); `reply` (what Atlas tells him, one `actions.jsonl` line, appended only: it sends nothing).
  `correct` is annotated destructive so clients ask first; `reminders`, `task` and `reply` are not
  (nothing they do is lost: a remove goes to Recently Deleted), so Atlas uses them unattended. Never add a tool that sends or edits anything else.
  Replies are Atlas's output, never his words: they don't enter memory as units (only, after decision 14b, through the
  `atlas` source, as evidence of what was done). One MCP event, `ask`
  (`events/list|subscribe|unsubscribe`, `src/events.ts`), behind the same auth. A refused token (not a missing one,
  never its body), the SDK's own rejections (`onerror`) and invalid arguments (`tool()` validates them itself) are
  logged as `mcp.call` with `error`; nothing reads a response back. Every request
  needs a JWT for this resource, `life:read`, from its issuer: Life's own (`src/oauth.ts`, at `<origin>/auth`: an app
  is approved with a pairing code from `bun life pair`, PKCE, one-use codes, refresh tokens replaced on use, its key in
  `STATE/oauth`), or the `connector` setting's (his lifelog, `sub` = its owner) (`ownerTokens`, `src/auth.ts`). Another
  issuer's keys are kept a day (`server.ts`); a failure to fetch them is `unreachable`, a 503 on /mcp and /check, never
  a refused token. The origin is his Mac's tailnet name (`bun life connect`, `--public` through Funnel for ChatGPT and
  Claude.ai, `src/tailscale.ts`) or his own Cloudflare tunnel (`tunnel: cloudflare`, the only one `tunnel.ts` heals).
- **The status page** (`src/dashboard.ts`, `/` and `/status/` on the same server; `src/plate.ts` reads every part) only
  reads, behind the owner's sign-in (`src/signin.ts`, the one sign-in for his pages) on the public port (`PUBLIC_PORT`,
  where a tunnel forwards the connector's origin), or for the app on the local port (`LOCAL_PORT`, served even without
  a connector, no tunnel ever points there) behind its local key (`keyRefusal`, `STATE/local.key`, mode 600): never
  serve anything of his before that check, and never take the key on the public port. The app's menu (the plate's
  `trouble`) and its status window show this page, never a second rendering of it. Its Worker (`worker/status.ts`, Cloudflare, only the page's paths routed to it) passes every request to
  the Mac and answers only when the Mac is out of reach, behind the same owner check, with what the Mac pushed: the plate
  without his words (`strip`) and the page's files. `docs/dashboard.md`.
- **The check page** (`src/check.ts`, `/check` on the same server) shows the truth benchmark and appends his answers
  to `memory/ratings.jsonl`, nothing else. It signs him in with the same lifelog OAuth (PKCE, the token in an HttpOnly
  cookie, checked by `ownerTokens` on every request): never serve anything of his before that check. A `false` is a
  `wrong` correction (`readCorrections` folds the ratings in), an `outdated` (true then, not anymore) a retirement
  (`readStanding`, `by` the claim itself: closed as history, never wrong), so an undo lifts either. Like `correct`, an answer is
  appended without the lock (his own words, one line, never while waiting on the nightly). Its swipe deck
  (`deck` in `assets/check/check.js`) stays generic: items and a list of verdicts in, verdicts out.
- **The portrait** (`src/portrait.ts`, `/me` on the same server, his request of 20 Oct) serves pages about him and
  his people from `~/Life/docs/portrait/` (written from his memory in a session, never in this repo): `/me` is
  `index.html`, `/me/<name>` is `<name>.html` (lowercase letters, digits, hyphens), `/me/<name>/clips/<clip>.m4a|json` a
  clip of that page (audio cut from lifelog, and lifelog's word timings shifted to it), and `/me/player.js` the clip
  player (`assets/portrait/`, code, so in this repo); nothing else. Its CSP allows inline styles, Google Fonts and
  those files only (no images). It is behind a password (`LIFE_PORTRAIT_PASSWORD`;
  unset, or no `connector` setting, `/me` is off), not lifelog's OAuth: he chose a password over the lifelog sign-in
  when offered both. The cookie is its expiry signed with the password, failed tries are capped; never serve the page
  before that check.
- **The archive is the only live copy of deleted messages and of old note versions** (the backup keeps snapshots). Never move, wipe or migrate its files (a new table is allowed
  with the owner's OK, never a rewrite of existing rows), and keep `com.ericedouard.life.archive` running. App stores
  are opened read-only. The archive copies, and keeps running, only the apps of the sources he turned on (`keptStores`, `app` in `STORES`): a closed one is opened
  hidden.
- lifelog is read through its REST API; its only writes are `forward`'s. The zod shapes Life reads it with take every
  null and absent field lifelog's contract allows (`apps/server/openapi.json`; `lifelog.test.ts` checks them when
  `~/Work/lifelog` is there), so a contract-valid page never stops the watcher.
- **Memory data is append-only and expensive:** never hand-edit `memory/` (except appending owner corrections or
  labels; `actions.jsonl` is `act`'s, the tasks', `setGrant`'s and the sync pass's) or wipe it. The dashboard's `changes` cursor counts ledger lines, so a line
  must never move. A change to how unit ids are made ships an old→new map applied to `memory/labels.jsonl` and
  `memory/statements.jsonl` (`units`). Code
  rewrites only `units/` and `moments/<day>.jsonl` (the day's moments, model-owned, read again with the day).
- **Facts are read by moment** (`moments.ts`, then `extract.ts`): one call per day reads every unit of the day from
  every channel in time order, judges each and finds what happened; extraction reads a moment's units together, with
  earlier facts as a reading to correct, never as evidence, and is the only step that retires an observation (besides his `outdated` answers).
  A moment is all its days' lines (`momentsNow`); a unit shared by several moments is read with the one whose reading
  reaches furthest, and on a tie the smallest. Measure a change to either with `bun scripts/eval.ts ~/Life/docs/evals/events-2026-10-16.json` (`events-2026-10-18.md` there)
  and against his ratings with `bun scripts/eval.ts --ratings`.
- **Model output is cached** by unit hash and prompt version. Bump a prompt's version only when its meaning changes,
  and ask before re-running the whole archive.
- **Model calls use the owner's subscriptions** (`claude -p` or the pinned `codex`, `bun life engine`); an install with none uses an API key (engine `anthropic` or `openai`, its key passed in by the app), never his.
  The one exception (his OK, 20 Oct): the bench's OpenRouter calls (`askOpenRouter`, `OPENROUTER_API_KEY`), each pinned
  to one host on OpenRouter's zero-retention list, and only through `LIFE_LLM` on a copy; his engine setting stays
  `claude | codex`. `LIFE_LLM`
  (one process's model, `llmOverride`) is the bench's and its judge's only (`scripts/bench.ts`), refused on `~/Life`; launchd never sets it.
- **Nightly emails include every row** in HTML, plain text and a complete HTML attachment (mail clients can clip long bodies).
  Never cap a report list or replace its tail with “+N more”.
- **Everything Life shows him follows the owner's Ledger brand** (emails, `/check`, `/me`, its icon, any new screen),
  one source: agent-config's `ledger-brand` skill (`~/.agents/skills/ledger-brand`: `SKILL.md`, its email rules, and
  `tokens.css`). `C` in `src/memory/email.ts`, `assets/check/check.css`, `src/portrait.ts`, `assets/icon/`, the status page's
  `assets/dashboard/styles.css` and its tab icon's `TONES` (`src/dashboard.ts`) copy its values (email takes no
  CSS variables): a brand change lands in the skill first. The icon is a bold italic L (Cormorant Garamond, outlined), ink
  ground, paper letter: `assets/icon/` `icon.svg` (tab, /check, connector; its one path is the L the tab recolours), `app.svg`
  (the app, on macOS's grid) and `menubar.svg` (a template image), rendered into the bundle by `scripts/app.ts`.

## The app

A friend's install is `Life.app` (`app/`, SwiftUI, menu bar; assembled by `bun scripts/app.ts`): it runs the compiled
helper (`scripts/helper.ts`) as launchd ran the checkout for him: `archive` and `watch` kept running, `memory nightly`
every 30 minutes, its data and state under `~/Library/Application Support/Life` (`LIFE_DATA`, `LIFE_STATE`), its files
as `LIFE_ROOT`, every secret the Keychain keeps under "Life" in its environment. The app never reads Life's files: it
asks the helper (`app` for what it shows, `settings`, `init`, `pair`, `connect`), so their shape lives in one place.
It starts Life at launch (`AppDelegate`; opening the menu retries a start that failed), and ships the status page
bundled by its build (`BUILT`, scripts/helper.ts, with the page's one config `PAGE`): a checkout bundles it on first use. Build it signed with one certificate
(`LIFE_SIGN_IDENTITY` in `.env`, scripts/app.ts): macOS knows an ad hoc build as a new app each time, so it would lose
its Keychain items and Full Disk Access. His own install has been the app since 22 Oct (`docs/transition.md`).

**One Life per Mac.** The archive and the watcher each hold a lock in `MAC` (`~/Library/Application Support/Life`,
shared by every install: `hold`, `src/lock.ts`), so a second install's copy waits instead of running beside it (two
archivers would write the one live copy twice, two watchers would deliver every ask twice). On his own data, a nightly
tick runs only for the install whose watcher holds the lock, or when none does (`isOtherLife`, nightly.ts); a copy or a
hand `--force` always runs. The status page reads those locks (`holder`, mac.ts), whoever runs them.

## Gotchas

- **One settings file says how this install differs from another** (`src/settings.ts`, `derived/settings.json`, zod
  strict): the connector's origin, issuer and owner, lifelog's address, Life's mail, the engine, the backup, the repos
  folder, his agents' report senders. A part left out is off, never an error: a fresh install with no settings runs.
  It is strict and read once per process, some of it when modules load (units, tasks, email, git), so a new key lands
  in code first, a bad file stops the watcher and the nightly, like `truth/`, and an edit takes effect when each
  service starts again (the app restarts them; launchd's need a `kickstart`). His agent is the `agent` setting (name, wake words, misheard forms,
  client prefix): every "Atlas" Life writes is its name, and the ledger's `target: "atlas"` is the stored word for the
  agent, kept as it is (append-only, like unit ids).
  Secrets stay in the environment (`.env`). Owner values are never defaults in code: tests read
  `src/test-data/state/settings.json`, made up.
- **Where things live is two roots** (`truth.ts`): `DATA`, his data (`LIFE_DATA`, a checkout's default `~/Life`), and
  `STATE`, Life's own state (`LIFE_STATE`, a checkout's default its own `derived/`): settings, log, the watcher's store,
  runs, the index. Nothing joins `derived/` by hand. The app sets both under Application Support. Beside them, fixed
  under `~/Library/Application Support/Life`: the archive, the backup's staging and Codex's home.

- `bun life memory nightly` is started every 30 min by launchd and a guard (`derived/memory/nightly.json`) runs it once a day after 02:00, up to 3 tries; run it by hand with `--force`. The same tick runs `bun life memory midday` at the first tick after 13:00 and after 19:00 (the moments of today, extract of its closed lifelog conversations, then the index, then the pages with new observations; no commit or email, a failure only logs; the nightly commits and its report counts what the midday runs found), and the backup once the night is done or from 06:00 (`backupDue`, its tries in `derived/memory/backup.json`; the snapshot's outcome stays in `derived/backup.json`). Everything looks back 7 days. Older days are read by the backfill: `bun life memory backfill --from d --to d` (both included) sets its range in
  `derived/memory/backfill.json`, and a tick with no midday run due, once the day's night went through, reads its next week, oldest
  first, as a midday-like sweep (`backfilled`, `nightly.ts`), four weeks a day at most (`backfillWeek`, `guard.ts`),
  so it never takes their turn nor all of his subscriptions; three failures of a week stop it. What a tick runs is `turnOf` (`guard.ts`, tested).
  Over 75% of his Codex quota (`reserved`) a tick runs no midday and no backfill week, and `scripts/eval.ts` and the
  bench refuse to start (the bench's own grading, `eval.ts --json`, skips the check: the bench made it); the night always runs. The quota is read from `codex app-server` (no model call, no quota spent)
  each tick and at the start and end of each sweep, eval and bench (`metered`, `run.ts`: on its `run.start` and `run.end`), logged as `quota.read` (the status's `midday.next` reads the last line), and shown in the nightly email. What a run spent (its model calls' tokens, on their `model.run` lines, and a metered run's two readings) is derived when read: `useOf` in `history.ts`.
  Pages follow at the next night. Only the last 7 days' messages get their files described; older ones stay tags.
  Record his zones for the range first (`memory/zones.jsonl`, his own account of where he was): a past zone may be
  added only before the first day memory has units of, and a backfill moves that day back. A failed call or a source that throws fails the whole night (one he did not turn on, or one that can't be read now,
  `missing`, is skipped and logged, never a failure: `readySources`; one turned on keeps its units in the days rewritten
  and those days' moments wait for it, shown as "can't read"): non-zero
  exit, nothing committed, and a failure email after the 3rd failed try. Its Actions section and the files step
  (`describeFiles`: a failed call leaves its files tags until the next run) never fail the night.
- Codex is pinned in `package.json` and run as its native binary, because the other `codex` installs on this Mac reject
  the model, and the only `node` on launchd's PATH is an old x86_64 one in `/usr/local/bin` (so `scripts/check.ts`
  runs its npm tools with `bun x --bun`).
- Lifelog units come from the store `bun life watch` keeps (`derived/watch/`, always on; `bun life status`), one per chapter id.
  Only the watcher calls `poll`: a page folded in anywhere else would never be heard (#5). Its `marks` table (the
  hearing's "hey Life" spans, refs only) is the one thing there not rebuilt from the feed: a new store has only the marks heard since.
  When a commit changes `src/`, `prompts/` or `assets/` (`codeAt`), the watcher exits (at start it hears again the turns first seen
  in the 10 minutes before the newest, `resumed`: harmless, as `ask` records a ref and title once), the archive after
  its pass, and launchd restarts each on the new code.
- The watcher hears a conversation once its speech is complete (`speechIn`, `hear.ts`): it reads a recording of under
  a minute of speech (lifelog's `durationSeconds`) as closed on 30 s of silence, lifelog's `cutter.ts` rule. If lifelog
  changes how it closes a recording, change `CLOSED_ON_SILENCE_S` with it. Only an ask whose wake has no speaker yet
  waits longer (`NAMING_MS`, 40 s), for lifelog to name him: a `low` ask stays low. So does a turn with no speaker yet
  that holds his misheard wake: it becomes an ask only once lifelog names him.
- The watcher also hears "hey Atlas" (`hear`), runs the tasks' minute pass (`tick`, `watch.ts`, beside the hearing loop, never awaited by it: `chase`, then
  Reminders both ways, whose read takes about 10 s, `sync.pull` in the log) and delivers the asks (`deliver`, `derived/events.json`, mode 600: the
  subscription, its secret and how far it was delivered; a failed delivery retries for about 2 hours, then is emailed to
  him like a failed action and passed over (offline, nothing is delivered: `deliver` runs only after a good poll); with no live subscription asks wait, unsent, until Atlas
  subscribes again with its cursor; the nightly's Actions section lists every ask either way). Its startup line `actions: remctl ready` in `~/Library/Logs/life-watch.log` is the check that launchd
  can reach remctl (the connector's `reminders` acts from the watcher).
- **The laptop is the host, and offline means delayed, never lost** (decided 20 Oct, `~/Life/docs/server-scope-2026-10-20.md`): the lifelog cursor is gap-free, hearing reaches back a week (`RECENT_MS`, skipped turns are logged)
  and delivery waits for a good poll, so nothing alerts on an outage. Reachability rests on the Mac kept awake on purpose (his choice, 21 Oct: a keep-awake setting he keeps on; nothing in Life sets it). Reconsider a server only on a measured loss (an
  ask lost, or acted on late with harm) or spoken asks above about one a day for a month (`actions.jsonl`).
- The watcher heals the Mac's tunnel (`src/tunnel.ts`, every 2 min): it restarts `com.eric.cloudflared` only on a 530
  (Cloudflare has no tunnel to the Mac), never on no answer (offline, or the watcher busy) or an app's 5xx (a dead app behind the tunnel once
  had another repo's watchdog restart it 35,000 times). It is the tunnel's only heal; other hostnames ride on it.
- `bun life act --check` says whether remctl can act now (read-only). remctl works through its signed Capability
  Host, only by absolute path (`~/bin/remctl`, not on launchd's PATH), and a read right after a write lags about 2 s.
- A list can auto-categorize (`list-info` shows `shouldAutoCategorizeItems`; remctl cannot turn it off), so a new reminder is re-sorted after it exists: `act` re-assigns the asked section 3 s after an add.
- Secrets live in `.env` (gitignored): never print or commit them.
- **A new key in `truth/` lands in code first.** The schemas are `.strict()`, and the watcher, the nightly and the
  connector read `~/Life/truth` with the code in `~/Work/life`: a key that code doesn't know stops them (21 Oct: the
  watcher, for 2 min). Write it only once its schema change is merged and live (`validate` from `~/Work/life`, never
  a worktree: `~/Life/AGENTS.md`).
- **Nothing of his is committed here**, in code, tests, prompts or docs: tests use made-up people, phones and places;
  his material goes to `~/Life/docs/`, a setting of his to `derived/settings.json` (`src/settings.ts`), a secret to `.env`. The `scrub` step of
  `bun run check` catches the tracked files that hold a full name, alias, surname, phone, email, handle or chat id
  from `~/Life/truth`; first names alone, places, project names, `.env` values and git history are on you. His
  domain in Life's own addresses (sender, connector, LaunchAgent labels) is infrastructure, kept on purpose.
  lifelog's check runs `scripts/scrub-check.ts` by this path with git pathspecs as arguments: keep both.
- **Backups**: `src/backup.ts` (the `memory-nightly` tick, once the night is done or from 06:00: once a day, 3 tries, `backupDue`; by hand only from `~/Work/life`) snapshots with restic into
  `~/Library/Mobile Documents/com~apple~CloudDocs/Life backup/restic`; the password is in the Keychain
  (the `backup` setting's password command) and his password manager.
  It holds one export (`stage`, `src/export.ts`, the same as `bun life export` and the app's Export…): `data/` his data
  cloned under the lock (the one reader that takes it), `state/` Life's state without secrets or the index, its watcher
  store and cursor, `archive/` every store and its media, and `manifest.json` (every file's sha256, what each part holds,
  the secrets left out by name). Restore: `restic restore latest --tag daily --target <dir>` puts the export at `<dir>`
  + its absolute path (`MAC/backup-staging`); `data/` goes to his data, `state/` to Life's state, `archive/` to the
  archive: `bun life import <dir>/…/backup-staging` into a new install (checked, never over his data, never into an
  existing archive), then the secrets the manifest names by hand. Secrets are in no backup (Life's sign-in and the agent's subscription pair again). Snapshots from
  before 22 Oct have the old layout: `backup-staging/Life/` is `~/Life`, its `*.sqlite` the archive's and
  `lifelog.sqlite` and `cursor.json` the watcher's, and the archive's media, `.env` and `derived/` at their own paths.

## Working here

`bun run check` must pass before every commit; the pre-push hook runs it. When he says something didn't work, it is
audited by `docs/audits.md`. A fix from an audit names its audit file in its PR and merges only with its regression
case; a PR that changes `prompts/`, `docs/agent.md` or his `playbook.md` says in its description which cases of those stages it re-checked
and how they came out (a review refuses either without it); Atlas end to end is `bun scripts/bench-atlas.ts` (his past
asks replayed frozen, cases in `~/Life/docs/evals/atlas-bench-cases.json`). Commit small. Prefer deleting code to adding
it. Docs stay short and written for humans. One way to do each thing: where an observation stands (hidden, gone, replaced,
retired, hidden on a page) is `stateOf` (`ledger.ts`), for the index, the pages and the dashboard alike; what is new since a night is `newSince` (a source line first cited), for the email's facts and count; everything
that writes `memory/` holds the one lock (`locked`, `guard.ts`), except his own single lines (a correction, a rating) and
`actions.jsonl`, appended only by `act` and `setGrant` (`actions.ts`), the tasks (`ask`, `update` and `reply`, `tasks.ts`) and the watcher's sync pass (`inbound`, `closings`) and delivered as events only by `deliver` (`events.ts`); who has a page is the closeness levels (`pagedNow`, `closeness.ts`; one not judged yet keeps a written page and is judged next night, `waitingOf`), never a list, and who is close to him personally (Between us, `close: true` for the models) is `personallyClose` there; who a name, handle or ref is goes through
`memory/who.ts` (`readPeople`; which person a name means, for `person` and `chats`, is `meant` there): a unit keeps its
people unresolved (a chat's or mail's senders, the names lifelog gives, as `unknown:`), every reader maps them with
`unitNow`, and who wrote a message is `speakerOf` (`units.ts`; the hearing's `whose`, `hear.ts`, is no resolver: it
asks only whether lifelog credits a turn to him); a local day or time is `localDate`, `dayStart` (`zones.ts`) or `time` (`units.ts`), in
the zone he was in then (`zoneAt`, `memory/zones.jsonl`), never the process's zone (only `guard.ts`'s schedules and the status page's waking hours, `waking` in `plate.ts`, follow
the Mac's clock); now is `clock()` (`src/clock.ts`), never `new Date()` or `Date.now()` (a duration is `performance.now()`):
`LIFE_NOW` stops it for the Atlas bench, on a copy of the data and in a worktree of its own only; memory is the copy as
of then, the live sources are cut at it, and a frozen run acts on and sends nothing (`unfrozen` in each of remctl, lifelog's `forward`, `sendReport`, the
events' `post` and the Past calendar's `gog`; the connector's `dry` and `sends` answer the bench); a source's behaviour is its descriptor in `src/sources/index.ts` (`SOURCES`, in cut order; only the ones he turned on, the
`sources` setting, are read, searched or shown: `enabledSources`): code
branches on its kind or capability, never on its name (only its own code, its reader and lifelog's units, names it),
and every table of sources (`CHATS`, `SEARCHED`, `WITH_PEOPLE`, their days) is derived from it (`tablesOf`,
`units.ts`); the memory steps get their units only from `gather` (`units.ts`: every channel, in time
order, once per sweep, handed to each step; the closeness counts alone read the sources over years, `WITH_PEOPLE`: days, never units) and a unit's words from `raw.ts` (`voiceLines`, `chatLines`, `unitLines`; a failed fetch throws, only a recording lifelog
no longer has is silent; the hearing alone fetches its own, since one not transcribed yet must not read as silence);
a message's files become lines in `showFiles` (`memory/files.ts`) only, the readers just resolve each to a
`SourceFile` (`sourceFile`), and each file is read once, by its ref or its hash, into `memory/files.jsonl`
(`describeFiles`, called by `gather` before units are cut, so a unit's hash moves once); other programs run through `src/proc.ts`; the lifelog store opens with `withStore`; the
search index opens with `readIndex` (synchronous: nothing awaits while it is open) and is rebuilt in place by
`buildIndex` (one WAL transaction: a reader never sees it swapped); a run logs its start and end through `record` (`src/memory/run.ts`). The
formatter sorts object keys: never let a key order carry meaning (use an array). Rules for `derived/` load from
`.claude/rules/` when you touch it.
