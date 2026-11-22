# The agent, the connector and actions

Developer reference: how Life acts, hands work to the agent and serves the connector.

Life is a memory: it reads. It acts in a few narrow ways, each logged in `memory/ledger.jsonl`, and hands deep work
to his agents through the desk, which starts and wakes them.

## The agent

- His agents are the desk's registered agents. An app paired as an agent (`bun life pair <name>`, any name but a role's,
  `ROLE_ASKERS`; the grant's agent claim) asks decisions as itself; a grant with no claim (a plain app, `bun life pair`
  alone) reads only. The word stored for an agent's source (the ledger's `target`, its source's name, its units' sender)
  is one constant, `AGENT_WORD` (`core/names.ts`), kept as first written because stored data is append-only.
- **The agent is outside Life's boundary.** With the Mac's terminal it can read `.env`, the archive and `chat.db`, and send
  from every account. This is a known, accepted risk (`SECURITY.md`, "Agents"): an unattended run reads others' text with full
  access, within his grants. Its rules (when it asks him first, what it may send) are its own, not Life's.
- Only these become asks: a "hey Life" turn that isn't someone else's, his word about a registered agent and his
  complaint, all asks of the desk. Nothing else Life reads ever does.

- **Not built yet: a client that reopens an agent's chat** (`docs/plans/2026-11-20-codex-reopen.md` is the record).
  When he types in a chat that holds several matters, the agent works out from his words which matter he means, names
  it before acting, and asks in the same chat when the words leave several. The desk must bind any change to that
  turn's selected assignment, and an authenticated packet carries that assignment's agent wait, notes and new events.

## Asks

