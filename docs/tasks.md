# The agent, the connector and actions

Developer reference: how Life acts, hands work to the agent and serves the connector.

Life is a memory: it reads. It acts in a few narrow ways, each logged in `memory/actions.jsonl`, and hands deep work
to the owner's agent. This page holds the developer-facing rules. The agent's own instructions are
the playbook, `docs/agent.md`: it is read at run time, so it is not repeated here.

## The agent

- The agent is the `agent` setting: name, wake words, misheard forms, client prefix, transport. Wherever Life names
  the agent, it writes that name; the word stored for it (the ledger's `target`, its source's name, its units' sender)
  is one constant, `AGENT_WORD` (`schema.ts`), kept as first written because stored data is append-only.
- **The agent is outside Life's boundary.** With the Mac's terminal it can read `.env`, the archive and `chat.db`, and send
  from every account. This is a known, accepted risk (see `SECURITY.md`): an unattended run reads others' text with full
  access. Revisit it before any send goes out without the owner's yes on that send.
- Only these become asks: a `hey <agent>` turn that isn't someone else's, the owner's own chats with the agent, and
  `bun life ask`. Nothing else Life reads ever does.
- **The playbook** is `docs/agent.md` (the protocol, `{agent}` replaced by its name), then the owner's own part,
  `playbook.md` in the data root. `tasks` reads both fresh on every call and returns them as `playbook` with a `seal` (a
  hash of the text and a 6-hour window); `task` refuses a write without the current seal and answers with the text.
  The text between `<!-- reminders -->` markers is cut while the Reminders plugin is off: keep the markers.
- What the owner pastes in ChatGPT is one fixed sentence pointing at the playbook ([Set up your agent](use/agent.md)).
  The connector's instructions (512 characters at most) open with that line. Events carry data only.
- The playbook makes the agent confirm a low-confidence ask with the owner first, send as the owner only under its
  `## Sends`, and change reminders only through the connector's `reminders`.

## Asks

- An ask is the owner's words handed over, never acted on by Life. It comes from a `hey <agent>` turn (`src/hear.ts`:
  the two words, no model call), or from `bun life ask` in a Claude session.
  - The owner's turn is `confidence: "high"`. An unattributed turn is `"low"`. The owner's own "hey" plus the word lifelog
    hears for the agent's name (the `misheard` setting: a real name, or "at last") is `"low"`. A turn lifelog gives to
    someone else is dropped before the ledger.
  - The ask and the turns after it, until another speaker or a 15 s pause, are one ask.
- `ask` (`src/tasks.ts`) records it in `memory/actions.jsonl` (`kind: "ask"`, `target` `AGENT_WORD`); the watcher delivers
  it (`src/events.ts`).
- The agent also records one through `task` from the owner's chat (`madeBy: "connector"`): the owner's verbatim words and when
  the owner sent them (`said`, `at`; `ref` `connector:<at>`, one id per message and `title`), or a split of an open task
  (`parent`, `title`) that inherits its words. Never a task without the owner's words. It is claimed in the same call, so it
  sends no `ask` event.
- An ask line's `instruction.quote` keeps the owner's words whole (clipped at 50,000 characters). This is the one place memory
  stores more than a short quote of speech.
- `bun life asks [--from d --to d]` lists where each ask's time went: spoken, ended, arrived, recorded, delivered,
  claimed, closed.

## Tasks

- **Every ask is a task until the agent closes it done (an outcome) or dropped (a reason)** (`src/tasks.ts`). A task is
  its ask line plus its own lines in the same ledger (`TASK_LINES`: no `instruction`, `target` = the task).
- The agent writes `update`s through the connector's `task` (the rules are `refusal`, behind the seal in `written`; one
  claim). `update` appends synchronously, so nothing runs between reading the ledger and the lines it allows. `reply`
  lines are what the agent told the owner (one on no task targets `chat`).
- `changes` with `about` `task:<id>` is a task's whole history. `nudge` and `steer` lines are old kinds that only parse.
- **What needs the owner is one rule, `escalation`**, for every task: unclaimed 30 min after the ask, claimed and past
  its deadline, waiting on the owner over 1 h, a week old, or no live subscription (one email a day). `chase` (each minute in
  the watcher) emails the owner once per task with the cause and the agent's last update; a pass's new causes go in one email.
- Task lines stay out of the report's Actions section and out of `day`. The nightly lists every open task and those
  closed in the last day, counts the last day's asks with no reply logged (`unanswered`), and says "no daily review
  reached Life" when the agent made no successful `day` call in 24 h (`reviewed`, `nightly.ts`): the agent's daily
  review must keep reading `day`.

