# The agent, the connector and actions

Developer reference: how Life acts, hands work to the agent and serves the connector.

Life is a memory: it reads. It acts in a few narrow ways, each logged in `memory/ledger.jsonl`, and hands deep work
to the owner's agent by recording his asks for it to pull. Life has no instructions for the agent and keeps no state of
its work: the agent keeps its own list.

## The agent

- His agents are the `agents` setting, by name: wake words and misheard forms. No two share a word. "hey <word>"
  makes an ask for the agent the turn's first wake word names (`after.agent`); `bun life ask <agent>` makes one for that agent. An agent is known on the
  connector by its pairing (`bun life pair <agent>`, the grant's agent claim): it pulls only its own asks; a grant with
  no claim (a plain app, `bun life pair` alone) reads only. Wherever Life names an agent, it writes its name; the word stored for its source (the ledger's `target`, its source's name, its units' sender)
  is one constant, `AGENT_WORD` (`core/names.ts`), kept as first written because stored data is append-only.
- **How asks reach it:** the agent pulls its own with `read_agent_asks` (`cursor`, `limit`; it returns `asks`, `cursor`,
  `remaining`), and keeps its own list; Life tracks no state of an ask past its line. Life starts no agent (beside the question cases' headless agent,
  a developer's benchmark: `docs/operations.md`, "Measuring"), except the
  agent's own `onAsk` command (`agents.<name>.onAsk` in the settings), once per new ask, detached, with no argument: it
  only tells the agent to pull. Two asks close together start it twice, so the command takes its own lock. Each ask has
  its `id`, `at` (recorded), `spoke`, `quote` and `confidence`. The cursor counts ledger lines, so an ask recorded late
  is never skipped and none comes twice.
- **The agent is outside Life's boundary.** With the Mac's terminal it can read `.env`, the archive and `chat.db`, and send
  from every account. This is a known, accepted risk (`SECURITY.md`, "Agents"): an unattended run reads others' text with full
  access, within his grants. Its rules (when it asks him first, what it may send) are its own, not Life's.
- Only these become asks: a `hey <agent>` turn that isn't someone else's, and `bun life ask`. Nothing else Life reads ever does.
- What the owner pastes into the agent is up to him ([Set up your agent](use/agent.md)); the connector's instructions
  (512 characters at most) are about the memory, not the agent.

## Asks

- An ask is the owner's words handed over, never acted on by Life. It comes from a `hey <agent>` turn (`apps/server/src/host/hear.ts`:
  the two words, no model call), or from `bun life ask` in a Claude session.
  - The owner's turn is `confidence: "high"`. An unattributed turn is `"low"`. The owner's own "hey" plus the word lifelog
    hears for the agent's name (the `misheard` setting: a real name, or "at last") is `"low"`. A turn lifelog gives to
    someone else is dropped before the ledger.
  - The ask and the turns after it, until another speaker or a 15 s pause, are one ask.
- `ask` (`apps/server/src/host/asks.ts`) records it in `memory/ledger.jsonl` (`kind: "ask"`, `target` `AGENT_WORD`), once
  per `ref`; `asksFor` is what `read_agent_asks` returns.
- An ask line's `instruction.quote` keeps the owner's words whole (clipped at 50,000 characters). This is the one place memory
  stores more than a short quote of speech.
- `bun life asks [--from d --to d]` lists where each ask's time went: spoken, ended, arrived, recorded.
- Old ledger lines of an agent's updates and replies (`TASK_LINES`) are history, parsed and never written; `read_memory_changes`
  with `about` `task:<id>` is an ask's whole history, and for one before 2 Nov 2026 its agent's lines.

## Actions: one backend

- **Life's code acts in one place only, on the owner's clear request in a Claude session or a chat: his items in one
  actions backend per install**, Apple Reminders (remctl) or Google Tasks (`gog`): add, edit, done, undone, remove,
  restore, through `act` (`apps/server/src/host/act.ts`). `act` is the only code that decides an action. It records its intent
  before each write and its outcome after.
- When the owner asks for a reminder change, use `bun life act '<json>'` (kinds, fields and `said`: `Change` in
  `apps/server/src/todo-list/contract.ts`), never `remctl` or `gog` directly: it logs what changed, from what, and why.
- `act` refuses an add whose title an open item has (`duplicateOf`), for every caller. A timed `due` always alerts
  at that time.
- **One contract, `TodoListBackend`** (`apps/server/src/todo-list/contract.ts`): his lists (not groups) and whether one is shared, a
  list's items (open, or ticked too), the deleted ones, one item, add, edit, done, undone, remove, restore, sections,
  `checks`. Items are one shape (`Item`), their ids strings; a ledger target is `<prefix>:<id>` (`reminder:412`;
  Google's `gtask:<list>/<task>`, not `task:`, which names an ask in `read_memory_changes`). `idOf` is the one place
  the connector's numeric `target` becomes an id (and `read_open_todo_items` gives a numeric id back as a number). The
  ledger's items are keyed by their whole target, and the read-back and `duplicateOf` see only the current backend's:
  after a switch, the other backend's items are never read, marked lost or matched.
- **Ids are strings** (Google Tasks' are `<list>/<task>`); the connector's `target` takes one, or a Reminders number as
  it first did, and `read_open_todo_items` gives ids as strings. The tools say what they do (`change_todo_item`,
  `read_open_todo_items`), whichever backend the install uses.
- **What a backend lacks is a capability (`can`), never a branch on its name**: `act` refuses a change that needs one
  (`lacks`), saying so. Reminders can do everything (sections, urgent, priority, alarms, moves, restore, subtasks,
  recurrence, the Claude link, sharing). Google Tasks has a title, notes, a day (no time, so no alarms) and subtasks,
  and none of the rest; its lists are never shared. Restore is an optional method: a backend without it cannot
  restore.
- Only `todo-list/` touches either backend (`docs/architecture.md`, "The code"); `act` (`host/act.ts`) decides and
  `inbound` (`host/inbound.ts`) reads the owner's changes back.
- **The to-do list output** is on only with the `todo_list` setting, which names the backend: `{"backend": "reminders"}` or
  `{"backend": "google", "account": "<his Google account>"}` (`isOn("todo_list")`). Off: `backend()`, the one gate, refuses every
  call, the minute pass skips it, the connector offers no `change_todo_item` or `read_open_todo_items` tool, `act` refuses, and the
  rest of Life runs the same. The read-back and the grant exist only while
  it is on. Settings are read once per process: turning it on or off takes a restart of the watcher. The connector's
  tools keep their names and arguments whatever the backend (a change forces a costly reconnect).
- Reminders goes through `remctl` (github.com/viticci/remctl, MIT), pinned in `REMCTL_RELEASE` and installed by
  remctl's own installer from the app; while Reminders is the backend and remctl is behind the pin, the app offers the
  update again (Apple silicon only). Google Tasks goes through `gog tasks … --json` as the setting's account. Their
  answers as Life reads them are `apps/server/src/todo-list/remctl.json` (recorded; re-check them when moving the pin) and
  `apps/server/src/todo-list/gog.json` (written from the Tasks API's resources, never run against an account). Without a backend
  Life still works from the ledger.
- Nothing Life hears or reads makes it act by itself.

### Reading the backend back

The owner's changes in the backend (tick, untick, edit, priority, urgent, add, delete) come back through `inbound.ts`
each minute as state only: one `via: "reminders"` line each, with no `instruction` (they are not the owner's quoted words).

- They may close, reopen, reschedule, re-rank, rename, drop or add an item, and nothing else (no ask, send, approval
  or grant).
- A value Life wrote or tried to write since the field last settled is Life's own, whatever Reminders shows; so is a
  partial write's, and anything read within 30 s of one of Life's writes (reads lag writes).
- Section, order and a repeating reminder's next due are Apple's, never read. Shared lists are never read. The first
  pass imports a baseline.

### Open items

`openItems` (`apps/server/src/memory/open-items.ts`) builds them from the observations, the ledger's reminders (`linked`: what `act` wrote and
what sync read back) and the chats. Code ranks them (the owner's urgent flag and priority, who owes whom, the owner's goals' order,
closeness, age); each is shown to an agent's review at most twice (counted from the ids its `read_day` calls were logged
with). `read_day`'s Due and `act`'s duplicate check read it, never Reminders; a reminder made by hand counts once sync read
it, within a minute. `read_open_todo_items` alone reads Reminders, for the sections the ledger does not hold. A 1:1 chat is
`isDirect` (`apps/server/src/memory/sources.ts`), for replies owed and closeness alike.

A person's page (`read_person_page`) lists every open item with them, whatever its day (`openWithOf`, `read-open-items.ts`):
the observations linked to them, the replies he owes them and the reminders made from those, ranked the same way
(`rankedItems`), what he owes first, then what he waits on (`isOwedToHim`). A reminder made by hand names no one, so it
is not on any page.

Its first block is what their time together was about: the titles of the last 60 episodes they took part in, by month (`episodeTitleLines`).

### The standing grant

The only other authority, off until the owner's words in a Claude session turn it on (`bun life grant on|off '<their
words>'`, a `grant` line in the ledger, the latest standing). The owner's "stop" may come through the agent, because off only
takes authority away.

- While on, `change_todo_item` with `obs` in place of `said` adds a reminder (title, list, due, section) from the owner's current
  importance-3 to-do or promise in a lifelog turn the store credits to the owner at that moment.
- At most 3 a day, one at a time, never on a shared list, and not again once one it made was removed (through Life or
  by hand) until the owner's next yes (`grantRefusal`, all derived from the ledger).
- Its authority is the observation alone: never a fact-check answer or a chat `said`. It binds the connector, not
  the agent's terminal.

## The Past calendar

A one-way projection of the episodes (`apps/server/src/memory/past-events.ts`), kept by `syncPast` (`apps/server/src/host/past-calendar.ts`), on with the `past` setting: each tick brings in line the episodes ending in the last 3 days (the calendar listed from a day before), the night's turn the whole calendar (a backfill, his corrections, renames);
one event per episode, overlapping as they happened (a big episode holds smaller ones), found by its private
properties `lifeEpisode` and `lifeHash`. A changed episode is updated in place, a gone one deleted; events without
`lifeHash` are never touched; one with no `lifeEpisode` (an older Life's) is deleted. It reads nothing back and never alerts. If that calendar ever becomes a source, its
events with `lifeEpisode` are Life's output and must be dropped.

## Appointments

His request of 8 Nov 2026: what he is due at, from any channel, in his own calendar before his agents plan his day or
week. Each night `appointments` (`apps/server/src/memory/appointments.ts`) reads his active facts ahead (plans and
bookings, never a hypothesis; recent undated plans too) with the appointments held, and writes `memory/appointments.json`: a trip and the dinner in it are two;
a later message (his tickets) moves the same appointment, which keeps its id by the facts it shares; a guessed time
says so. `syncAppointments`
(`apps/server/src/host/appointments-calendar.ts`, the `appointments` setting: account and calendar) brings that
calendar in line each tick, through the client the Past calendar shares (`google-calendar.ts`, `reconcile` in
`calendar-events.ts`), touching only events with `lifeOutput=appointments`:

- Until confirmed an event is titled `(Life) …` and shown as free. An agent confirms one with him by setting the
  private property `lifeConfirmed=yes` (`gog calendar update <cal> <id> --private-prop=lifeConfirmed=yes`); Life keeps
  amending it, without the mark, as busy.
- One deleted by him or an agent is his no: recorded `refused` (`appointment-events.jsonl`); no appointment citing all
  its facts is written again. One Life deletes is recorded `removed`, so it may come back.
- Times are the place's (`zone`, when it is not where he will be); a reading that forgets a held appointment keeps it
  while its facts hold and no new one cites them. An event turning all-day or timed is written again (Google cannot
  change it in place). The Past calendar never touches an event with `lifeOutput`, so both may share a calendar.
- Only a popup reminder, never mail (it would come back as a message). No guests, no invites sent.
- An event that ended is never touched.

## Marks

A mark is his words to Life, to keep: the unit is always read, every fact extracted, each at its own importance (at least
`KEEP_AT`). Three ways in, none of which acts, asks or sends. "hey Life" in a recording is Life's own wake word
(`LIFE_WAKE`, `host/hear.ts`): the hearing records the span (`spansIn`, `writeMarks`, refs only) and makes no ask; agents
may not use "life" or "live" as wake or misheard words. A message to himself (mail he sent only to his own addresses; every
message of a chat with himself, `chatPerson` in `units.ts`) is marked by its reader. What he tells Life in a chat
(`tell_life`) is the source `told`. The unit carries its marks (`marked`) and says so in its text (`MARKED`), so only its
hash moves and only it is read again, with no prompt change. Extraction shows its lines `(marked)`. The nightly lists
each once read, with the observations citing it ("Told Life").

## The connector

`apps/server/src/host/http/mcp.ts`, served at `/mcp` for Claude and ChatGPT. It reads, forwards the owner's explicit corrections and fact-check answers, appends his words (`tell_life`) and acts
only on the owner's explicit request (in the chat, or in an ask through the agent's `change_todo_item`) or on the standing
grant.

- **Tools:** read-only: `read_agent_asks` (the paired agent's own asks, above); `read_new_events` (Events, below); `read_open_todo_items`, read from Reminders; the status reads
  `read_life_status`, `read_processing_runs`, `read_memory_changes`, `read_observation`, see `docs/status-reads.md`; `read_fact_checks` and the memory reads. Writes: `correct_memory` (a memory correction, his answer to a fact check, lifelog
  writes all go through the table in `forward`, `apps/server/src/sources/lifelog.ts`) and `change_todo_item` (through `act`, with the owner's words
  in `said`, or an `obs` for the grant) and `tell_life` (`{said, asked?}`: appends his verbatim words to `memory/told.jsonl`, `memory/told.ts`; offered only while the `told` source is on, refused for an agent's token). `change_todo_item` exists only while the to-do list is on.
- `correct_memory` is annotated destructive so clients ask first. `change_todo_item` is not (a remove goes to
  Recently Deleted, nothing is lost), so the agent uses it unattended.
- **Events:** MCP's Events extension (`io.modelcontextprotocol/events`, a draft), by poll: `events/list` names
  `message.received` with the arguments an agent filters on (`person`, `channels`, `chat`, `from_me`, `text_matches`),
  `events/poll` returns what matched past the agent's cursor: who, where and when, never the text (`events.ts`). Any
  paired app may poll. A source has events when its descriptor has `incoming`. `read_new_events` is the same poll as a
  tool, for a client that can't send `events/poll` (a Claude app's mod, ChatGPT).
- **Auth:** every request needs a JWT for this resource with `life:read`, from Life's own issuer, the only one
  (`apps/server/src/host/http/oauth.ts`, at `<origin>/auth`: an app is approved with a pairing code
  from Life's panel, "Pair an app"; PKCE, one-use codes, refresh tokens replaced on use and kept 90 days, its key in
  `LIFE_STATE_DIR/oauth`), checked by `ownerTokens` (`apps/server/src/host/http/auth.ts`).
- **Logging:** a refused token (not a missing one, never its body), the SDK's own rejections (`onerror`) and invalid
  arguments (`tool()` validates them itself) are logged as `mcp.call` with `error`. Nothing reads a response back.
- **Origin:** the Mac's tailnet name (`bun life connect`; `--public` through Tailscale Funnel for ChatGPT and
  Claude.ai, `apps/server/src/host/http/tailscale.ts`), or the owner's edge Worker until #137 (`docs/architecture.md`). Docs write it as
  `<your connector origin>`.

## The only sends

What leaves the Mac, sends included, is listed once, in [SECURITY.md](../SECURITY.md#what-leaves-the-mac). Each output
Life can turn on or off (Reminders, the Past calendar, the appointments, the connector, the backup) is an entry in `OUTPUTS`
(`apps/server/src/core/outputs.ts`): its name and its switch, asked with `isOn`, and `off` says why one does nothing. Its own module
reads the rest of its settings. How the report and the alerts go out:

- To the owner only (`apps/server/src/host/report.ts`: sender and address in the `mail` setting), by email, or with no `mail`
  setting as a macOS notification with the report kept as a page in `LIFE_STATE_DIR/reports`. Either way the log's `email.sent`
  means delivered.
- The alerts: a failed action; a run holding the lock over 3 h (once per incident, from the watcher's minute: a hung
  night blocks the ticks); every card in red on the status snapshot (`redCards`, `redReport`: a source unreadable, its
  access gone, its archive store or bridge failing, lifelog not polled, the phone silent 12 h, the archive or the watcher
  stopped, truth/ refused, the actions backend unreachable), checked on each nightly tick: an email when a card's problem
  is new that day, listing every card in red, from the first tick that sees it (no grace: a source that can't be read
  holds its days back). Not a run's card (a night mails itself once out of tries) nor the Mac's (it repeats the
  archive's and the watcher's); amber and idle cards don't mail.
- A crash of any `bun life` command (thrown, or a promise nobody awaited) is a `run.error` line of step `crash`; the
  daily triage reads them.
- Every send goes out once per key (`sendReport` skips one whose keys are all in the last 8 days of `email.sent`).
- Each new voice ask: a push to his phone, "<agent> heard you" (`notifyPhone`, through lifelog), so a missing one
  tells him at once it was not heard. Never his words. Voice asks come only from lifelog, so without it there is none to push.
- Life sends nothing into a chat.
