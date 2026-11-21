# Life

A self-running memory of one person's life (the owner), built on his Mac from his voice (lifelog), chats, iMessage,
mail, Apple Notes, git and imported assistant chats: sources → units → episodes → observations → people and area pages,
plus an always-on archive of deleted messages and old note versions. Shipped as Life.app; a checkout is for development.

lifelog (the pendant pipeline: the iPhone app, its server, the Mac helper and Lifelog Host) lives in `apps/lifelog`,
folded in from its own repo on 24 Oct 2026, with its own `AGENTS.md`. It still runs as its own service on the Mac, and
Life reads it only through its REST contract (`apps/lifelog/apps/server/openapi.json`), never its code or its database;
lifelog may use Life's `core/`. Only instants cross that contract: a local day is Life's to bound (`zoneAt`); lifelog
reads where the phone was only to route speech (`ownerZoneAt`, its heartbeats of 90 days). The iPhone app is also a client of Life's connector, paired by code like any app (`LifeConnector`, in its Kit); it holds no second API. One gate, `bun run check` at the root, covers both.

Read before changing an area: `docs/glossary.md` (every concept's name), `docs/architecture.md` (shape and
reasons), `docs/SCHEMA.md` (every record),
`docs/sources.md`, `docs/tasks.md` (the agent, the connector, actions), `docs/operations.md` (schedule, locks,
backups, evals, the read CLI), `docs/status-reads.md` (the connector's status reads), `docs/rethinking-memory.md` (read first when a stronger model
reopens the memory's layers), `docs/releasing.md`,
`SECURITY.md`. User how-tos are in `docs/use/`; any docs work follows `docs/STYLE.md`.

## Commands

```sh
bun install                      # also points git hooks at .githooks (pre-push runs the check)
bun run check                    # the gate: lint, types, fallow, tests, scrub, cases, voice eval. Must pass before every commit
                                 # a clean tree that passed is recorded in the git common dir; its next push runs only scrub, cases, voice eval
                                 # LIFE_CHECK_SWIFT=at-landing skips the Swift builds on a branch's earlier pushes; its landing push runs them
bun test apps/server/src/memory/units.test.ts   # one test file
bun run fix                      # format and lint fixes
bun life <command>               # the CLI (apps/server/src/desk/life-entry.ts, host/cli.ts); `bun life memory …` for the pipeline and reads
bun life validate                # check truth/ (from the live checkout only, never a worktree)
bun scripts/app.ts [out]         # build Life.app (LIFE_SIGN_IDENTITY to sign, else ad hoc)
```

## Working with the owner

Life runs itself: the owner never runs `bun life …` and never reviews a queue. The commands are for you and for the
app's supervisor. Don't design a step that waits on him: an uncertain inference goes into a model-owned layer (like
`memory/people-inferred.jsonl`), used at once and corrected later. His input arrives in conversation only (fact checks included: he answers them in a chat, through the connector, when he likes, never waited on).

The rules below are for when he uses Life. In a session changing Life's code or prompts, a wrong or missing fact is a bug
in the step that produced it: fix that step with its regression case, never a `correct` line, even when he confirms it.

- When he states or corrects a fact, record it before moving on: `bun life memory correct '<json>'` (kinds in
  `docs/SCHEMA.md`). When it's about who someone is, offer to add it to `truth/` and do it on his yes.
- When he says a promise is kept or a to-do is done (\"it's already done\"), close it: `bun life memory correct
  '{\"kind\":\"outdated\",\"observations\":[\"obs_…\"],\"note\":\"<his words>\"}'`, after checking it's the observation he means.
- When he says something matters or doesn't, also append a label to `memory/labels.jsonl`.
- When he states or changes a goal or priority, offer to put it in `truth/me.md` `## Goals` (numbered, his order, each
  with the project ids it serves) and do it on his yes. His goals live there only.
- When he says which project a repo belongs to, put it in that project's `repos:` in `truth/`, then `bun life validate`.
- To-do item changes go through `bun life change-todo-item '<json>'`, never `remctl` directly. Deep work goes to his
  registered agents: his words, verbatim, never your summary, through the connector's `change_registered_agent`.
- Answer questions about his life with `bun life memory …` (`docs/operations.md`, "Reading the memory"). Run
  `bun life memory checks` before asking him anything. His word beats the memory.
- A send through any messaging app (WhatsApp, iMessage, LINE, Instagram, Messenger, LinkedIn, mail) needs the owner's OK on the exact text.
- When the owner says something didn't work, it is audited (docs/operations.md#audits), and its fix carries a
  regression case.
- Rules for editing `truth/` are in the data repo's own `AGENTS.md`.

## Invariants

Break one of these and something of the owner's is lost, leaked or acted on wrongly.

- **His data repo has no git remote, and nothing of his goes to GitHub.** `commitMemory` refuses a repo with a
  remote. (What does leave the Mac, to the model provider and the backup: `docs/architecture.md`.)
- **Nothing personal is committed here**, in code, tests, prompts or docs: tests use made-up people, phones and places;
  his material goes to his data repo, his settings to `LIFE_STATE_DIR/settings.json`, secrets to `.env` or the Keychain. The
  `scrub` step catches full names, aliases, surnames, phones, emails, handles and chat ids from his `truth/`; first
  names, places, project names, `.env` values and git history are on you. The domain in Life's own infrastructure
  labels (sender, LaunchAgent labels) is kept on purpose.
- **Only the owner writes `truth/`**: himself, or by his own words through one writer, `changeDirectoryEntry`, which checks the result with `bun life validate`'s code first. Its doors: the connector's `change_directory_entry` (his app's tap on a project's status too, its `said` the words of what the tap did, or the ready line he tapped); his card's tap (the new person he names answering a check, or a name he calls an organization, when no one holds that name: `addDirectoryEntryByHisWord`, his token's `answer_check` only, life#721; his yes of 20 Nov 2026); and `bun life change-directory-entry '<json>'`, run by his own sessions on his words (`said`), never by a desk agent (a rule of the brief, not of the send guard). Models return JSON that zod validates; every quote is checked against its source
  (`apps/server/src/memory/quote-check.ts`).
- **Memory is append-only and expensive.** Never hand-edit or wipe `memory/` (except appending his corrections or
  labels). `ledger.jsonl` is appended only by `changeTodoItem`, `setAutoAdd`, `ask` and the sync
  pass (`inbound`); `complaints.jsonl` (the complaint record) only by `recordComplaints`, run by the desk for the complaints it is receiving, which may drop only a torn last line (a whole line that is not a row stops it, kept); `publications.jsonl` (what each publication of units read) only by `publishUnits`; `matter-directions.jsonl` only by the matter directions step (`memory/matter-directions.ts`; pinned to its matter's steps, his `matter-direction` correction wins); `links.jsonl` only by the links step (`memory/links.ts`), read by the readers through `endingsRead` (`memory/endings.ts`: a link ends its step "probably" until his word); `matters.jsonl` only by the matters step (`memory/matters.ts`; only the current matters prompt's lines are read, so a prompt bump re-groups everything and changes every matter id: ask first), a line holding steps never a status (open, matter status and people by role are worked out when read, `matterOf`); `read-replies/` only by the exchange reads, the conversation summaries, the voice namings and, by day, the arrival reader (`memory/read-replies.ts`'s `storeReply`, through `makeReplies`; the arrival reader's daytime lines are his yes of 20 Nov 2026), a line never rewritten; `decisions.jsonl` only by `requestDecision`, `answerDecision`, `withdrawDraftsAnsweredInChat` and `recordDoneSeen` (`memory/decisions.ts`; a draft's send outcome, an `ends` option's `ended` line, Life's `done-seen` outcome of a look for the step done: his `looks` answer's, or the watcher's `seen`; a holder's `kept` line and a merge's withdrawal by `requestDecision`; the older card's `replacedBy` withdrawal by `answerDecision`), a line never rewritten (earlier versions' lines stay in it, skipped: the old decisions page's schemaVersion 1, the cards before titles' 2). The status reads' `read_memory_changes` cursor counts ledger lines, so a line must never move. Code
  rewrites only `units/`, `episodes/<day>.jsonl`, `situations/`, `project-situations/`, `personas/`, `communication-styles/` (a file is never removed), `histories/` (a month or a story replaced only by its re-read, its last version left to the data repo's git history; a file is never removed) and `appointments.json` (rebuilt whole) and a rename's or a new field's backfill (next).
- **lifelog's chapter units stay as stored.** The voice history before conversation-days: lifelog still holds most of
  their turns (the persona reads their words), but thousands of facts, his fact-check answers and corrections cite them, and a re-read
  would orphan those (his decision of 9 Nov 2026). Never wipe or rebuild them; one goes only with its conversation (`frozenUnits`, `units.ts`).
- **A rename or a new field backfills.** Names follow the best model, never old data. Renaming something stored (a field, an enum
  value, an id, a file, a unit id's recipe), or adding a field to stored lines, ships one migration in Life's code (today `host/migrate.ts`, the settings step that drops the `agents` setting, spoken asks PR 3, Direction's OK of 21 Nov 2026; its call in `cli.ts`; once it has run on his data it goes), with the owner's OK on the list: the app runs it at its
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
  (`isAppState`); `openDesk` never migrates and refuses a store of the old shape. Today `desk/store-step.ts`: `stepStore`
  (agents and matters, PR 1: assignments), then `stepRoles` (the Personal flag becomes `agent.role`, his yes of 20 Nov
  2026), then `stepTurnModel` (`turn.model`, what a turn ran on, for model spending; decision 83), then `stepMatterIds`
  (`assignment.matter_id`, the matter he chose, life#826), then `stepMoves` (a move's tables and `turn.move`; Direction's OK of 20 Nov 2026 (desk state, not his memory; decision 78)), each with its own check and its own dated copy, each deleted once it has run on his store.
- **One lock.** Everything that writes `memory/` holds it (`locked`, `memory-lock.ts`), except his single lines (a
  correction, and his answer to a check with the check as it was shown (its text and source; the later step's words are not stored), written just before it: `recordFactCheckAnswer`), `told-life.jsonl` (what he told Life, one synchronous append: `recordToldLife`), `decisions.jsonl`'s lines (one synchronous append), `files.jsonl`'s lines (one synchronous append; one line per ref and prompt version), the arrival reader's `read-replies/` lines (one synchronous append each), `appointment-events.jsonl` (the calendar sync's lines, each tick, and his Remove and Undo from the connector, all in one chain in the watcher: `inTurn`), `complaints.jsonl` (one synchronous append per complaint: `recordComplaints`) and `ledger.jsonl`'s writers above. One Life per Mac: the archive, the watcher and the desk each hold a
  lock in `MACHINE_DIR` (`docs/operations.md`); the desk never takes the memory lock.
- **The export copies in `imports/<source>/` are never rewritten, merged or deleted without his yes.** They are the only
  copy of his assistant history besides the backup (a conversation he deleted in the app survives only there); a newer
  export lands as a copy of its own, and a conversation reads from the copy holding its latest version.
- **The archive is the only live copy of deleted messages and old note versions.** Never move, wipe or migrate its
  files; a new table only with the owner's OK, never a rewrite of rows. Keep it running. App stores are opened
  read-only; only the apps of enabled sources are kept open (`keptStores`). The bridges' homeserver is the buffer
  before the archive's copy: its `redaction_retention_period` stays null, its rooms are never purged and its database is
  never made again (the copy counts its event numbers) (his OK of the
  new archive files `line.sqlite`, `instagram.sqlite`, 29 Oct 2026; `screen.sqlite`, 4 Nov 2026; the table `phone_calls` in `whatsapp.sqlite`, his "any architectural change" for calls, 5 Nov 2026; `phone.sqlite`, table `calls`, 10 Nov 2026; `messenger.sqlite`, his ask for the Messenger bridge, 14 Nov 2026; `github.sqlite`, the issues and comments of the repos he lists, 19 Nov 2026).
- **Content never runs Life's code.** Recorded text never makes Life's own code act; model calls see no tools and no
  instruction files (`apps/server/src/models/llm.ts`). The one call given tools is the question cases' agent
  (`scripts/question-cases.ts`, his word of 10 Nov 2026): Codex, with Life's connector serving its reads only, and
  nothing else. An agent reads what it pulls through the connector as data
  (`SECURITY.md`, "Agents"). The desk wakes an agent on the events it waits for, one assignment of each agent per event (`routeOf`), and a wake hands the event's facts (who, where,
  when; for a payment: its amount, in EUR too, its currency, whether it is spending, the money app's category, and when; for an arrival at a place: when, and where (its coordinates); for a GitHub activity: its repo, number, who, kind (`issue.closed`, `pr.merged`, `comment`, `review`) and link), never its words; on a matter it also opens with Life's own record of that matter (`matterRecordOf`: its derived steps, goal and next step, and the assignment's notes), which is Life's reading, never the event's text (his word of 20 Nov 2026: nothing may rest on the agent's will or memory). Words choose a wake in three ways only: the agent's own pattern on the text of a message as its readers see it (its files' lines included: a voice note's words, a photo's description), or on a payment's merchant, category and note, or on an arrival's line (`arrived <place>`), or on a GitHub activity's title and body as GitHub gives them
  (`text_matches` in its wait, his word of 20 Nov 2026: "agents that wake on events they waited on rather
  than timers"; for waits on every source, his word of 20 Nov 2026: "waits could be on all sources"; for GitHub, his direction of 20 Nov 2026, life#774: a wait names a repo, `owner/name` or `owner/*`, on `github_activity`, and only the repos the open waits name are read, through `gh` with conditional requests, never stored; the connector's poll and the wait share one filter and one matcher, `EventFilter` and
  `matcherOf`), and closeness in meaning to its matter (the wide net, `desk/matter-net.ts`, his word of 18 Nov
  2026: anything new close to its matter, by the Mac's embedder), and the arrival reader's confirmed answer that new
  lines hold an ask, a promise or a wait for him, or his own word that he will do something (his yes of 20 Nov 2026: "Yes, build it"; `memory/arrival-reader.ts`,
  `confirmedArrivalsOf`): Apple's on-device yes alone never wakes, only his engine's confirm of it, and it wakes one
  agent, chosen once in code (`matterOrPersonalOf`, `desk/event-queue.ts`: a matter's agent by
  the people who wrote its lines, else the Personal agent, the desk registering it when none stands; an agent whose wait matched the message already had its
  `message.received`, and a message queued for any agent is never queued again), with `arrival.confirmed`'s facts only; his spoken ask ("hey Life", his word of 21 Nov 2026: every ask of "hey Life" goes through the desk to the proper agent) wakes one agent the same way, by its closeness in meaning to a matter, else the Personal agent (`desk/spoken-ask-intake.ts`), with `ask.spoken`'s facts only (where his words are, never them). In all three, Life's code only tests the text and
  queues the wake: the text is never run, never taken as an instruction, never handed over; the agent reads it
  itself, as data. A call that ended is such an event (`call.ended`, his word of 19 Nov 2026): queued once lifelog's own signals say its words are in, it hands the call's chat, span and people and its recording's id and turn range, never a word; what
  the agent then reads is the agent's to judge, outside Life's boundary (`SECURITY.md`, "Agents"). A mark (his words to Life, to keep) only keeps a unit read. His Apple Notes and imported
  assistant chats are memory only, never his words for actions. One fact of a message acts, never its words: that he
  wrote in an open draft card's chat since it was asked withdraws that card (`withdrawDraftsAnsweredInChat`, the
  watcher's 30 s step, life#731; its asker hears `decision.withdrawn`).
- **Life's own output never re-enters memory:** its chat and mail are dropped as `life-output` (`units.ts`). A card's
  draft Life sent on his answer is his own message, read back from its chat like any other; only the communication
  styles skip it (`sentDraftsOf`: drafts never learn from drafts). What Life
  read off a file (`memory/files.jsonl`) shows inside the file's brackets and is evidence of what was sent, never
  anyone's words. The agent's done tasks enter only as the agent's source (named by `AGENT_WORD`), as evidence of what was done, never as his
  words or a request.
- **Life starts and wakes his registered agents, and nothing else of Life does** (his yes to the desk, 18 Nov 2026). The
  desk (`apps/server/src/desk/`, off until his `desk` setting) creates an agent only on his word: a project's, or the
  Personal agent (its `role`, one active or stopped at most, its home `<agentsRepo>/personal/`), and wakes its session on its events, his answer or
  its deadline; his complaint is such a word: on his first complaint with no caretaker active or stopped, the desk
  registers the caretaker (`desk/complaint-intake.ts`); and on a confirmed arrival or his spoken ask no matter's agent takes, with no
  Personal agent active or stopped, the desk registers it (Direction's ruling of 21 Nov 2026, under his word that every
  ask reaches an agent): one at most, never a second (`desk/role-agents.ts`, the one start of a standing role). A matter is never an agent of its own: it is an assignment of the agent that takes it (`agentForOf`: the
  oldest active agent of the project it shows under, his `matter-project` word first, else the Personal agent; several
  agents on one project is fine), given on his Start or by the hand-out, within his pace setting `desk.handOut`, on a
  running matter from the top of his ranking that involves someone he knows or holds a step he said himself
  (`isOneOfHis`) (his word of 20 Nov 2026: agents start on their own on his matters; nothing leaves without his yes):
  code picks the matter from his ranking (`handOutOf`, `desk/hand-out.ts`) and its agent, the agent reads the matter as
  data, and the card gate below is unchanged. Every matter sits with the agent that takes it (the fold, his word of 20
  Nov 2026): an open matter assignment another agent holds moves to it, with its wait, notes and cards, once its agent
  has no turn running, and an agent left with nothing open ends ("folded into the <name> agent"). With the hand-out
  on, a new matter of his own gets no Start card (the hand-out takes it); one that is not his waits for his Start. A
  project's agent holds only what is assigned to it. A matter he moved (`hand_over`, decision 78) stays with its new agent: the fold
  leaves it (`pinnedAssignmentsOf`); its old agent gets one notes turn in its own session (best effort, 10 minutes; the
  move commits without it), and a new holder whose first turn does not begin within 30 minutes, or ends unbegun, gets
  the move rolled back (the one exception to a first turn's not-started close), ending only an agent made for it; the
  new holder's first card is the open card it inherited, else its plan (`hasAsked` from the move). An agent changes a
  project's repo only on a card he approved, never writes its notes there, and never starts a session of its own to track a matter (his rulings of 20 Nov
  2026: the desk is the only dispatcher); a matter is its agent's to draft on (the Personal agent may draft to a
  project's work contacts until that project has its own agent). The night, the watcher and the connector never start one, and nothing recorded starts one directly: recorded content only makes a matter and its rank, and the hand-out's code picks from that. Life gives an agent a brief, the door and the send guard, and nothing else: what an agent may do
  is its runtime's permissions and his own rules, never Life's code but the send guard (what the desk sets: an agent of his own Life is held back by nothing but sending and writing as him through his Life connector (his decisions of 19 and 20 Nov 2026; the direction session's ruling under his word of 20 Nov 2026): its session is one of his own in full (his settings, instruction files, skills, connectors, and his login shell's environment, `readLoginEnv`, less the runtime's own engine keys), in the runtime's no-ask mode set at every start and resume (`Row.mode`; Codex's at spawn), and every permission ask that still arrives is approved, with one exception: Life's send guard (`desk/send-guard.ts`), a hook of the session's own flags run before each shell and MCP call, refuses a send outside a card's draft and his connector's writes (`CONNECTOR_WRITES`) on any server but its `desk` door (SECURITY.md lists what, and what gets past it), Codex's hook trusted by the hash his own Codex gives (`readCodexGuardTrust`), and no agent starts without it; and a second Life's agent (a demo, `isOwnLife` false), whose runtime as he set it up would reach his own Life, gets its door alone: none of his settings, MCP servers, built-in tools, instruction files or memory, only its door's asks approved (`Row.onlyDoorPrefix` and a bare tool name), every other refused, none of his environment, never in his Claude or Codex app, in its runtime row, `runtime-rows.ts`; Codex's in Life's own Codex home). The brief carries his one
  gate (nothing outward in his name without his yes on the exact thing, asked as a decision; the Mac and the web are
  free) and the door holds one rule of his (18 Nov 2026): an
  assignment's first turn asks its plan (a handed-out one's, its one card), so the door refuses `set_wait` and `finish` until it has asked a decision; but the caretaker's: his complaint's words are its plan, and every outward act still goes through a card on the exact content (his yes of 20 Nov 2026); and the Personal agent's own assignment once it holds his spoken ask: his words are its plan, the same way (his decision of 21 Nov 2026; `isHisWordsPlanOf`, `desk/first-turns.ts`). No agent that is not registered is started by
  Life; only the question cases' headless agent, by a developer's script (his word, 10 Nov 2026). A registered agent's state (its assignments, each with its subject, its wait and its notes file; its sessions, its
  turns) lives in the desk's store only (`desk.sqlite`), never in `memory/`; an assignment's notes are a file in his agents repo (`desk.agentsRepo`), the store holding its path. An assignment whose first turn never began (or not within its runtime's begin limit, its run then stopped) is closed, why in `why_not_started`, never retried; an agent ends when its last open assignment closes. On the connector an agent is known by its
  pairing (its grant's agent claim); at the desk's door a registered agent is known by the key the desk gave its
  session; never by what it says. Nothing in Life branches on an agent's name.
- **Life acts in one place: one to-do list backend per install** (Apple Reminders or Google Tasks, the `todoList`
  setting), through `changeTodoItem` alone (`scripts/imports.test.ts` checks), on his clear request or the auto-add permission. What a backend lacks is a capability (`can`),
  never a branch on its name. Asks are his
  words handed to the agent, never acted on by Life; the desk is the one agent built in (`DESK_AGENT`): it applies his
  asks of it that name a change (`after.agentChange`) in code and keeps its own list. Details: `docs/tasks.md`. The one other write, his request of 8 Nov
  2026: Life's own events in his calendar, the Past calendar and the appointments it reads from his messages (marked
  `(Life)`, free, until an agent confirms one with him (one he agreed in new lines is busy at once, his word of 21 Nov 2026); one he deletes is never written again), each at a place with its Google and Apple Maps links (`mapLinksOf`, his word of 21 Nov 2026). An appointment agreed in new lines is added within minutes (his word of 21 Nov 2026: `memory/arrival-appointments.ts`), the night taking over its id, with its source in the notes and a meeting link only as https copied exactly; never guests; one he deletes, in his calendar or by Remove (`change_appointment`, his token only), is never written again until his Undo; its first event pushes `calendar.added` with an opaque id only. They are its reading,
  never an action on anyone's words: nothing is sent, accepted or booked (`docs/tasks.md`, "Appointments"). The one
  other act is a card's draft, sent on his answer (below).
- **Life sends only a card's draft exactly as shown, on his answer to its outgoing option, into the one chat named
  (or a new 1:1 WhatsApp chat by its number), through its own bridges, Messages.app for iMessage, Gmail through gog for mail, or `gh` for an issue of a repo he listed in `githubRepos` (a comment, or a new issue with the subject as title; text only; his yes of 19 Nov 2026)** (his decision of 18 Nov 2026): a draft is
  text, or one file, or a reaction, with the message it replies or reacts to and the people it mentions
  (`memory/draft.ts`). Life resolves the chat when the card is asked (refused unless exactly one) and stamps what he
  sees: the chat's name, the message quoted, the file's real path, name, size and digest; the send reads only that
  stored line, and a file's bytes must hash to the digest or nothing goes (`not sent`). What a chat takes is read from
  its bridge's own room features (`com.beeper.room_features`, in the homeserver), never a table of Life's and never a
  branch on a network's name: a room with none takes text only, and a feature it can't take is refused when the card
  is asked and again before the send. iMessage has no bridge: Messages.app sends (text, or one file then its text as a
  second message; no reply, reaction or mention), and the send waits to see that message's row in chat.db. Mail has no chat: a card's `from` (one of his mail addresses that gog holds with Gmail), `to`, `cc`, `subject`, text and one file go through `gog gmail send` (`sources/gmail.ts`), a reply into the thread of the message `onMessage` names, found in `from`'s Gmail; never reply-all, a quote, a signature or tracking. It sends once, on his pick of that option alone through `answer_check` (his app's
  token: never a paired agent, a session's command or the desk; a session in his own app only once he approved the exact text in its chat), by `answerDecision` alone (`scripts/imports.test.ts`
  checks), never on silence, never with his words added, never retried by Life: after a `not sent:` outcome (nothing went) the card is open again and only his own new answer sends, never twice; after `may have gone:` it stays answered, never retried (his yes of 18 Nov 2026). His pick may be made on the card's notification, on his phone or his Watch: its Send button, under the whole draft as the notification's text, answers through the same `answer_check` with the phone or Watch unlocked (and after Face ID or his passcode at that tap when his setting asks for it, then on the phone only), and a card that asks who its recipient is has no such button (his answers of 19 and 20 Nov 2026). Nothing is sent when anyone wrote in the chat since the card was asked, or since his last attempt that went nowhere (his yes of 18 Nov 2026: he rereads, then answers again); when he wrote there himself, Life withdraws the card (his ask of 20 Nov 2026, life#731). One open draft per chat, and Life introduces the agents (his yes of 21 Nov 2026, `memory/draft-contest.ts`): the same asker's second card into a chat its own open card's draft names is refused, as is a card into a chat where one already waits; another asker's card waits on the open card (`contests`, never in his inbox), and the desk wakes the holder with `draft.contested`, facts only (the waiting card's id, its asker, the chat, until when); the holder reads it at its door (`read_card`, as data) and yields (withdraws its own: the waiting card is asked), merges (`merges`: one card for both, its own withdrawn, the waiting card's agent hearing its answer too) or keeps (`kept`, with its why: the waiting card waits until the held card settles; its agent hears `draft.kept`). Silent 10 minutes (`CONTEST_WAIT`), Life asks the waiting card with `replaces` ("replaces an older draft"); his Send of a card withdraws every other card into its chat first (`replacedBy`; their askers hear `decision.withdrawn`). No agent withdraws another's card; a send his answer started holds its chat, every contest in it waiting, until it ends. A file he approved leaves the Mac for its
  network (`SECURITY.md`). Agents hold no send tool, and his own Life's send guard refuses their own sends (`desk/send-guard.ts`). A session in his own app (his token) sends only this way too: it asks the card as `owner` and answers it by `answer_check` once he approved the exact text in that chat, never by typing in another app (his word of 19 Nov 2026). Its only other mail and notifications are to him
  (`docs/tasks.md`, "The only sends").
- **Nothing leaves the Mac but what SECURITY.md lists** ("What leaves the Mac"). Add nothing to that list without him.
- **The connector reads, forwards his corrections and fact-check answers, appends his words with `tell_life`, records a decision an agent or his own app requests (`request_decision`) and his answer to any check (`answer_check`, through each kind's own writer; his pick of a draft's outgoing option sends that draft; his Start on a new matter check asks the desk, as `change_registered_agent`'s start does), records his word about a registered agent as an ask of the desk (`change_registered_agent`), and his complaint ("Wrong…" on a card of Life's, `answer_check`'s `misread`) as one too, which the desk hands to the caretaker, acts only through `change_todo_item` and his word that a matter is done (`correct_memory` with `matter`, his token only: `correctMatter` ticks its to-do items through `changeTodoItem`; and his pick of a decision's option marked `ends`, which is his word that its step or matter is done, through `endByHisWord`) and his Remove or Undo of an appointment Life added to his calendar (`change_appointment`, his token only), and writes his `truth/` only through `change_directory_entry` (by his words) and its code (the new person or organization he names answering a check).** Never add a
  tool that sends or edits anything else. Its message poll, like the desk's, first hears a chat's voice notes that have
  no line (`hearVoiceNotes`: a line of `memory/files.jsonl`, Thai turns through Scribe once per note); that is Life
  reading what was said, not an act.
- **Life serves no page.** Only `/mcp`, its OAuth, the app's status reads behind the local key, and the desk's door,
  on loopback only, one key per registered agent. Never take the local key on the public port (`docs/architecture.md`, "Pages").
- **Life signs its own tokens; there is no other issuer.** `oauth.ts` is the one source of the issuer's address, the
  owner's subject; an app (ChatGPT, Claude) is approved by a pairing code from the Mac.
  lifelog signs nothing for Life (24 Oct 2026, its `docs/decisions.md`).
- **What the memory holds, in words, is `memoryLinesNow`** (`doubts.ts`): the fact checks he answers and the eval judge the
  same text. Which memory lines are doubtful (resting on a guessed person) is decided only by `guessedOf`, from what is stored, never stored itself; what
  he is asked about, only by `checksNow` (`checks.ts`), never drawn or stored: a doubtful line is asked through the guess
  behind it, one check for one guess, with no limit (his decision of 14 Nov 2026); a name Life cannot place is asked only while the person matters, he exchanged with them or it was seen on 3 days or more, never a description or a name he said not to name (`nameGroupsOf`, his word of 20 Nov 2026 reversing "no threshold" for names, life#724); a guess Life is sure of (`INFERRED_SURE_AT`) or that is an organization (`isSettledGuess`) is taken as true and never asked (his decisions of 20 Nov 2026; prompt `memory-episodes.v9`); what blocks him, only by `urgencyOf` (`check-urgency.ts`): his inbox holds every open ask, in the order `inboxOrderOf` gives; the badge counts what blocks; every new open card pushes once, whatever its kind, at the level his notification settings give its kind (`notifications`: off, quiet, normal or urgent; urgent is time-sensitive, for a card with a deadline only within 3 hours of it), applied by the Mac when it sends (his answers of 19 Nov 2026), with no words of his through Apple: his phone reads the card from the connector and writes the notification's text itself.
  His answer is the only thing written, with the check as shown (`fact-checks.jsonl`).
- **He is the center, not one more person:** his page and his situation are projections like everyone close's; his goals are only in
  `truth/me.md`; no separate record about him, no owner-only field on observations (`docs/architecture.md`).
- **Prompts and what they write name the owner, never a pronoun** (his words of 16 Nov 2026): a prompt says `{{owner}}`, which
  `promptText` fills with `readOwnerName` (`models/prompt-parts.ts`, from `truth/`), and states the rule first; never he, him, his,
  she, her or "the owner" for him (`prompt-parts.test.ts` checks). Memory is written in his `memoryLanguage` (`{{language}}`);
  quotes stay as said, topic tags English. A label digested with stored work (`him` in the persona and style inputs) changes
  with its prompt's next version.
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
- **Model calls go through the provider the owner chose**: his subscriptions, or with his keys allmodels.io (his decision
  of 28 Oct 2026) and OpenRouter, only on hosts it lists as keeping no data (his decision of 8 Nov 2026); never another provider. The bench uses the same providers, on a copy of the data; the question cases' agent runs on his Codex subscription, reading his own data through the connector
  (`docs/operations.md`, "Model engines"). One model runs on the Mac instead of a provider: photo descriptions, Qwen3.5-9B
  under llama.cpp (`models/describer.ts`), his decision of 11 Nov 2026. The image never leaves the Mac; the description
  then reaches his provider inside the photo lines like the rest of the line. A second: the arrival reader's trigger,
  Apple's on-device model (Foundation Models, `SystemLanguageModel.default`, never Private Cloud Compute) through the
  app's helper (`models/foundation-model.ts`), his decision of 20 Nov 2026; its yes (to an ask, or to a meeting, his yes of 21 Nov 2026), a refusal or Thai text goes to
  his engine.
- **Dependencies point one way** between `apps/server/src`'s layers (core ← records ← models, sources, todo-list, payments ←
  memory ← personal ← host ← desk; `docs/architecture.md`, "The code"): nothing imports the desk, whose
  `life-entry.ts` is the command line's entry. Fallow's boundary zones (`.fallowrc.json`) and
  `scripts/imports.test.ts` fail the check on any import against them; never suppress one, move the code instead.
- **Settings are one strict file, read once per process** (`apps/server/src/core/settings.ts`). A part left out is off (one exception: a kind left out of `notifications` takes Life's level for it, `NOTIFY_DEFAULTS`); a new key lands
  in code first. Core steps have no switch; the only feature switches are the personal add-ons (`core/add-ons.ts`), beside the outputs (`core/outputs.ts`) and the voice naming's two flags; owner values are never defaults in code. Likewise **a new key in `truth/` lands in code first**: the
  schemas are `.strict()`, and a key the running code doesn't know stops the watcher, the nightly and the connector.
- **The actions backend is an interface, never the truth; the ledger is.** Changes read back from it can take authority
  away or reorder, never add it. What is open is derived (`matterOf`), never stored (`docs/tasks.md`).
- **Nightly emails include every row.** Never cap a list or write "+N more"; the one kind left out on purpose is the ending check, never asked in the email (his word of 16 Nov 2026: "is this done?" is load) (`docs/operations.md`, "The nightly
  report").
- **Everything Life shows follows Life's own brand** (`docs/brand.md`): one source, `assets/brand/tokens.css`, which
  wins over any global brand skill for Life. A brand change lands there first; the email and the app copy it
  (`scripts/brand.test.ts` checks).

## Names

A name is a decision about what a thing is. Before naming or renaming anything, say in one sentence what it is and
what it is not, then find its name in `docs/glossary.md` (its Word column is what the code uses today): one name per
concept, the same in docs, app, email, connector and code. A new concept gets its glossary line in the same PR.

- The most descriptive name that makes sense, for the concept and for someone who has never read the code: reading
  it, they know what we are talking about (the connector's `read_registered_agents`, not `agents`). Longer and clear beats
  short and vague.
- Names never clash: one concept has one name, and one name means one concept. Two names may share a plain word
  (`matter step`, `night step`): qualify the word by what it belongs to, never pick a weaker word to avoid sharing
  one.
- New and renamed functions: `readX` reads disk or the network, `parseX` turns text into a value, `xOf` is pure, `latest` is the most
  recent of a set, booleans start with `is` or `has`.
- Files: a file names what it does, and no two of the server's files share a name (a capability's `contract.ts` and `backend.ts` aside; `scripts/imports.test.ts` checks).
- No person's name in code, stored values or ids: name the role, `owner` or `agent`.
- A clearer name for something stored is worth its backfill (the invariant above).

## One way to do each thing

Before adding a helper, use the one that exists:

| Need | Use |
|---|---|
| What running things of his life exist and what belongs to each | the matters (`memory/matters.ts`): `mattersNow` over `readMatters`; steps are units, observations and to-do item keys, never episodes; found by the matters step only; a unit's facts a matters call was shown and left out never join it |
| Which matter some refs name (an agent's anchors, a direction's pinned steps, a matter or step id he gives) | `matterOfSteps`, or `matterFinderOf` for many lookups (`memory/matter-read.ts`): the matter holding the most of the refs (as its id or its steps; a unit can be a step of several), on a tie the matter it was given (`prefer`: a pin's `matter`, an assignment's `matter_id`), then the one with the fewest steps |
| A matter's goal and next step | its `goal` and `nextStep` (`directionsOf`, set by `matterBookOf`): his `matter-direction` correction over Life's drafts (`memory/matter-directions.jsonl`), pinned to steps; a Life draft is a next step or, when the matter looks over, `endingRecords` and none; due again by `isDirectionDue` (`directionDueOf`: the one test of "checked", for the night and the card); `nextStepNow` adds `wait_decision` when read |
| What the desk gives an agent by itself, and how fast | `handOutOf` and `paceRefusalOf` (`desk/hand-out.ts`) over `readHandOutMatters` and `handOutGateOf` (`memory/read-matters.ts`: the one gate, for the new matter check too), run by `handOutNext` (`desk/hand-out-tick.ts`), paced by the agents' cards he is shown (`openChecksNow`); it opens an assignment (`openAssignment`, `opened_by` `desk`, the one fact of who opened an assignment) on the agent that takes the matter, and starts no agent |
| Which agent a matter goes to (his Start, the hand-out, the fold) | `agentForOf` (`memory/held-matters.ts`) over host's `standingAgents`, by the project the matter shows under (`projectOf`, his `matter-project` first: `agentForMatterOf`, `memory/read-matters.ts`); the fold is `foldAssignments` (`desk/matter-net.ts`) over `moveAssignment` (`desk/desk-store.ts`, which shares the one ending rule with `closeAssignmentRow`); never a second test |
| Whether an agent holds a matter (the hand-out, the new matter check) | `isHeldOf` (`memory/held-matters.ts`) over host's `heldByAgents` facts: active or stopped holds; ended holds until the matter has a step newer than its end (`steps.at(-1).at`); ended as over (`MATTER_OVER_OUTCOME`), or asked and never begun, holds nothing; only agents active, stopped or ended in the last `HOLD_DAYS` (90) are read, and the inbox keys on `heldStampOf`, never the list; a project's agent holds only what is assigned to it; never a second rule |
| When the desk closes an assignment on its matter | `endOutcomeOf` (`desk/matter-net.ts`): `done` closes any; not running (probably done, dormant, closed) only a handed-out one; an agent ends only when its last open assignment closes or leaves, so a standing agent outlives its matters; steps no matter holds count once all ended (`endedStepsOf`); the one rule: an `ends` answer may wake its asker for one turn before it is ended here |
| Whether a matter is marked important | `MatterView.important`, read once by `importantIdsOf` (`memory/matter-pins.ts`) over his `matter-important` corrections (pinned to steps, the latest wins; his token only, by the matter's id, `correctMatter`), and only while open; it ranks with his urgent flag (`rankedItems`), comes first in `rankedMattersOf` and in its inbox tier (`inboxOrderOf`), and keeps an open matter running (`isRunning`); never a second test |
| Which project a matter is of | `MatterView.projects`: his `matter-project` (pinned to steps, the latest wins, his token only, by the matter's id, `correctMatter`) is its one project when given (`matterBookOf`), else the stored line's and its observations'; it shows under `projectOf` |
| A matter's icon | `MatterRow.icon` by `iconNow`: his `matter-icon` (pinned to steps, the latest wins, null gives it back, his token only, `chosenIconsOf`) over Life's nearest line (`readLifeIcons`, `memory/matter-icons.ts`, the Mac's embedder, nothing stored, only on the connector's reads); the phone falls to the first area's icon, then the folder; never a second picker |
| Whether something is open, where it stands, who it is owed to or waited on, its newest open step | `matterOf` / `matterBookOf` (`memory/matter-read.ts`), the one rule: open while any to-do, promise, wait or to-do item has no ending (one with none of them, until 7 days past its last step and date); matter status `done`, `probably_done`, `waiting_on_someone`, `moving`, `stuck`, `dormant`; a step's ending is its `ending` (retired, ticked, or a link); a lone open observation or to-do item is a matter of one. Readers (`dueOf`, `read_matters`, `read_matter`, the links step) go through `readMatterBook`; never a second test of "open" |
| A matter row with `blockingChecks` and `needsYou` (`read_matters`, `read_matter`, the desk's count, a person's read) | `matterRowsNowOf` (`host/matter-rows.ts`) over his open checks read once (`readMatterRowsNow` reads both); never a second composition of `needsYouOf` |
| Where an observation stands (hidden, gone, replaced, retired) | `observationStatusOf` (`memory-files.ts`): index, pages and status reads alike |
| What is new since a night | `newSince` (a source line first cited) |
| Who has a page / who is close personally | `pagedNow`, `personallyClose` (`closeness.ts`); never a list |
| What someone is like, what repeats between them and him | their persona (`personal/personas.ts`, `readPersona`); psychology lives there only, pages stay facts |
| How each writes to the other (for drafting) | their communication style (`memory/communication-styles.ts`, `readCommunicationStyle`): core, one call per person with a page, shown in the person read's `now` and, by `communicationStylesOf`, wherever a draft starts: a matter's read (its people he knows), a project agent's packet, `read_chats` with one `who` (his word of 20 Nov 2026, life#471); the persona's `writes` lines are not shown |
| Comparing a person's or a project's name when read | `nameKey` (`memory/units.ts`), never stored; stored text and ids: `normalize` |
| Who a name, handle or ref is | `memory/who.ts` (`readPeople`; `meant` for `read_people_and_organizations` and `read_chats`): his word, `truth/`, the people his Contacts name (`memory/contact-people.ts`, `people-contacts.jsonl`, appended by the night, never read from Contacts at read time; a card folds into someone in `truth/` by their whole name, a shared handle, or their first name and birthday), then Life's guesses (the reading, before folds: `memory/name-reading.ts` `readingOf`); a phone or an email meets by its contact key only when its kind is known: where it was read (`HandleFrom`: a Contacts field, or a source with `hasPhoneHandles`), else written as one (`writtenContactKeyOf`: an address, a `+` number), so a network's id never meets a phone's digits; a WhatsApp `@lid` reads as the phone its bridge maps it to (`readLidPhones`, `sources/whatsapp.ts`; read time only, the stored sender stays as read); pass `from` wherever the source is at hand; one person across every channel is `foldsOf`'s to say; a lifelog person id is `voicePersonOf`: the id, else the name lifelog gave it (`readVoiceNames`, indexed per id or name, never a scan); the id a voice answer assigns is `voiceIdOf` |
| A person's details (birthday, home, work, family, handles) and their birthday | `detailsOf` (`memory/details.ts`): his directory, then Contacts, one birthday; read by `readDetailsOf`. Only what is already a field; anything else about someone is a page line |
| A card's parts beyond its question (what he needs in hand, how Life sees it done, a plan card's steps) and their rules | `memory/needs.ts`, the one registry of need kinds (shape, `line` worked out when read by `needLineOf`, never stored, its page); `memory/card-request.ts`: the card's shape (`Ask`), the short `CARD` and each part's page, opened by `fetch("ask/<name>")`; `memory/card-problems.ts` refuses what breaks them, what is not built yet included; its `context` is required Markdown with `life:<ref>` links (decision 81, his yes of 21 Nov 2026): one ref grammar for `fetch`, the links and their kinds on the wire (`parseRef`, `memory/refs.ts`), each kind found by its reader (`findRef`, `memory/find-refs.ts`), a dead link refused when asked; the tool's arguments are loose where the contract grows (`DecisionRequest`, derived from `Ask`), so a new kind never changes them |
| Whether a card's step is seen done (the payment its `amount` need names) | `host/done-seen.ts`: one `EventFilter` from the card's needs (`doneSeenFilterOf`: money out of that amount in its currency, `<currency>_out`), paid in that currency, to its payee: each of `payeeWordsOf` a whole word of the bank's name of the payee (`isToPayee`, `ChannelEvent.payee`) tested by `matcherOf` over the payments channel, booked on or after the card's day (`isOnOrAfter`, the desk's wakes' test too), one read for many cards (`readSeenDone`); his `looks` answer (`lookForDone`, `answer_check` only) and the watcher's minute (`lookForPaymentsDone`, every 5 minutes while one is open, `seen` only); the outcome is the card's `done-seen` line (`recordDoneSeen`), never his answer; never a second matcher |
| Whether new chat, mail or voice lines hold something for him to act on (his own commitments included), as they arrive | the arrival reader (`memory/arrival-reader.ts`, the watcher only, today's units and yesterday's voice): the gate's code rules for chat and mail (`arrivalsDue`, exact message keys), for voice, while it is a source he turned on, a conversation lifelog closed that he spoke in on any of its days (`readableVoiceOf`, the one test for fresh reads and pending confirms); every unread line in chunks (`chunksOf`), all read in one pass; Apple's trigger, his engine's confirm (and its appointment read, `arrivalAppointmentsOf`); what counts is `confirmedArrivalsOf` (`memory/read-replies.ts`), read by extraction's choice of units (`toExtract`: kept whatever its verdict) and the desk's `pollArrivals`, which wakes one agent (`matterOrPersonalOf`: a matter's agent by the people who wrote the lines, else Personal, registered by the desk when none stands; a message already queued for any agent, as a waiting agent's `message.received`, is never queued again); never a second rule |
| A question an agent puts to him, and where it stands | the decisions (`memory/decisions.ts`): `requestDecision`, `answerDecision`, `decisionsNow` (open, answered, lapsed, withdrawn, worked out when read); he sees the open ones as checks (`checksNow`, kind `decision`), never a second list |
| Which matters hold a step of his, and the card that asks it | `yourMoveOf` (`memory/your-move.ts`: his open to-do, promise or to-do item due first, else the newest) and `yourMovesOf` (no open decision on it, project not parked, no agent's open assignment holds it or its agent waits on him), the your move card in `checksNow`, dormant matters too, once its new matter offer (`newMatterOffersOf`) ends; his Not now is `your-move-not-now` (`readMatterPins`' `notNow`); never a second list |
| Every open check, as a reader sees it (the inbox, an answer, the nightly, the CLI, `read_matter`, the push, the status's `left`) | host's `openChecksNow` (`host/inbox.ts`): `checksNow` over the steps an agent is anchored on now (from the desk's store, which memory cannot read); `openCheckOf` for one |
| Whether a check blocks him or only improves (`blocks`, `improves`), the inbox's order and the badge | `inboxRankOf`, `urgencyOf`, `inboxOrderOf`, `blockingCountOf` (`memory/check-urgency.ts`): one rule over the check; `checksOf` orders by it, `inboxOf` and the push count with it |
| The checks about one matter | `checksOnMatterOf` (`memory/checks.ts`), over the matter ids each check rides on (`ridesOn.matterIds`) and the matter holding its subject; `read_matter`'s `checks` |
| A push for a new card; a card's id through Apple | `pushNewCards` (`host/card-push.ts`), run by the watcher's minute (`pushNewCardsIfChanged`), never `checksNow`'s full read on every tick: its key decides; a card's id is its `pushId` (`pushIdOf`, `sources/lifelog-push.ts`; an appointment's too), never its ref; its kind and level are `notifyKindOf` and `levelOf`, the one mapping and the one rule; while a run holds the memory lock only new decisions push, from `decisionsNow` |
| Whether the inbox must be read again | `checksNow`'s key (`checksKeyOf`, `memory/checks.ts`): a change stamp of every file the checks read (`CHECKS_READ`, `readChangeStamp`: stats only; never units, which the watcher writes every few minutes), his day, the open decisions, the anchored steps, the voices lifelog queues (the last list read, `readNamingQueue`, refreshed behind each read: the inbox never waits on lifelog once it has one; an answer checks against `readNamingQueueNow`, never a kept list, in its turn: one voice answer at a time per process, `voiceTurn` in `answer-check.ts`); the same key, the same list for every reader; never a key of a reader's own |
| A send's steps (`chat_checked`, `handed`, `confirmed`) | `sendStepsOf` (`memory/draft-send.ts`) lists them for the progress plan; the send reports through the same `STEP` names and `isChat`, never a `kind` or a literal elsewhere |
| What was written in a draft's chat since its card (the send's refusal, the withdrawal when he answered himself) | `wroteSince` (`memory/draft-send.ts`), from `sinceOf` (`memory/decisions.ts`: his last attempt that went nowhere, else the card); one read per channel |
| A card's draft (its shape, rules and words) | `memory/draft.ts`: `MessageDraft` (the agent's), `StoredDraft` (with Life's stamps), `draftProblemOf`, `isSendable` (the one check that a stored draft can be sent), `draftWords` |
| Sending a card's draft (which chat it names, the send) | `memory/draft-send.ts`: `resolveDraft` when asked, `sendDraft` on his answer, through the source's send path (`Descriptor.send`, `sources/contract.ts`); iMessage's is `messagesAppSend` (`sources/messages-app.ts`: Messages.app told by osascript with argv only, confirmed by the sent row in chat.db, the one place that names the app); the Matrix one is `matrixSend` (`sources/matrix.ts`), the one Matrix send: its options are the network's own mappings (the defaults are a bridged network's), what a room takes is `roomFeaturesOf` read by `featureProblemOf` (`sources/matrix-content.ts`), which also builds the event; it opens a new 1:1 chat by its handle. A bridge's ghost is `ghostOf` |
| Whether a source was captured on a day (never "quiet" by default) | `readCoverage` (`memory/coverage.ts`): captured, not seen or unknown, for the sources that capture on their own (`capturesOnItsOwn`), from the units held, what each publication read (`memory/publications.jsonl`) and, for the pendant, the recorded days (`memory/recorded-days.ts`, the night's copy of lifelog's `GET /recorded`: no read asks lifelog); over a range of days, a day being a range of one; by month, `notCapturedOf` |
| What he and a person exchanged, counted (who opens, who answers how fast, messages and deletions each way) | the exchange counts (`memory/exchange-counts.ts`): `exchangeCountsOf` then `pairCountsOf` over any span; `readExchangeCounts` for all years as of last night. Counted from the sources into Life's state, never stored in `memory/` |
| How an open thing ended (a promise kept, a wait answered) | its link (`memory/links.ts`): `endingsOf` (`memory/endings.ts`) is the one place that decides what a link ends, `endingsRead` the one thing readers call; a link ends its step "probably" in the readers and asks him (an ending check among the checks, with no limit, except when the link rests on his own later words (`speaker` is `OWNER`): then no card, worked out when read, the step stays probably done; right is his `outdated` word, wrong removes that link for good and reopens the step); its subject is the matter, never a person |
| A person's past months with him, and their story | their history (`personal/histories.ts`, `readHistory`): a closed month read once from their one-to-one exchanges and the summaries of their conversations in person (`heardPersonOf`), in time order, again only when what it was shown changes; the present month is the situation's. Off until the `histories` add-on |
| Whose a 1:1 chat or mail thread is | `directChats` (`closeness.ts`), over the night's one read of chats and mail (`readWithPeople`) |
| Whether a ref is an organization, someone he knows, or only a guess | `isOrganization`, `isKnownToHim`, `isGuess` on `readPeople` (`memory/ref-kinds.ts`): an organization is one of `truth/organizations.yaml`, else its latest inferred record's flag, else a closeness service his `closeness` word does not cover; personal steps (closeness levels, pages, personas, styles, histories, voice candidates) skip it. People and organizations share one id space (`person:<id>`); readers that name anyone in his directory read `directoryPartiesOf(truth)` |
| Who a person ref is now (one folded into another) | `readPeople().canon` (`foldsOf`): his `same-person` over what each inferred id's name or handle reads as now (`readingOf`: his word, truth/, then the latest confident guess or the person it links to); readers take it from `readPeople`, never rebuild it |
| Someone as an app is shown them (ref, name, kind, line, picture) | `partyOf` on `readPeople` (`memory/party.ts`): every person or organization on the wire is a `Party`; a name Life could not place is a party with an `unknown:` ref and no page; a picture's bytes are `read_person_pictures` (`host/http/mcp-people.ts`), for his apps only |
| The unresolved names that are people | `readUnresolvedPeople` (`memory/who.ts`): `unresolved.jsonl` less the name opening an agent's own report; never `readUnresolved` directly |
| Who wrote a message | `speakerOf` (`units.ts`); units keep people unresolved, readers map them with `unitNow` |
| A local day or time | `localDate`, `dayStart`, `time`, `localTime`, `dayRange` (`zones.ts`); a calendar day's arithmetic, no zone: `daysBefore` (`core/clock.ts`); in the zone he was in (`zoneAt`), never the process's zone; the present (his day now) is `dayNow`, `zoneNow` |
| A log line (Life's, Voice's) | `log` (`core/log.ts`, the day file) and Voice's `record` (stdout), both through `logWriter` (`core/log-line.ts`, LogTape): `time`, `level`, `category`, `msg` (a template of code's own fields), then metadata; content-named fields dropped by LogTape's redaction; an error by `errorOf` (a model's by its type, `fromModel`; Life's own by its first line, which leaves the Mac only to him: his status read's `lastError` and his failure mails) |
| Now | `clock()` (`apps/server/src/core/clock.ts`), never `new Date()` or `Date.now()`, lifelog included; a duration is `performance.now()` |
| An event's key across sources | `eventKey` (`records/source.ts`), never an inline `source|id`; a chat's key is `chatGroups`' |
| An importance threshold | `SEARCHABLE_AT`, `KEEP_AT`, `TOP_AT` (`records/unit.ts`), never a bare number |
| A duration, an instant as the ledgers write it | `MIN`, `HOUR`, `DAY`, `iso` (`apps/server/src/core/clock.ts`) |
| A capability's types | its `contract.ts` (`sources/`, `todo-list/`, `payments/`): implementations import it, its registry imports them, never back |
| A source's behaviour | its descriptor in `SOURCES` (`apps/server/src/memory/sources.ts`); branch on kind or capability, never on its name; tables of sources come from `tablesOf` |
| Units for a memory step | `gather` (`gather.ts`), once per processing run |
| Today's units, before its night | the watcher: `syncLifelogUnits` for voice, `publishTodayUnits` over `gather` every 5 min for the rest; a file of today's messages is described once on arrival (`describeFilesOnArrival`, at most `FILES_ON_ARRIVAL_A_DAY`), and today's chat and mail, and the closed voice conversations he spoke in, are read by the arrival reader (`readArrivals`, at most `CONFIRMS_A_DAY` (1,000) confirms, a runaway guard: a read past it is the night's; his yes of 20 Nov 2026): the only two daytime model steps; no episodes or facts until the night rewrites the day (his decision, 11 Nov 2026: no midday runs) |
| An activity day's unit (device-day, measurement-day) | `activityDay` over its text (`memory/activity-days.ts`) |
| A unit's words | `words.ts` (`voiceLines`, `chatLines`, `unitLines`); a failed fetch throws |
| A message's files as lines | `showFiles` (`memory/message-files.ts`); readers resolve to `SourceFile`; `describeFiles` reads each once, a voice note by lifelog's speech pipeline (`hearVoiceNotes` alone for the event reader and the backfill `memory hear-voice-notes`) |
| Reading a JSONL file | an append-only one (the ledger, verdicts, files, told-life): `readAppended` (`core/files.ts`), which parses only new lines and returns a result callers never mutate, its lines from a line `readLines`; rewritten only whole, by `writeWhole`; one code rewrites: `rowsOf` |
| Where a sitting of talk ends in a stream of messages (one chat, or one person's across channels) | `exchangesOf` with its quiet, `EXCHANGE_ENDS_AFTER` (6 hours, `memory/exchanges.ts`), `batchesOf` for what one call reads of them and `isTwoWay` for the chats worth reading; a batch as lines a reply can cite: `batchLines` (`exchanges.ts`); search's passages keep their own cut. The persona's prompt says "6 hours" in words: a new quiet is a prompt version, so ask first. Speech is cut at `CONVERSATION_ENDS_AFTER` (5 minutes, `core/quiet.ts`), by lifelog's grouping and by `exchangesOf(turns, CONVERSATION_ENDS_AFTER)` alike |
| A subject's read, cut into parts that end with their next reads (a person's `now`, `page`, `persona`, `story`, `year`, `month`, `evidence`, `latest`) | `person()` (`memory/read-person-page.ts`) builds every part over the one ref grammar, `PART_CHARS` and `nextReads` (`memory/read-part.ts`); `now` and `latest` as data (`personNowOf`, `readLatest`, `memory/person-now.ts`), `now`'s `knows` made from its next reads; `fetch` and the CLI open a ref through `openById`. Never a second reader beside `person()`; a person only heard has no ref, so no parts |
| The people and organizations, listed (the People tab, `read_people_and_organizations` with no name) | `peopleListOf` over `rowOf` (`memory/person-now.ts`): his directory's people and organizations and everyone with a page, by `closerOf`'s level in `ClosenessLevel`'s order, the unjudged last, the newest exchange first; `needsYou` from their matter rows; never a second order |
| A person's units (their chats, mail, recordings), newest first | `readPersonUnits` (`memory/person-units.ts`): one index query, whole days, `before` a day; the network identity, `latest`, reach and `read_chats` with `who` read through it; never a scan of every chat |
| How to reach someone, per app | `reachOf` (`memory/reach.ts`) over his directory's handles, their Contacts cards (`readCardsOf`; labels read live on `Contact`) and their own 1:1 chats (`readSeenAccounts`); a link is the source's `chatLinkOf` (a call's `tel:`); details leave out what reach opens |
| Messages by chat | `chatGroups` (`records/source.ts`) |
| Whether a kept result is still what a call would be asked | `inputsOf` (`memory/run.ts`): one digest of the prompt and the input. For an exchange's read: `replyOf` (`memory/read-replies.ts`), which matches the prompt's versioned name and the exchange's messages, never the text's digest |
| A spoken conversation, and its parts and summary | `spokenConversationsOf`, `spokenPartsOf` (`memory/spoken-conversations.ts`) cut over `exchangesOf`, `turnLines`; the summary is a fourth read in `read-replies/`, asked by `conversationSummaries` and shown through `currentSummaries` / `conversationSummaryPart` (`memory/conversation-summaries.ts`); never a second cutter, batcher or writer |
| Which conversation summaries show, and which a night must ask again | `currentSummaries` (the newest line for each turn whose keys are all still its turns' keys in lifelog's store; `summaryOfKeys` is the one choice for showing and for asking, so a voice renamed and renamed back shows its first line again) |
| Who an unnamed voice may be, and what the model is shown to guess it | `voiceNaming` (`memory/voice-naming.ts`) over `overlappingPhoneCallsOf`, `possibleSpeakersOf` and `namingBriefOf` (`memory/naming-context.ts`); a turn nobody named is kept under `unnamedTurnKey` (`memory/units.ts`) and numbered `V1`, `V2`… by `voiceTokensOf` (`memory/units.ts`), the summary's too; a guess is stored in `read-replies/` and acts on nothing; a stored guess is read by `voiceGuessesNow` and shown only by `withGuessesShown` in `fetch`'s display, never on a speaker, and as a voice card's question by `withVoiceGuesses` and `voiceSuggestionOf` (`memory/who.ts`: the one person lifelog's suggestion and the group's sure or likely guesses agree on, known to lifelog by an id; the guesses read from the months of the queue's recordings only) (`memory/voice-guesses.ts`); his answers are scored by `scripts/voice-naming-score.ts`; lifelog's voices are read by `readVoices` (`sources/lifelog-voices.ts`) |
| What a read of an exchange answered (stored, pending, counted) | `replyOf`, `readReplies`, `storeReply` (`memory/read-replies.ts`): the only code that appends the replies (`memory/read-replies/`) and reads them (the exchange reads' calls are built by `callOf`, `memory/exchange-reads.ts`); the pilot passes a trial folder |
| An exchange's end | `isFinished` (`memory/exchanges.ts`): nothing written for `EXCHANGE_ENDS_AFTER`; only a finished exchange is read |
| The newest of a night's work within a call cap | `newestWithin` (`core/lists.ts`) |
| The one-to-one messages of people named on a command line | `directOf` (`closeness.ts`) |
| A reply checked for the points it must hold and must not say | `judge` then `tally` (`memory/tally.ts`): the points as true and false facts, the reply as the one memory line; a misgrade becomes a judge case |
| Packing items into calls by size | `packed` (`core/lists.ts`): in order, an item never split; a step passes its own size |
| Tokens from characters | `CHARS_PER_TOKEN` (`models/llm.ts`), a low bound: a count made with it is a ceiling |
| A text's vector for search by meaning (model, prompts, dimensions, the key it is kept under) | `apps/server/src/core/embedder.ts`, lifelog's search and Life's alike |
| Merging two rankings (by meaning, by words) | `fuse` (`apps/server/src/core/fusion.ts`) |
| A memory text's vector, the query's | `memory/vectors.ts` (`embedQuery`, `readNearest`; the watcher's `embedNew`); Life reaches Lifelog Host's embedder at `EMBEDDER_URL` (loopback, one constant for lifelog and Life), the one call into lifelog's side that is not its REST contract |
| Running gog (Google Calendar, Google Tasks, Gmail send) | `gogCall` (`core/gog.ts`): nothing else spawns it |
| Running gh (GitHub issues: the `github` source's copy and send; the GitHub activity a wait names) | `sources/github.ts`: nothing else spawns it; the copy and the send ask only the repos in `githubRepos`, the activity reader (`githubActivityReader`) only the repos the open waits name |
| Running another program | `apps/server/src/core/proc.ts` |
| Calls that must not overlap within one process (a file's writer, the appointments sync, voice answers) | `oneAtATime` (`core/lock.ts`), one chain per resource; across processes, the locks |
| His login shell's environment | `readLoginEnv` (`core/proc.ts`): only an own-Life runtime row; never logged or stored |
| Opening a SQLite store to write (WAL, the wait first) | `openWritable` (`apps/server/src/core/sqlite.ts`), with its wait (5 s, 30 s for the index, vectors, passages and photo descriptions) |
| Opening a SQLite store to read (an app's store, the archive, the index) | `openReadOnly` (`apps/server/src/core/sqlite.ts`), which waits for a writer |
| A path written with `/` (an export's manifest, git, tests) | `slashed` (`apps/server/src/core/platform.ts`); the checkout's files: `repoFiles` (`apps/server/src/core/proc.ts`) |
| A messaging network on a bridge | its entry in `NETWORKS` (`sources/networks.ts`); WhatsApp's is `readByItsApp`: read from the Mac app, its bridge only sends and opens chats, and `bun life bridge` leaves the `whatsapp` setting alone; a room on Life's homeserver is `readHomeserverRooms` (`sources/matrix.ts`), never a guess from an id's suffix; the others are copied by their bridge once he has linked it (it holds a login: `isBridgeLinked`), else from Beeper Desktop's store while Beeper holds the network, so no gap opens before he links (`copierOf`; his decision of 18 Nov 2026 moves LINE, which allows one session, onto Life's own bridge, replacing his word of 6 Nov to keep it in Beeper). The bridge's first copy pass after Beeper appends one `cutover` row after Beeper's newest message (`cutOverFromBeeper`), and `asReadOf` hides the bridge's rows about a time before a cutover, written after it: the archive is only appended to, Beeper's rows stay as they are; set up, linked and removed only by `bun life bridge` (`host/bridges.ts`): a bridge is added when its folder holds its config; the homeserver and every bridge run in one launchd job, `bridges` (`RUN_BRIDGES`, restarted on every change and once a day, `healBridges`), outside Life.app (the homeserver holds deleted messages until the archive copies them) |
| A phone call (including Phone & FaceTime) | an event of its chat, including call-only chats with `phoneCall` (`SourceEvent`), shown by `callLine` (`units.ts`); never a second record. Who he talked with on it is the model's reading of the call line and how voices were heard (`heardAs`), never a timing rule; that it ended with its words in is the desk event `call.ended` (`readEndedCalls`, `host/events.ts`); its exact span is `callSpanOf` (`units.ts`), and a read of its recording is cut to it by `fetch`'s `at` and `until` alone: the turns that overlap it (`OVERLAPS`, `sources/lifelog.ts`, the desk's `recordingsOf` too), a turn crossing an edge kept to its words wholly inside by lifelog's word timings, none without them (life#875) |
| A Matrix-shaped chat archive (a bridged network's: `line.sqlite`, `instagram.sqlite`, `messenger.sqlite`, `linkedin.sqlite`, `telegram.sqlite`) | `matrixArchive` and `LATEST_VERSIONS` (`sources/archived.ts`); a bridged network is `bridgedSource` (`sources/bridged.ts`) |
| Bringing in an export of his (an assistant's, Instagram's) | `bun life import <folder> [--dry]`, the one verb; Instagram's goes into its archive as export rows (`copyInstagramExport`, `sources/instagram-export.ts`), read by `readBridged` like any message (`asReadOf`) |
| Whether Life is online (worth a run or an alert) | `isOnline` (`models/llm.ts`): his model provider answers; an offline tick runs nothing |
| Whether a source is healthy | its `missing()` then its `newest()` (the snapshot's source card), never a second check |
| His answer with its proof (what was written, what a send did, whether the asker was told) | `answerWithResult` (`apps/server/src/host/answer-result.ts`): composes what each store already says, stores nothing; a tool's live steps are `report` (`host/http/mcp-tool.ts`), never a second tool; it returns at the proof (the answer line, the send's outcome) with no wait for the asker or the inbox; a repeat of an answered decision's same answer, under any key, gets its first result and sends nothing, another answer is refused |
| His complaint ("Wrong…") and its proof (`reached: "caretaker"`) | `complain` (`host/complaints.ts`): only a "Wrong…" Life showed (`isSealed`: the card's ref, cause and digest as shown, sealed on its final read, `withMisreadSealed`), one ask of the desk per press key; then the desk writes its complaint record row and its receipt (`complaintReceiptOf`: its event row on a caretaker's assignment, looked for across every caretaker it had, so a received complaint is never received again); only then `reached`. A retry under the key resumes it, its seal checked again; the key with other words, card or tick is refused. Received by `receiveComplaints` (`desk/complaint-intake.ts`) before the hand-out each tick, the one writer of the complaint record, for the pending complaints only (so a crash after the ask is recovered on the next tick; a record it cannot write holds them, and the tick goes on); after a caretaker whose first turn never began, none is registered again until a press newer than its end, anywhere in the ledger (`roleStartBlockOf`); an assignment that closes gives back what it never handed (`closeAssignmentRow`), received again; what the caretaker holds is `complaintsAtWork`, which makes a card's `beingFixed` (`withComplaintFields`), never stored, its line and context the caretaker's newest open card on that assignment (`beingFixedOf`, by `cardOwnersOf`, over the decisions the inbox reads; only for a complaint alone on its assignment); its visibility is `isComplaint`'s one rule |
| His payments | `payments()` (`apps/server/src/payments/backend.ts`): nothing else calls `money` |
| His Reminders or Google Tasks | the backend (`backend()`, `apps/server/src/todo-list/backend.ts`): nothing else calls remctl or `gog tasks` |
| The lifelog store / the search index | `withStore` / `readIndex` (synchronous); `buildIndex` (one WAL transaction, `writeIndex`) via `reindex`, or `reindexUnits` for units rewritten in place (only while no unit went or was dropped or taken back by a code rule) |
| What an agent can wait for | `events.ts` (MCP's Events extension, by poll): computed from each source's `incoming` when polled; Life stores nothing for it, the agent keeps its cursor; a payment, an arrival at a place or a GitHub repo's activity: `EVENT_CHANNELS` (`host/event-channels.ts`), read over its look-back on its beat (given the open filters that name it), once per agent, the desk only; one matcher for every event (`matcherOf` over `Matchable`) |
| A registered agent's wait, turns and queued events | the desk's store, the one state, written only by the desk (`desk/`; its schema in `desk-store.ts`, which of its store steps it still needs in `host/desk-shape.ts`) and read only through host's desk reads, `host/desk-read.ts`, its part for an agent as read, `host/agents-now.ts`, its turns for spending, `host/desk-turn-reads.ts`, and its part for a move, `host/move-read.ts` (who holds a matter, a move's phase, which cards count as asked: `countsAsAskedOf`) (the desk's own reads too; host's read-only, `readDesk`, never throws); a card's holder is `cardOwnersOf`'s (its assignment's agent, whoever asked it), in the inbox and an agent's read alike; one due rule, `dueOf` (`desk-clock.ts`); a turn ends by its own id (`desk/turn-ends.ts`); what his agents are doing is `readRegisteredAgents`: the wait contract's rules are `agent-wait.ts`'s, pure; one tick applies them (`desk-clock.ts`), and an agent's door calls are `agent-actions.ts`, served by `desk-door.ts`. A runtime is its `desk/runtimes/contract.ts`, implemented once (`acp-runtime.ts`) over the rows of `runtime-rows.ts`: its `block` (why it can't run now, as `SendPath.block`), a turn one run that is under way when `Run.begun` settles (`turn.begun_at`, written by the desk) and ended when the run ends (`Run.ended`, with its usage, which the desk stores as `turn.context_used`, a record no decision reads); an agent resumes its one session on every wake, its runtime compacting it when full (his ruling of 20 Nov 2026: a conversation and an agent are the same thing), and a fresh session starts only when the old one is gone (`state` `gone`; on Claude Code it is titled with the agent's title) |
| A logged run's start and end | `recordRun` (`apps/server/src/memory/run.ts`) |
| What a model call read; what each source costs | `reads` on `step.ask`, made by `readsOf` (`memory/run.ts`) from unit ids (`dayUnitId`, `voiceUnitId`, `memory/unit-ids.ts`), required by `askOnce`, the one door to a provider; what was spent is `modelCallsOf` and `useOf` (`memory/run-log.ts`), the one sum over every logged run; the table is `bun life memory source-use` (`memory/source-use.ts`). Every model-calling file is in `MODEL_CALL_FILES` (`scripts/imports.test.ts`) |
| What a paid or metered resource cost (model spending, decision 83) | a spend, read where its record is logged (`memory/spends.ts`: `spendsOfLine` for `model.run` and `model.local`, `spendOfTurn` for the desk's turns, `spendsOfVoice` for Voice's `GET /spending`), never a copy; two bases never added, `billed` and `equivalent`; a price only from `core/prices.ts` (`priceOn`, dated rows); a spend without its amount is not reported, never guessed; rolled up by local day by the night (`host/spending.ts`, closed days only, a day written once), read by `read_spending` (`host/spending-read.ts`); a turn's matter is its assignment's anchors, for the top matters and the nightly's token rows alike |
| Life's own events in a calendar (the Past calendar, the appointments) | `googleCalendar` (`host/google-calendar.ts`), grouped by `heldOf` and brought in line by `reconcile` (`memory/calendar-events.ts`); each output finds only its own events; the appointments synced only by the watcher (`syncAppointments`), one at a time with his Remove and Undo (`inTurn`, `host/appointments-calendar.ts`) |
| An appointment agreed in new lines, and one as his phone shows it | `arrivalAppointmentsOf` over the stored `arrival_appointment` replies (`memory/arrival-appointments.ts`: the first per start, its id its start's hash, read back `ARRIVAL_APPOINTMENT_DAYS`); the night takes over its id (`arrivalsCitedBy`); the event sheet is `readAppointmentSheet` (`memory/read-appointments.ts`), by `read_appointments` and `fetch` of its `apt_` ref |
| Writing a secret file | `writeSecret` or `secretIn`, by its name in `SECRETS` (`secret.ts`), which also keeps it out of exports |
| Whether an output is on, and why not | `isOn`, `off` (`apps/server/src/core/outputs.ts`), never a setting read for the switch |
| A model provider's models, effort, quota, calls at once | its entry in `PROVIDERS` (`llm.ts`); a step's calls run through `inBatches` (`memory/run.ts`), never a loop or a limit of its own |
| Anything that differs between macOS and Windows | `apps/server/src/core/platform.ts` (paths, binaries, environment, time zone, notifications); a Mac-only source is `macOnly` |
| A file's size | Biome caps at 800 lines; a file already larger is in `CAPS` (`scripts/imports.test.ts`), whose count only goes down: split it by job |

Only `schedule.ts`'s schedules and the status snapshot's waking hours (`waking`, `snapshot.ts`, given `systemZone()`) follow the Mac's clock.
Where he is (`zones.jsonl`) is the phone's latest zone, whatever its age (`readZoneHere`, his decision of 27 Oct): the
phone is the source of truth and the Life server may run anywhere. The Mac's zone only when no phone ever named one;
lifelog unreadable changes nothing. Life reads the newest heartbeat's zone (the phone app always sends one); lifelog's
own owner zone (`ownerTimeZone`) takes the newest heartbeat that names one.

## Gotchas

- Never add a Keychain item for Life from the command line: macOS prompts, the app blocks on it and starts no helper.
- Every worktree reads and writes the same live data and lock. Point `LIFE_OWNER_DATA_DIR` at a copy to experiment; copy
  `derived/settings.json` into a worktree before model runs, and a copy of the live voice store (`watch/lifelog.sqlite`,
  `sqlite3 .backup`) before a bench. `bun test` uses its own made-up copy.
- A worktree installs its own dependencies (`bun install --ignore-scripts`); never link another checkout's
  `node_modules`: its workspace links resolve back into that checkout, so the worktree would run that checkout's code.
- The formatter sorts object keys: never let a key order carry meaning (use an array).
- `derived/` is generated; its rules load from `.claude/rules/derived.md` when you touch it.
- lifelog is read through its REST API; the zod shapes accept every null and absent field its contract allows
  (`lifelog.test.ts` checks them against `apps/lifelog/apps/server/openapi.json`).
- The desk never resumes a Claude session a live process runs (Claude's own record, `~/.claude/sessions/<pid>.json`: his
  app keeps one while the session is open, between his turns too): the wake stays queued until it lets go (`isHeld`,
  `runtime-rows.ts`; a send it refuses deletes its unbegun turn). One session, one process.
- The watcher hears a conversation only once its speech is complete, by lifelog's own signals (`endedOnSilence`,
  `closed`), never a timing rule of Life's (`docs/operations.md`). The desk takes a call's words as in the same way (`recordingsOf`, `sources/lifelog-speech.ts`): a turn past the call's end, or `endedOnSilence` or `closed`, and no earlier recording queued or submitted.
- Codex is pinned in `package.json` and runs with its own `CODEX_HOME` (`docs/operations.md`).
- Secrets live in `.env` (gitignored) or the Keychain: never print or commit them.

## Boundaries

**Always:** run `bun run check` before committing; work in a worktree (the live checkout may be what runs the owner's
Life); measure a change to episodes or extraction (`docs/operations.md`, "Measuring"); write an architectural decision
or invariant you make into this file or the doc it belongs to.

**Ask first:** a new table in the archive; a migration of stored data (the list of renames); re-running the whole archive through a model; bumping a prompt version;
removing a regression case; anything that spends the owner's model quota heavily (a backfill).

**Never:** commit anything of his; hand-edit or wipe `memory/`; touch the archive's files; push or add a remote to the
data repo; add a send into a chat beside a card's draft, a connector tool or an action; let Life's own code act or send on recorded content; print secrets; merge before
the debt verdict passes on the PR's current head (once it passes, any agent merges, without asking him: his
ruling of 29 Oct).

## Workflow

- A branch and a PR per change, small commits. Prefer deleting code to adding it; one way to do each thing; docs stay
  short and written for humans.
- Every PR follows the `work-on-code` skill where available: a debt plan checked before code, and the debt
  verdict before merge: did it add or reduce debt?
- **Strict paths** (never fast, always plan review and a confirming round): `apps/server/src/desk/`,
  `apps/server/src/host/http/` (connector, OAuth), the send paths (`memory/draft-send.ts`, `memory/decisions.ts`, each
  source's `send`, `host/report.ts`), writers of `memory/` and the ledger, migrations and store steps
  (`host/desk-shape.ts`), `prompts/`.
- A bug fix merges with its regression case (a failing-then-passing `bun test` with made-up data, or graded facts for
  a model stage): `docs/operations.md`, "Regression cases".
- A PR that changes `prompts/` says which cases of those stages it re-checked and how they came out.
- A PR adding a night step or a reader says what it reads per night at 10 years of data.
- **Prove a change cheaply.** A change to the system (code, a prompt, a step) that would re-process data is proved
  first on the smallest sample that can show it works or fails (a few days, weeks or cases, on a copy), never the whole
  archive. Aim for the strongest signal at the lowest cost: speed and money come first; stop a trial once its numbers
  answer the question (his word of 16 Nov 2026).