## Actions: Apple Reminders

- **Life's code acts in one place only, on the owner's clear request in a Claude session or a chat: Apple Reminders**
  (add, edit, done, undone, remove to Recently Deleted, restore), through `act` (`src/actions.ts`). `act` is the only
  code that decides an action. It records its intent before each write and its outcome after.
- When the owner asks for a reminder change, use `bun life act '<json>'` (kinds, fields and `said`: `Change` in
  `src/actions.ts`), never `remctl` directly: it logs what changed, from what, and why.
- `act` refuses an add whose title an open reminder has (`duplicateOf`), for every caller. A timed `due` always alerts
  at that time. `act` refuses the agent's list (`BOARD`): that list is the board, below.
- `src/reminders/` is the only code that touches Reminders (through `remctl`), one job per module: `remctl.ts` the
  calls and the lists, `write.ts` the changes `act` decided, `board.ts` the board, `inbound.ts` the owner's changes
  read back.
- **Reminders is a plugin**, input and output, on only with the `reminders` setting (`remindersOn`). Off: `remctl`
  refuses every call, the minute pass skips it, the connector offers no `reminders` or `open_reminders` tool, `act`
  refuses, and the rest of Life runs the same. The board, the read-back, the grant and the playbook's Reminders parts
  exist only while it is on. Settings are read once per process: turning it on or off takes a restart of the watcher.
- Its backend is `remctl` (github.com/viticci/remctl, MIT), pinned in `REMCTL_RELEASE` and installed by remctl's own
  installer from the app. While Reminders is on and remctl is behind the pin, the app offers the update again (Apple
  silicon only). Its answers as Life reads them are `src/reminders/answers.json` (tested): re-check them when moving
  the pin. Delete the folder and Life still works from the ledger.
- Nothing Life hears or reads makes it act by itself.

### Reading Reminders back

The owner's changes in Reminders (tick, untick, edit, priority, urgent, add, delete) come back through `inbound.ts`
each minute as state only: one `madeBy: "reminders"` line each, with no `instruction` (they are not the owner's quoted words).

- They may close, reopen, reschedule, re-rank, rename, drop or add an item, and nothing else (no ask, send, approval
  or grant).
- A value Life wrote or tried to write since the field last settled is Life's own, whatever Reminders shows; so is a
  partial write's, and anything read within 30 s of one of Life's writes (reads lag writes).
- Section, order and a repeating reminder's next due are Apple's, never read. Shared lists are never read. The first
  pass imports a baseline.

### Open items

`openItems` (`src/items.ts`) builds them from the observations, the ledger's reminders (`linked`: what `act` wrote and
what sync read back) and the chats. Code ranks them (the owner's urgent flag and priority, who owes whom, the owner's goals' order,
closeness, age); each is shown to the agent's review at most twice (counted from the ids its `day` calls were logged
with). `day`'s Due and `act`'s duplicate check read it, never Reminders; a reminder made by hand counts once sync read
it, within a minute. `open_reminders` alone reads Reminders, for the sections the ledger does not hold. A 1:1 chat is
`isDirect` (`src/sources/index.ts`), for replies owed and closeness alike.

### The board

The agent's Reminders list (`BOARD`, named after the agent) is a projection of the ledger, the owner's receipt
(`wantOf` in `src/tasks.ts`, written by `push` in `src/reminders/board.ts` each minute). It writes no ledger line and
never goes through `act`.

- The only thing read back is the owner's tick or removal of an open task's receipt, which closes that task, done or
  dropped (`closings`), so it is not added again. The agent sees why in `tasks`. Nothing else on the board is read as
  coming from the owner: steers read from it once put words in the owner's mouth.
- An item is found by the task id on its notes' first line. Each pass brings its notes and section (Open, Working:
  made by hand; the code only assigns them) in line, and ticks the item when its task closes, and only then, so a
  ticked receipt of an open task is always the owner's.
- It never alerts: what needs the owner is emailed (`chase`).

### The standing grant

The only other authority, off until the owner's words in a Claude session turn it on (`bun life grant on|off '<their
words>'`, a `grant` line in the ledger, the latest standing). The owner's "stop" may come through the agent, because off only
takes authority away.

- While on, `reminders` with `obs` in place of `said` adds a reminder (title, list, due, section) from the owner's current
  salience-3 to-do or promise in a lifelog turn the store credits to the owner at that moment.
- At most 3 a day, one at a time, never on a shared list, and not again once one it made was removed (through Life or
  by hand) until the owner's next yes (`grantRefusal`, all derived from the ledger).