- An ask is the owner's words handed over, never acted on by Life's own code. A spoken one comes from a "hey Life" turn
  (`apps/server/src/host/hear.ts`: the two words, no model call), and the desk hands it to one agent ("Marks", below).
  - The owner's turn is `confidence: "high"`. An unattributed turn is `"low"`, and so is the owner's own "hey live"
    (lifelog's mishearing). A turn lifelog gives to someone else is dropped before the ledger.
  - The ask and the turns after it, until another speaker or a 15 s pause, are one ask.
- `ask` (`apps/server/src/host/asks.ts`) records it in `memory/ledger.jsonl` (`kind: "ask"`, `target` `AGENT_WORD`), once
  per `ref`; `asksFor` is how the desk reads his changes of it.
- An ask line's `instruction.quote` keeps the owner's words whole (clipped at 50,000 characters). This is the one place memory
  stores more than a short quote of speech.
- `bun life asks [--from d --to d]` lists where each ask's time went: spoken, ended, arrived, recorded.
- His complaint is his words through Ask Life ("Wrong…" on a card of Life's, never an agent's, opens Ask Life on it):
  the main session hands them on through its door's `complain` (`complainThroughAskLife`, `host/complaints.ts`), an ask
  of the desk with the card on his screen as Life reads it (its own cause) and his `report` tick, one per ask and card.
  Then the desk writes its complaint record row and receives it for the caretaker (`receiveComplaints`: its `complaint.received` event on the caretaker's assignment, registering the caretaker
  when none is active or stopped). The answer is `{ask, reached: "caretaker"}` only once all three are written; a
  stopped caretaker, a full desk, a runtime that does not answer, or a caretaker whose first turn never began since
  his last complaint, leaves it waiting (his next complaint tries once more), and the answer says so. The
  caretaker reads it through its door (`read_complaint`, only on the assignment that received it; an agent reads a spoken ask routed to it the same way, `read_spoken_ask`); while it holds it, the
  card with that cause shows `beingFixed` and stops blocking. An assignment that closes gives back the complaints it
  never handed to a turn: the desk receives them again.
- Old ledger lines of an agent's updates and replies (`TASK_LINES`) are history, parsed and never written; `read_memory_changes`
  with `about` `task:<id>` is an ask's whole history, and for one before 2 Nov 2026 its agent's lines.

## Actions: one backend

- **Life's code acts in one place only, on the owner's clear request in a Claude session or a chat: his items in one
  actions backend per install**, Apple Reminders (remctl) or Google Tasks (`gog`): add, edit, done, undone, remove,
  restore, through `changeTodoItem` (`apps/server/src/host/change-todo-item.ts`). `changeTodoItem` is the only code that decides an action. It records its intent
  before each write and its outcome after.
- When the owner asks for a to-do item change, use `bun life change-todo-item '<json>'` (kinds, fields and `said`: `Change` in
  `apps/server/src/todo-list/contract.ts`), never `remctl` or `gog` directly: it logs what changed, from what, and why.
- `changeTodoItem` refuses an add whose title an open item has (`duplicateOf`), for every caller. A timed `due` always alerts
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
- **What a backend lacks is a capability (`can`), never a branch on its name**: `changeTodoItem` refuses a change that needs one
  (`lacks`), saying so. Reminders can do everything (sections, urgent, priority, alarms, `listMoves`, restore, subtasks,
  recurrence, the Claude link, sharing). Google Tasks has a title, notes, a day (no time, so no alarms) and subtasks,
  and none of the rest; its lists are never shared. Restore is an optional method: a backend without it cannot
  restore.
- Only `todo-list/` touches either backend (`docs/architecture.md`, "The code"); `changeTodoItem` (`host/change-todo-item.ts`) decides and
  `inbound` (`host/inbound.ts`) reads the owner's changes back.
- **The to-do list output** is on only with the `todoList` setting, which names the backend: `{"backend": "reminders"}` or
  `{"backend": "google", "account": "<his Google account>"}` (`isOn("todoList")`). Off: `backend()`, the one gate, refuses every
  call, the minute pass skips it, the connector offers no `change_todo_item` or `read_open_todo_items` tool, `changeTodoItem` refuses, and the
  rest of Life runs the same. The read-back and the auto-add permission exist only while
  it is on. Settings are read once per process: turning it on or off takes a restart of the watcher. The connector's
  tools keep their names and arguments whatever the backend.
- Reminders goes through `remctl` (github.com/viticci/remctl, MIT), pinned in `REMCTL_RELEASE` and installed by
  remctl's own installer from the app; while Reminders is the backend and remctl is behind the pin, the app offers the
  update again (Apple silicon only). Google Tasks goes through `gog tasks … --json` as the setting's account. Their
  answers as Life reads them are `apps/server/src/todo-list/remctl.json` (recorded; re-check them when moving the pin) and
  `apps/server/src/todo-list/gog.json` (written from the Tasks API's resources, never run against an account). Without a backend
  Life still works from the ledger.
- Nothing Life hears or reads makes it act by itself.

### Reading the backend back

The owner's changes in the backend (tick, untick, edit, priority, urgent, add, delete) come back through `inbound.ts`
each minute as state only: one `via: "todo_list"` line each, with no `instruction` (they are not the owner's quoted words).

- They may close, reopen, reschedule, re-rank, rename, drop or add an item, and nothing else (no ask, send, approval
  or auto-add permission).
- A value Life wrote or tried to write since the field last settled is Life's own, whatever Reminders shows; so is a
  partial write's, and anything read within 30 s of one of Life's writes (reads lag writes).
- Section, order and a repeating to-do item's next due are Apple's, never read. Shared lists are never read. The first
  pass imports a baseline.

### Open things

What is open is a matter (`matterOf`, `apps/server/src/memory/matter-read.ts`): open while any of its to-dos, promises, waits or to-do items has no ending (a to-do item ticked or removed, an observation retired: replaced by a newer one or said outdated, or a link: probably ended until his word); a matter with none of them, a trip or an event, is open until 7 days past its last step and date. It is worked out when read from the matters step's lines (`matters.jsonl`), the observations, the ledger's to-do items (`todoItemsOf`: what `changeTodoItem` wrote and
what sync read back) and the chats; an open observation or to-do item no matter holds is a matter of one, and a to-do item made from an observation joins it. `openItems` (`apps/server/src/memory/open-items.ts`) times them and code ranks them (the owner's urgent flag and priority, what is overdue first, who owes whom, the owner's goals' order,
closeness, age); each is shown to an agent's review at most twice (counted from the ids its `read_day` calls were logged
with). `read_day`'s Due and `changeTodoItem`'s duplicate check read the ledger, never Reminders; a to-do item made by hand counts once sync read
it, within a minute. `read_open_todo_items` alone reads Reminders, for the sections the ledger does not hold. A 1:1 chat is
`isDirect` (`apps/server/src/memory/sources.ts`), for replies owed and closeness alike.

`read_matters` (the running matters, open and not dormant, of a person, project or area, in the rank `read_day`'s Due uses (`rankedMattersOf`: a matter ranks as its most pressing open step: his urgent flag and priority, what is overdue first, promises before to-dos before waits, his goals, closeness, then the oldest), those with no open step last: id, name, matter status, goal, next step, people by role, areas, projects, newest open step, last step, the agent on it or on its project) and `read_matter` (one matter, by its id or the id of one of its steps, so an agent anchored on a record finds its matter again after a re-group: the same fields, its steps in time order with dates, quotes and endings, and the agents on it, then the registered agents active on its projects) are the connector's reads of them, in JSON (`memory/read-matters.ts`, the same for his apps and the models); they read only. Each card of `read_inbox` names the matter it belongs to (the one holding its subject, else its ref).

Each running matter has a direction: its goal (where it is going) and its next step (what moves it now: `do`, `wait_event`, `wait_owner`, or `wait_decision` while his decision on one of its steps is open). The night drafts it for a matter with none, and again once the matter has a new step or ending, once for a draft made before it saw later records, and, in the matter's first 7 days, for a record from outside the matter the draft was not shown (`isDirectionDue`; never over his word). A draft that sees the matter is over has no next step and cites the records that show it (`endingRecords`), which the links step judges; no "Start an agent on this?" is offered for it (`memory/matter-directions.ts`); the first night drafts the running matters within its size, those with none first, and `bun life memory matter-directions --force --all` drafts them all at once. His word wins (`correct_memory`, kind `memory`, correction `{kind: "matter-direction", steps, goal?, nextStep?}`): his goal over every draft, his next step until the next draft. Every agent's packet opens with its matter as `read_matter` reads it; a project agent's opens with its project and, as `truth/` holds them, its people (id, aliases, handles per platform: a wait's `person` takes the id) and chats (the key a wait's `chat` takes; a room id written down alone is marked unsure). When its matter belongs to a project, or it is a project's agent, the packet then gives the project's context, read as data: its line (name, id, status, deadlines), his notes from `truth/projects/<id>.md` (clipped, as an area page holds them), and that `read_matters` reads its running matters, and where it stands (its project situation: Life's reading of those matters, nightly, as data); a project gone from his directory gives none. Every later wake on a matter opens with its matter record (`matterRecordOf`: the matter as read now, the steps it was never shown, its notes), so a resumed session never rests on its memory. An agent writes its notes only through `write_notes` (one file per assignment in his agents repo, `desk.agentsRepo`; the desk commits it, with the agent's home there, after each turn), changes a project's repo only on a card he approved, and never starts a session of its own to track a matter: the desk is the only dispatcher.

What only he can do (a payment by his hand, a call) an agent asks as a card whose "Done" option is marked `ends` (`step`, the subject step; `matter`, every open step of its matter): his pick of it alone, in his app, closes it by his word (`endByHisWord`, `host/correct-matter.ts`: its to-do items ticked, its observations by an `outdated` correction with Life's words naming the card), the card's `ended` line is the proof, and `decision.answered` carries `end` (its error, if any). With his words added, or another option, nothing closes: his words go to the agent. A session's `bun life` command never closes one.

An agent that finished a step of a matter closes it itself: a promise, a wait or a to-do note (an observation) with `correct_memory`, kind `outdated`, its id and a note of what was done; one of his to-do items with `change_todo_item`. It shows that night as done (`read_day`'s Done, the email's Done); he is not asked (his decision of 16 Nov 2026: Life should cut his load, and "is this done?" is load). An agent follows a matter by one of its records, never by the matter's id alone: a re-group gives matters new ids, and `read_matter` opens the matter holding a record.

Agents are created only on his word: a project's, or the Personal agent (one at most, `role: "personal"`; its home `<agentsRepo>/personal/`), which the desk also registers itself for a confirmed arrival no matter's agent takes when none stands (`desk/role-agents.ts`). A matter goes to the agent that takes it (`agentForOf`, `memory/held-matters.ts`): the oldest active agent of the project it shows under (`projectOf`; his `matter-project` word first, `correct_memory` with `matter`), else the Personal agent, else none; his Start on a matter opens an assignment of that agent, his words its `said`. Every matter sits with that agent (the assignment fold, `foldAssignments`, `desk/matter-net.ts`, on the desk's message poll): an open matter assignment another agent holds moves to it once its agent has no turn running, with its wait, notes file and cards (his next answer wakes the new agent with the matter's record), and an agent left with nothing open ends "folded into the <name> agent". So a matter moves from the Personal agent to a project's new agent by itself.

A matter's open step that is his never leaves his inbox (his yes of 21 Nov 2026): every open matter, dormant or stuck too, holding an open to-do, promise or to-do item of his (`yourMoveOf`) gets one your move card, worked out when read like Life's other checks (`yourMovesOf`, `memory/your-move.ts`), unless an open decision is on it, its project is parked, or an agent's open assignment holds it (an agent waiting on him, `wait_owner`, still shows it). Its step is the question (the one due first, else the newest), its due day the deadline (it blocks, the badge, with or without one; it is ordered after every agent's decision), and a `place` need (name, Google and Apple Maps links) when an appointment was read from it; Life holds no address and no ride link, so it gives none. Mark as done closes that step by his word (`endByHisWord`); Hand over is a new matter's Start; Not now (`your-move-not-now`) hides it 3 days, or until the matter gets a new step; Drop ends the step as Mark as done does, recorded as dropped (`outcome: dropped` on its `outdated` correction), its to-do items removed from his list (Reminders can restore them; Google Tasks cannot). While a matter is offered as a new matter ("Start an agent on this?"), that card asks first; its your move card follows once the offer ends or he dismisses it.

The desk also gives a matter to an agent itself, the hand-out (his word of 20 Nov 2026, `handOutNext`, `desk/hand-out-tick.ts`): only with `desk.handOut` set in his settings (`cardsWaiting`, `aDay`), at most one per look and one look per 10 minutes, on the first matter of his ranking (`readHandOutMatters`; a matter whose projects are all parked ranks last and is skipped) that passes `handOutGateOf` (`memory/read-matters.ts`, one gate for the hand-out and the new matter check: next step `do`, project not parked, direction not due since news may have overtaken it, not dismissed, not held, one of his (`isOneOfHis`: it involves someone he knows, `isKnownToHim`, never one only Life inferred, or holds an open step he said himself), and an agent takes it). It starts no agent: it opens an assignment (by `desk`) on the agent that takes the matter. "Held" is one rule for the hand-out and the new matter check (`isHeldOf`, `memory/held-matters.ts`, over the desk's anchors as facts, `heldByAgents`): an active or stopped agent's assignment holds its matter; one that closed holds it until the matter has a step newer than its close, so a try is not repeated on a matter nobody moved; one closed because its matter looked over holds nothing, nor one he asked for that never began. Only agents active, stopped or ended in the last 90 days are read (`HOLD_DAYS`): a try older than that may be repeated once, accepted to keep the read bounded; the inbox keys on a stamp of them (`heldStampOf`), never the list. A project's agent holds only what is assigned to it. While the hand-out is on, a new matter of his own gets no "Start an agent on this?" (the hand-out takes it); one that is not his still does. No hand-out while `cardsWaiting` of his agents' cards are in his inbox (`openChecksNow`: a card his inbox hides, its matter closed, does not count) or `aDay` given on his day. No word of his is recorded; its first turn reads, then asks one card (the prepared step, what only he can do, or that it looks over), and every send still needs his yes on that card. A handed-out assignment whose first turn began and asked no card within 2 hours is closed (`endAgentsWithoutCard`, `isCardOverdue`, through `closeAssignment`, which stops its run) with the outcome "no card within 2 hours", measured from its first turn's beginning, and its matter stays held like any closed try; one whose first turn never began holds its matter too (`isHeldOf`), so neither is tried again before the matter moves. Its agent stays: a standing agent's own assignment keeps it. The Personal agent may draft to a project's work contacts until that project has its own agent.

An assignment's matter that is done (matter status `done`: its steps ended, retired or ticked; never `probably_done`, ended by a link) closes it, as if its agent had called `finish` with "its matter is done"; a handed-out one also closes when its matter is no longer running (probably done, dormant or closed), with "its matter looks over", after which it holds nothing; one he opened himself stays until he stops its agent or his word makes the matter done; an agent ends only when its last open assignment closes (`endOutcomeOf`, `endAgentsOnOverMatters`, `desk/matter-net.ts`, on the desk's message poll, on the next poll after a matter changes). Steps no matter holds now (a lone matter that closed leaves the book) count only once every one has ended (`endedStepsOf`). His answer whose `ends` option closed the matter is queued like any answer: it may wake its asker for one turn before the next poll ends it by the rule above, so nothing waits long on a matter that is over. When he starts an agent on the project or matter of a stopped agent, that agent is handed over to it in the start (`start`, `desk/agent-changes.ts`); several agents may share a project, and one stopped beside another stays stopped.

A wait's filter is the connector poll's (`EventFilter`, `text_matches` included). A registered agent is also woken when a call matching its wait ends and its recording's words are in (`pollCalls`): the next poll queues it, and it wakes the agent like any event (`nextWakeOf`), in one turn with the chat's messages.

What will wake a waiting agent is read, not stored: its **wake list** (`wakesOn`, with `statusSince`) on each agent of `read_registered_agents` and of `read_matter`, from its wait's filters (`wakesOnOf`; docs/glossary.md). A chat's name there comes from his directory, else from the newest event the desk queued for that agent in it, else none.

A wait may also name an event channel (`EVENT_CHANNELS`, `host/event-channels.ts`), today `payments` and `places`: the desk reads the
payments of the last 35 days every 5 minutes while some wait names it, and queues `payment.booked` once per agent for
each payment its wait wants (by `quantity` `eur_out` or `eur_in` with `above` and `below`, or by `text_matches` on the
merchant, the category and his note), paid since the agent was created. `set_wait` refuses a channel that is unknown,
off or cannot be read, and keys its channels cannot answer; a read that fails is said in the agent's next wake. For
`places` the desk reads lifelog's stays of the last 48 hours (`/visits`) at every poll while some wait names it, and
queues `stay.arrived` once per agent for each stay that began since the agent was created and within those 48 hours,
near the wait's `latitude` and `longitude` (within `radius_m`, 100 by default) or matching `text_matches` on
`arrived <place>`; one real arrival can wake an agent more than once. Departures are not events yet: lifelog ends a
stay after 2 hours without a point, and the phone sends positions only near the pendant, so a silent phone would read
as a departure; they come once lifelog says why a stay ended.

The connector's `read_people_and_organizations` with a name returns the `now` part as JSON (`personNowOf`, `memory/person-now.ts`): their party and closeness level, the last exchange, `needsYou`, their reach, details (a work line with the `ref` of the organization of his directory it names, a family line with the `ref` of the person its name resolves to: `detailRefOf`), the first picture of each source (`pictures`, what his pick can name, only for someone of his directory; the one in use their `picture`), communication style, what their time together was about (the titles of the last 60 episodes they took part in, by month, `episodeTitlesOf`), the Situation, the parts Life holds (`knows`), an organization's people and domains, and their running matters as `read_matters` rows (host reads them once, `readMatterRowsNow`, the most pressing first). The whole answer keeps within `PART_CHARS`: its lists are cut from their ends, the episodes first, and `more` counts what each left out (`read_matters` with `person` for the matters, the `evidence` part for the episodes); `reach` keeps to a third of the room, the accounts it has no room for listed in `details`, and `moreReach` is the ref of the `reach` part that opens every account, a page at a time (`fetch person:ana/reach`, then each page's `next`, `person:ana/reach/18`: the span is how many accounts to skip); a shared name's `candidates` take a quarter of the room at most (the list with `query` gives them all). The other parts are `page`, `persona`, `story`, `year` and `month` and `evidence` (the observations, episodes and conversations), prose of about 6,000 characters each ending with the refs of its deeper reads, which `fetch` opens (`openById`, `read-part.ts`), and `latest`, their newest one-to-one exchanges and conversations in person as JSON, five a page (`readLatest`, through `readPersonUnits`). A person only heard has no parts: their read is the evidence, paged with `before`. With no name it is the list, by closeness. `fetch person:me/conversation/<first turn ref>` opens one conversation summary: the summary, its subjects (each with the `fetch` of the turn it opens), quotes checked against their lines, doubts about who spoke and the next part. `read_day` lists the day's summaries after its episodes, and `search` its best matches after the episodes, each with the ref that opens it; a subject whose line is out of range and a quote not on its line are never shown.

### The auto-add permission

The only other authority, off until the owner's words in a Claude session turn it on (`bun life auto-add on|off '<their
words>'`, an `auto_add` line in the ledger, the latest standing). The owner's "stop" may come through the agent, because off only
takes authority away.

- While on, `change_todo_item` with `obs` in place of `said` adds a to-do item (title, list, due, section) from the owner's current
  importance-3 to-do or promise in a lifelog turn the store credits to the owner at that moment.
- At most 3 a day, one at a time, never on a shared list, and not again once one it made was removed (through Life or
  by hand) until the owner's next yes (`autoAddRefusal`, all derived from the ledger).
- Its authority is the observation alone: never a fact-check answer or a chat `said`. It binds the connector, not
  the agent's terminal.

## The Past calendar

A one-way projection of the episodes (`apps/server/src/memory/past-events.ts`), kept by `syncPast` (`apps/server/src/host/past-calendar.ts`), on with the `pastCalendar` setting: each tick brings in line the episodes ending in the last 3 days (the calendar listed from a day before), the night's turn the whole calendar (a backfill, his corrections, renames);
one event per episode, overlapping as they happened (a big episode holds smaller ones), found by its private
properties `lifeEpisode` and `lifeHash`. A changed episode is updated in place, a gone one deleted; events without
`lifeHash` are never touched; one with no `lifeEpisode` (an older Life's) is deleted. An event's location is where he
stayed most of it (else the episode's place), with one-tap Google and Apple Maps links at the end of its description, never clipped (`mapLinksOf`,
`calendar-events.ts`: by coordinates when Life has them, else by name); a new description layout (`LAYOUT`) writes
every event again, one call at a time. It reads nothing back and never alerts. If that calendar ever becomes a source, its
events with `lifeEpisode` are Life's output and must be dropped.

## Appointments

His request of 8 Nov 2026: what he is due at, from any channel, in his own calendar before his agents plan his day or
week. Each night `appointments` (`apps/server/src/memory/appointments.ts`) reads his active facts ahead (plans and
bookings, never a hypothesis; recent undated plans too) with the appointments held, and writes `memory/appointments.json`: a trip and the dinner in it are two;
a later message (his tickets) moves the same appointment, which keeps its id by the facts it shares; a guessed time
says so. By day, an appointment agreed in new lines (his word of 21 Nov 2026: the arrival reader's `arrival_appointment`
read, `memory/arrival-appointments.ts`) joins them within minutes; the night takes over its id when its facts cite the
same messages. `syncAppointments`
(`apps/server/src/host/appointments-calendar.ts`, the `appointmentsCalendar` setting: account and calendar), run only by
the watcher, every 30 minutes, brings that calendar in line, through the client the Past calendar shares (`google-calendar.ts`, `reconcile` in
`calendar-events.ts`), touching only events with `lifeOutput=appointments`:

- Until confirmed an event is titled `(Life) …` and shown as free; one he agreed in new lines (the arrival's) is busy
  at once (his word of 21 Nov 2026). An agent confirms one with him by setting the
  private property `lifeConfirmed=yes` (`gog calendar update <cal> <id> --private-prop=lifeConfirmed=yes`); Life keeps
  amending it, without the mark, as busy.
- One deleted by him or an agent is his no: recorded `refused` (`appointment-events.jsonl`); no appointment citing all
  its facts is written again. One Life deletes is recorded `removed`, so it may come back. His phone's Remove
  (`change_appointment`, his token only) deletes it and records `refused`; its Undo records `restored` and writes it
  again, while Life still holds the appointment (confirmed if he had confirmed it; restored once its own event is
  written, whatever else the sync failed on). His Remove holds in any calendar the setting later names.
- Its first event pushes `calendar.added` (his `notifications` setting's `calendar`, quiet by default) with an opaque id;
  the phone reads the event sheet with `read_appointments` (`pushId` or `appointment`). An arrival's event names the
  unit it was read from and a meeting link copied exactly (https only), and stays until it ends.
- Times are the place's (`zone`, when it is not where he will be); a reading that forgets a held appointment keeps it
  while its facts hold and no new one cites them. An event turning all-day or timed is written again (Google cannot
  change it in place). The Past calendar never touches an event with `lifeOutput`, so both may share a calendar.
- Its location is the appointment's place, with Google and Apple Maps links by name in the description (`mapLinksOf`).
- Only a popup reminder, never mail (it would come back as a message). No guests, no invites sent.
- An agent's event (his word of 21 Nov 2026): a card with one `event` need (title, start, end, 1 to 3 reminders in
  minutes, place) and one option marked `adds` ("Add to calendar"). His pick of it alone, in his app, writes that event
  once into this calendar through `googleCalendar`, marked `lifeOutput=card`, busy, with popup reminders, no guests
  (`addEventByHisWord`, `host/card-event-calendar.ts`); the card's `added` line is the proof, `decision.answered` carries
  `added` (the event's id, or the error); a failed write is not retried. It is never touched again by the sync or
  the Past calendar, so one he deletes is never written again. An agent is never "sure" in Life's sense (that is Life's
  own reading's confidence), so its event is always asked; what Life reads as agreed reaches his calendar as an appointment, unasked.
- An event that ended is never touched.

## Marks

A mark is his words to Life, to keep: the unit is always read, every fact extracted, each at its own importance (at least
`KEEP_AT`). Three ways in, none of which acts or sends. "hey Life" in a recording is Life's own wake word
(`LIFE_WAKE`, `host/hear.ts`): the hearing records the span (`spansIn`, `writeMarks`, refs only) and an ask of the desk,
which hands it to one agent (`desk/spoken-ask-intake.ts`: the matter assignment its words are closest to in meaning, else
the Personal agent, which it starts when none stands; its `ask.spoken` event holds where his words are, never them, and
wakes the agent at once; his phone hears "<agent> heard you" when that agent's turn begins); agents
A message to himself (mail he sent only to his own addresses; every
message of a chat with himself, `chatPerson` in `units.ts`) is marked by its reader. What he tells Life in a chat
(`tell_life`) is the source `told-life`. The unit carries its marks (`marked`) and says so in its text (`MARKED`), so only its
hash moves and only it is read again, with no prompt change. Extraction shows its lines `(marked)`. The nightly lists
each once read, with the observations citing it ("Told Life").

## The connector

`apps/server/src/host/http/mcp.ts`, served at `/mcp` for Claude and ChatGPT. It reads, forwards the owner's explicit corrections and fact-check answers, appends his words (`tell_life`), changes his directory in `truth/` by his words (`change_directory_entry`) and acts
only on the owner's explicit request (in the chat, or through an agent's `change_todo_item`) or on the auto-add
permission.

- **Tools:** read-only: `read_new_events` (Events, below); `read_open_todo_items`, read from Reminders; the status reads
  `read_life_status`, `read_processing_runs`, `read_memory_changes`, `read_observation`, see `docs/status-reads.md`; `read_inbox` (what waits on his word, from host's `openChecksNow`: every open ask in one shape (his agents' decisions, who a voice or a person is, whether a step is done), what blocks first, `limit` cards (default 50) from the first or `after` a card's ref (or, with a push's `pushId`, just that card, none once answered), with counts by group and `blocking`, each check's `urgency`, and its read version (`ifNot` it: only `{version, unchanged: true}` while nothing changed; `read_matters` too, which never waits on the embedder for icons); a voice lifelog asks him to name is among them (`voice`, answered through `answer_check` and forwarded to lifelog); a new matter's check is also on `read_matter`'s `checks`) and the memory reads. Writes: `correct_memory` (a memory correction, lifelog
  writes all go through `writeLifelog`, `apps/server/src/sources/lifelog.ts`) and `change_todo_item` (through `changeTodoItem`, with the owner's words
  in `said`, or an `obs` for the auto-add permission) and `change_directory_entry` (`host/change-directory-entry.ts`: `said` his words, one `kind` (person, organization, project, area, goal, may_keep) and `action` (add, edit), a person's or an organization's picture pick (`pictureFrom`, also his app's picture sheet, `said` the words of the tap); checked by `integrity` on a copy of `truth/` first, then written, committed in his data repo with his words and kept as told-life (`said` only); owner's token only; never deletes, reorders goals or edits a person's birthday, projects or chats) `request_decision` (an agent's question to him as one card, or from his own app's token one asked as `owner` (`OWNER_ASKER`), the one way a session sends a message for him (his word of 19 Nov 2026), `memory/decisions.ts`'s `requestDecision` (its rules: `CARD`, short, each part's details a `fetch("ask/<name>")` page, `memory/card-request.ts`; a question ends in a ?, a label is at most five words, else it is refused with the reason and the page to read; its `context` is required Markdown (20,000 characters at most) and each of its `life:<ref>` links must name something `fetch` opens (`contextProblemOf`), and `read_inbox` gives each card's links with their kinds (`lifeLinks`); `needs`, `doneSeenBy`, `plan`'s steps and an option's marks are published loose and checked by `Ask`, so a new kind never changes the arguments; a plan only as `plan` steps (`gathered` with it), never a numbered list in `context`, required on an assignment's first card (`fetch("ask/plan")`); `cost`, `effect`, `pick` and a `takes` other than `note` are refused as not built yet), returning its id and, to an agent, an events cursor; or its withdrawal, by the agent that asked) and `answer_check` (`{ref, options, note?, person?, value?}`, owner's token only: his answer to any check, `memory/answer-check.ts`; `value` is refused as not built yet; a decision's first answer stands; his pick of its `looks` option alone makes Life look in his accounts for the card's amount (`host/done-seen.ts`): seen, the card ends; not found, it is open again, its `doneSeen` saying so, and the watcher looks every 5 minutes while it is open; no option with `note` is his own answer, sent to its agent; Start on a new matter check asks the desk to start an agent with the goal he saw (`note`) as the brief, through `change_registered_agent`'s start, which saves it as his `matter-direction`) and `tell_life` (`{said, asked?}`: appends his verbatim words to `memory/told-life.jsonl`, `memory/told-life.ts`; offered only while the `told-life` source is on, refused for an agent's token). `change_todo_item` exists only while the to-do list is on.
- **Ask Life:** `ask_main_session`, his app's token only (the send guard refuses it to an agent): his words and his screen's refs to the main session (`desk/main-session.ts`) over the door's loopback path (`/main-session`, the local key); the session's lines come back as progress notifications and the call ends on its answer, one kind of a closed list (`records/main-session-wire.ts`). Its words are its text after its last tool call; its door's `answer` adds why and sources, or likely answers that make it a question. With no words, his presence keeps the session open. It acts on his words through its door (`desk/desk-door.ts`): cards as his own, his word about his agents (`hand_over` included), his words to one agent, corrections and a matter done, and his complaint to the caretaker, each with `said` found in his words of that ask; sends stay a card he taps. Its `show` puts something before his eyes with the answer, changing nothing: a page (a matter, a person or organization, a project, an agent), or a list of matters, checks or people cut to rows it picked from Life's reads, under a few words, which his phone keeps as a filter until he closes it.
- `correct_memory` and `answer_check` (a `same-person` merges two people) are annotated destructive so clients ask first. `change_todo_item` is not (a remove goes to
  Recently Deleted, nothing is lost), so the agent uses it unattended.
- **Events:** MCP's Events extension (`io.modelcontextprotocol/events`, a draft), by poll: `events/list` names
  `message.received` with the arguments an agent filters on (`person`, `channels`, `chat`, `from_me`, `text_matches`),
  `events/poll` returns what matched past the agent's cursor: who, where and when, never the text (`events.ts`). Any
  paired app may poll. `decision.answered`, `decision.lapsed` and `decision.withdrawn`: a paired agent's own decisions settled since its cursor (an
  instant; `request_decision` returns one), with his answer, its `onSilence`, or why Life withdrew it (another card took its place, `replacedBy`, or he answered in its
  draft's chat himself: the watcher reads each open draft card's chat every 30 s, `withdrawDraftsAnsweredInChat`), all in one page (`settledBetween`). A card with a draft into a chat another asker's open card holds waits on it (`waits` in the result: `on`, `until`, `why`; state `waiting`, not in his inbox): the holder hears `draft.contested` (a registered agent, at once, facts only), reads it (`read_card` at its door) and yields (withdraws its own), merges (`merges`: one card for both) or keeps (`keep` with `why`; the waiting card's agent hears `draft.kept`); silent 10 minutes, it is asked with `replaces` (the card shows "replaces an older draft"), and his Send of a card withdraws every other card into its chat (`replacedBy`, heard as `decision.withdrawn`); a send that runs holds the chat. The same asker's second card into its own card's chat, or a card into a chat where one waits, is refused. A paired agent or his own app's session is not woken: it reads the result's `waits`. A source has events when its descriptor has `incoming`. `read_new_events` is the same poll as a
  tool, for a client that can't send `events/poll` (a Claude app's mod, ChatGPT).
- **Auth:** every request needs a JWT for this resource with `life:read`, from Life's own issuer, the only one
  (`apps/server/src/host/http/oauth.ts`, at `<origin>/auth`: an app is approved with a pairing code
  from Life's panel, "Pair an app"; PKCE, one-use codes, refresh tokens replaced on use and kept 90 days (a used one serves one more time within a minute, for an answer that never arrived), its key in
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
- Each new card in his inbox, of every kind: its own push, "1 new card" with the badge (every open card that blocks
  him) and its `pushId` (`pushNewCards`, `host/card-push.ts`); past the first 5 of Life's own checks in one look, one
  push "N more new cards" for the rest. Each kind's level is his `notifications` setting (off sends nothing). The
  first run pushes nothing. Never a title, name, question or ref: his phone reads the card and writes the
  notification's text.
- Into a chat: only a card's draft (text, or a file, a reply, a reaction, mentions, as the chat allows), exactly as shown, into the one chat Life resolved when the card was asked, once, when
  he picks its one `outgoing` option alone through `answer_check` (in the app, or with Send on the card's notification, on his phone or Watch) (`answerDecision`, `memory/draft-send.ts`), through
  Life's own bridge for that network (a new 1:1 WhatsApp chat is opened by its number first), or, for iMessage, through
  Messages.app (text, or one file then its text as a second message; no reply, reaction or mention; confirmed by the
  sent row in chat.db), or, for mail, through gog's Gmail from one of his accounts (a new mail or a reply in the thread of one message; never reply-all, quote, signature or tracking; `gog auth add <account> --services=gmail --force-consent` if gog says it lacks Gmail send). What the chat takes besides text is its send path's `takes` (a bridge's room features; Messages.app's, mail's and
  GitHub's own limits), the one rule its refusal and `read_chats` (with a `chat`) both read, checked when asked and again before the send; a file is read once more and must match the
  digest the card showed. The outcome (`sent` with the sent message's id, or `send-failed` with why, which may
  say it may have gone) is written on the decision and reaches its asker in `decision.answered`. A send that ended `not sent:`
  (nothing went) voids his answer: the card is open again, and only his own new answer sends it (once per answer; a
  repeat of the same tap, by its `answerKey`, returns the stored result and sends nothing); a send that ended `may have
  gone:` stays answered and is never retried. Nothing is sent when anyone wrote in the chat since the card was asked
  (or since his last not-sent attempt), his own messages included (the archive's copy can trail the network by its
  copier's interval); mail has no chat and skips that check. Nothing goes on silence or with his words added. Networks without a bridge of Life's (LINE, read from
  Beeper; mail) don't send.