- Its authority is the observation alone: never the board, a `/check` tap or a chat `said`. It binds the connector, not
  the agent's terminal.

## The Past calendar

A one-way projection of the moments (`src/memory/past.ts`, `syncPast`, each nightly tick), on with the `past` setting:
one event per moment that happened, none overlapping (`tiled`: what covers another is left off), found by its private
properties `lifeMoment` and `lifeHash`. A changed moment is written again, a gone one deleted; events without
`lifeMoment` are never touched. It reads nothing back and never alerts. If that calendar ever becomes a source, its
events with `lifeMoment` are Life's output and must be dropped.

## "hey Life"

The owner's marker, for memory only. The owner's turn holding it (an unattributed one too) and the owner's turns right after
(`marksIn`, `src/hear.ts`: the same greeting and span as `hey <agent>`, no model call) are recorded by the hearing in the
watcher's store (`writeMarks`, refs only). Their chapter's unit carries them (`marked`, `readConversations`) and says
so in its text (`MARKED`), so only its hash moves and only it is read again, with no prompt change. Code makes its
salience 3 (`moments.ts`) and extraction shows its lines `(marked)`. The nightly lists each once read, with the
observations citing it. It never acts, asks or sends.

## The connector

`src/mcp.ts`, served at `/mcp` for Claude and ChatGPT. It reads, forwards the owner's explicit corrections, acts only
on the owner's explicit request (in the chat, or in an ask through the agent's `reminders` and `task`) or on the standing
grant, and logs the agent's replies.

- **Tools:** thirteen read-only ones (`tasks`; `open_reminders`, read from Reminders, never the board; the dashboard's
  JSON reads `status`, `runs`, `changes`, `claim`, see `docs/dashboard.md`; and the memory reads); `correct` (lifelog
  writes all go through the table in `forward`, `src/sources/lifelog.ts`); `reminders` (through `act`, with the owner's words
  in `said`, or an `obs` for the grant); `task` (the agent's updates, through `update`); `reply` (one `actions.jsonl`
  line, appended only: it sends nothing).
- `correct` is annotated destructive so clients ask first. `reminders`, `task` and `reply` are not (a remove goes to
  Recently Deleted, nothing is lost), so the agent uses them unattended.
- Replies are the agent's output, never the owner's words: they enter memory only through the agent's source (`AGENT_WORD`), as
  evidence of what was done.
- One MCP event, `ask` (`events/list|subscribe|unsubscribe`, `src/events.ts`), behind the same auth. Callbacks go to
  OpenAI's hosts only, verified before anything is sent.
- **Auth:** every request needs a JWT for this resource with `life:read`, from its issuer: Life's own (`src/oauth.ts`,
  at `<origin>/auth`: an app is approved with a pairing code from `bun life pair`, PKCE, one-use codes, refresh tokens
  replaced on use, its key in `STATE/oauth`), or the `connector` setting's (lifelog's, `sub` = its owner)
  (`ownerTokens`, `src/auth.ts`). Another issuer's keys are kept a day (`server.ts`). Failing to fetch them is
  `unreachable`: a 503 on `/mcp` and `/check`, never a refused token.
- **Logging:** a refused token (not a missing one, never its body), the SDK's own rejections (`onerror`) and invalid
  arguments (`tool()` validates them itself) are logged as `mcp.call` with `error`. Nothing reads a response back.
- **Origin:** the Mac's tailnet name (`bun life connect`; `--public` through Tailscale Funnel for ChatGPT and
  Claude.ai, `src/tailscale.ts`), or the owner's own Cloudflare tunnel (`tunnel: cloudflare`, the only one
  `src/tunnel.ts` heals). Docs write it as `<your connector origin>`.

## The only sends

What leaves the Mac, sends included, is listed once, in [SECURITY.md](../SECURITY.md#what-leaves-the-mac). How the
report and the alerts go out:

- To the owner only (`src/memory/report.ts`: sender and address in the `mail` setting), by email, or with no `mail`
  setting as a macOS notification with the report kept as a page in `STATE/reports`. Either way the log's `email.sent`
  means delivered.
- The alerts: a failed action or an ask whose delivery failed; a task that needs the owner, once per cause; the agent
  not subscribed to `ask` (one a day for all open tasks); a run holding the lock over 3 h (once per incident); an
  archive store failing for an hour (`archiveFailing` in `src/archive.ts`, once per incident and again daily while it
  lasts).
- Every send goes out once per key (`sendReport` skips one whose keys are all in the last 8 days of `email.sent`).
- The ask events (`src/events.ts`) go to the one subscriber, one per ask the agent did not make itself.
