# Life v4: the plan

Explanation: the plan for Life v4, the chat-first iPhone app and the agent layer behind it, written on 25 Nov 2026
and reworked the same day after the owner's review. It rests on issue #1373, issue #1376, the
[chat-first spec](../../design/philosophy.md), the
[code facts](../2026-11-25-overhaul-code-facts.md) and a read of Nod's source. Nothing here is built. The reasoning
behind each verdict is in [`positions.md`](positions.md); what v4 takes from Nod is in [`nod.md`](nod.md). The
owner's questions are at the end, before the debt plan.

## The bundles

The owner's direction of 25 Nov 2026: go as fast as the work allows. Strict paths (the desk, the connector, the
send paths, writers of `memory/`, store steps, prompts) are built in fast mode, bundles of about 1,500 changed
lines; everything else in ultrafast mode, about 3,000. No shadow week, no phase that only measures: measures are
recorded by the code as it is built. Tests only for what is critical (sends, memory writers, the owner's
directory, the send guard, the desk's store), each named under its bundle; the rest is owed in
`docs/plans/tests-owed.md`.

| | Bundle | Mode | Lines | Its files |
|---|---|---|---|---|
| S | The seam, landed first | fast | 60 | `turnRefusalOf` moves unchanged from `desk/desk-door.ts` to `desk/agent-actions.ts` |
| A | Agents and asks | fast | 1,500 | `memory/card-request.ts`, `card-problems.ts`, `decision-lines.ts`, `decisions.ts` (the `asked` line only, `:509`), new `memory/instructions.ts`, new `prompts/life-voice.md`, `host/inbox.ts`, `memory/held-matters.ts`, `read-matters.ts`, `desk/first-turns.ts`, `role-agents.ts`, `arrival-route.ts`, `event-queue.ts`, `agent-actions.ts`, `hand-out*.ts`, `matter-net.ts` |
| B | The main session and its answers | fast | 1,500 | `desk/main-session.ts`, `desk-door.ts`, `desk-store.ts` and its store step, `records/main-session-wire.ts`, new `records/answer-blocks.ts`, `host/http/mcp-main-session.ts`, `host/desk-turn-reads.ts` |
| C | The runtime, and the ground | fast | 800 | `desk/runtimes/*`, `desk/send-guard.ts`, `models/llm.ts`; the failing tests; `docs/plans/tests-owed.md` |
| D | The Life thread and answering | fast | 1,500 | new `host/life-thread.ts`, `host/http/mcp.ts`, `mcp-projects.ts`, `wire-fixture.ts`, `host/answer-result.ts`, `memory/answer-check.ts`, `memory/decisions.ts`, `records/observation.ts`, `memory/your-move.ts`, `memory/matters.ts` (`:183-241`), `memory/checks.ts`, `check-context.ts`, `host/correct-matter.ts`, `memory/draft-send.ts`, `draft-contest.ts`, `sources/matrix*.ts`, `sources/github.ts`, `desk/turn-ends.ts`, `host/migrate.ts`, `SECURITY.md` |
| E | Delivery | fast | 1,500 | new `desk/gate.ts`, new `host/owner-state.ts`, the heartbeat's route in `apps/lifelog/apps/server/`, new `prompts/desk-gate.v1.md`, new `memory/fix-checks.ts`, `desk/desk-clock.ts`, `host/card-push.ts`, `memory/check-urgency.ts`, `host/spending*.ts`, `core/settings.ts`, `scripts/imports.test.ts` (`MODEL_CALL_FILES`), `apps/lifelog/apps/server/src/apns.ts` |
| P1 | The old phone screens go | ultrafast | −13,500 | the old folders of `Lifelog/`, Kit's old wire models and their tests, `scripts/design-system.test.ts` |
| P2 | The app: the thread and answers | ultrafast | 3,000 | new `Lifelog/Thread/`, `Field/`, `Edge/`, Kit's thread and answer models |
| P3 | The app: items, notifications, offline, profiles | ultrafast | 2,800 | new `Lifelog/Items/`, `Profile/`, the notification extensions, `IncidentNotifier`, `LifeConnection` |
| Z | After v4 | fast | — | Codex on demand (#869); the renames (#1379, #655) |

### What runs side by side

No two bundles of a wave edit the same file. Where one calls what another adds, the signature is fixed here; the
later one to land makes its join, a line or two named below, in a file whose bundle has already landed.

| Wave | Side by side | Lands in this order |
|---|---|---|
| 0 | S | S alone: a move with no change, so A and B never meet in the door's file |
| 1 | A, B, C, P1 | P1 (deletion only), C, A, B |
| 2 | D, E, P2 | D, E; P2 starts on B's wire and takes D's when it lands |
| 3 | P3 | then Z, one piece at a time |

The seams between bundles. Wave 1: after S, every rule on what an agent's turn may call lives in
`desk/agent-actions.ts`, which is A's; `desk/desk-door.ts` is B's alone and calls it. A exports
`recordInstruction`, `instructionsFor` and `askAssignment` (the agent's side of a question), which B's door calls.
C adds `queue` and `cancel` to the runtime contract, which B calls. B owns the desk's store, so both store steps
are B's. A exports `inForceOf` (Life's voice and the instructions that hold on every turn); its join, made by A
after C has landed, is the line in the runtime that adds that block to every request (`pi-extension.ts`'s
`context` hook, and the turn's prompt on the other runtimes).

Wave 2: D owns `memory/decisions.ts` (every new line and writer: `delivered`, `rated`, `answer-withdrawn`, and
`deliveryOf`), `memory/checks.ts` (the Later migration runs through it, `:569`) and `host/migrate.ts` (both stored
changes: `your-move-not-now` to `deferred`, and the `notifications` setting dropped from the file). E only calls
them. E's joins, made after D has landed: one line in `checksNow` calling `fixChecksNow` from E's new
`memory/fix-checks.ts`; one line in the desk's tick calling D's `stopWithdrawn` (`desk/turn-ends.ts`), so `host/`
never imports the desk; the `notifications` key removed from the settings schema, once D's step has dropped it
from the file; the held cards counted in `desk/hand-out-tick.ts` (A's, landed); and `change_setting`, registered
in `host/http/mcp.ts` and the door (D's and B's, landed).

`bun run check` builds the iPhone app and runs Kit's tests (`scripts/check.ts:103-124`). So "the phone app may
stay broken" means that from P1 to P3 the app compiles, passes the check and does nothing useful, never that the
build is red. P1 lands first because it owns every deletion in Kit, the `show` decoder included; a server bundle
that changes the wire regenerates the fixtures under `apps/lifelog/fixtures/wire/` in the same PR.

## The verdicts, in one page

Each has its reasons in [`positions.md`](positions.md).

1. The gate on every agent's ask: yes, live from the first day, as its own model call with no tools, on the
   agents' own model (DeepSeek Flash; there is no second model). It returns four readings; code alone turns them
   into deliver, hold or send back, inside fixed limits. Those limits and failing open are the safety.
2. "How am I doing?": three marks and a small cross to dismiss, at most once a day. Silence and the cross count
   for nothing.
3. Agents together: a question about a matter goes to the agent that knows it. The record is read first; if it is
   not enough the agent is asked and has 60 seconds; research stays in that agent's context. No free
   agent-to-agent chat. It is in the first wave (bundles A and B).
4. Plan cards: the rule goes. An agent starts work without asking and asks only for what is the owner's: anything
   outward, anything that spends, anything only the owner can do, each on the exact thing.
5. Which arrivals become work: the current reading is right and stays. A message that needs nothing (a thanks, a
   confirmation of what someone else will do) wakes no agent and is no matter. A courtesy reply is not a new kind
   of ask.
6. Projects: a project is a container of context, never of agents. It was wrong to call it a label. It holds what
   the owner declared (what it is about, its people, chats, repos, deadlines) and Life's nightly reading of where
   it stands; every agent working on one of its matters reads both. No store of project knowledge that agents
   write.
7. `truth/`: it holds what the owner stated to exist (people, organizations, chats, areas, projects, goals);
   Life's guesses about the same things are in `memory/`, and the owner should only ever see the two as one
   list. The proposed name is `stated/` (question 21). The owner's dated statements (corrections, instructions)
   are a different thing and stay as appended lines in `memory/`.
8. Memory in git: right, and it stays. Nod is no model here: its memory is one 256 KiB document in Postgres.
9. Quick or long work: the main session decides per ask, shown the measured time of each kind of work. Long work
   is a thread item "under way" with its estimate, and its result lands as a follow-up.
10. Settings: no page. A `settings` component in the answer catalog, and offline the phone's own notice carries
    the settings that live on the phone.
11. Undo reaches sends where the platform allows it, read from the chat's own features, and says what the other
    side will see.
12. What the owner is doing now replaces fixed quiet hours: the gate is given the owner's state (asleep, on a
    call, in a meeting, talking with someone, driving) from signals Life has, and iOS's own Focus does the rest.
13. The spending stop is not a fixed sum: it follows the monthly amount and the matter's importance, and an
    instruction can set it.
14. A sensitive subject is its own effect, because code can do three things with it that a model's judgement
    alone cannot guarantee.
15. Reactions both ways are in v4: Life reacts to the owner's message where words would add nothing, and the
    owner reacts to Life's lines instead of replying. A reaction is never the owner's word for an act.
16. Life's voice lives in one file that every brief includes, and it, with the owner's style instructions, is
    put before the model again on every request, so it cannot fade in a long session.
17. Direct mode later; smart mode in v4. Answers are Markdown with Life's own components as fenced blocks. Nod:
    21 items now, 10 later, 8 no.

## How the pieces work

### Agents and asks (bundle A)

A card gains three fields its asker must write, refused when missing: `ask` (a short imperative line, "Pick a
clinic for the scan"), `recommended` (the option drawn full width) and `follow` (up to three suggested next asks,
in the owner's own voice). The `asked` line keeps the matter's id (#842) and the instructions the agent was given.
A draft card may carry `edits`, up to three quick changes in a few words each ("More concise", "Warmer"), for the
owner to tap. A card that replaces another says what changed (`deadline`, `condition`, `option`, `message`,
`edit`); without it the same subject is never asked twice. `CARD_SELF_CHECK` gains "check you can't do it yourself first" (#784).

The plan-card rule is removed (`opensWithPlan`, `planProblemOf`, `PLAN_OPTIONS`, the three first-turn texts). The
door no longer refuses `finish` or `set_wait` before a card, so an agent woken on an arrival that turns out to
need nothing ends without asking. `plan` stays as an optional body of any card: what happens after the yes. What
bounds an agent that never asks: `isCardOverdue` (`desk/hand-out.ts:51-62`) today closes a desk-opened assignment
with no card after two hours even when it set a wait, which would close an agent that works and then waits; A
changes it to no card and no wait. A wait lasts seven days at most, and an assignment stops at its spending
stop (bundle E). This removal waits on question 19. If the answer is no, the rule stays with two exceptions: the
one already approved (a reply's draft is its first card) and an arrival's assignment that may `finish` with no
card; `isCardOverdue` changes either way.

Arrivals keep their path: the arrival reader's confirm, which already leaves out "what others will do; greetings,
thanks, reactions, news, receipts" (`prompts/memory-arrival-confirm.v3.md`), then one agent woken, only above low
priority. No prompt changes. Wakes on the owner's own promises wait three hours (#785).

`memory/instructions.ts` is new, a new writer of `memory/`. `recordInstruction` takes no lock: it joins the
owner's single lines (a correction, a fact-check answer), one synchronous append. Both lists in `AGENTS.md` gain
it, the append-only files and the lock's exceptions (question 5, which also decides its folder; the code is the
same either way, one path constant). `recordInstruction` appends one line (id; scope: a person, project, matter,
channel or everything; the text; `until`; `replaces`; the owner's words as `said`; and optionally one effect), and
`instructionsFor` reads the ones that apply. The effects are a closed list, each enforced by code:

| Effect | What code does with it | Where |
|---|---|---|
| `quiet`, `interrupt` | lowers or raises the push; the gate holds or passes | E |
| `batch` | the gate holds what can wait until the next of the moments named ("9:00 and 18:00") | E |
| `later` | what Later means when tapped ("this evening") | D |
| `drafts`, `no-drafts` | whether Life drafts replies to this person | A |
| `hands-off` | the hand-out skips this project's matters: Life helps there only when asked | A |
| `intention` | a standing intention, with its assignment | A |
| `style` | how Life talks to the owner ("never an emoji"): in force on every request; "never an emoji" is also stripped by code | A, C |
| `sensitive` | a subject not to bring up: in force on every request; a card the gate reads as touching it never pushes and is sent back once; never in a suggested ask, an offer or "How am I doing?" | A, E |
| `budget` | what a matter, a project or any task may spend before Life stops and asks | E |

"How much Life does alone before asking" is not an effect: once plan cards go, everything that needs no send, no
spend and no deletion is already done without asking, and those three stay fixed. Within a scope a refusal beats
a grant, and a correction changes only what it addresses. The first six effects are approved (questions 5 and
23); `style`, `sensitive` and `budget` are question 26.

Life's voice is one file, `prompts/life-voice.md`, included by the main session's brief and by the rules agents
write cards under, so an ask reads in the same voice as an answer. It starts warm and plain, there for the owner
and taking load off ("I'll take care of that", "I'm on it", "I'll let you know"), never quirky; its words are the
owner's to settle (question 27). `inForceOf` returns that voice with every `style` and `sensitive` instruction,
read fresh from the file each time.

Who acts: a project's agent only when the project's context includes a repo, since code work needs that folder
and its rules; every other matter goes to the Personal agent (`agentForOf`). Any agent working on a matter still
reads the context of every project the matter is under, as the packet gives it today, and can now read the
records of the other assignments under the same project. A standing intention is an instruction with one
assignment of the Personal agent anchored on it, waiting on events with that person and a date.

`askAssignment` is the agent's side of a question from the main session: one turn, cause `main_question`, the
owner's words read at the door as data, the reply returned. `finish` and `set_wait` are refused while the owner's
words to that assignment are unread.

Critical tests: the refusals of the card's new fields, the reader's scope and precedence, the routing rule, that
`finish` without a card closes an arrival's assignment and sends nothing.

### The main session and its answers (bundle B)

The answer is the session's final text: Markdown, with a component as a fenced block named by the catalog.

````
Twelve bags, 4,820 ฿ in all.

```life:table
{"from":"life:file/receipt-7f2","columns":["Bead","Bags"],"rows":[["Tila",19],["Half Tila",14]],"total":33}
```
````

Words stream as they come. A block is checked when its fence closes (its shape, its `life:` refs, each number and
name against the text of `from`) and is drawn only then; one that fails is dropped and recorded as a miss, and the
words still stand. The catalog starts with `items`, `pictures`, `table`, `phrase`, `document`, `place`, `question`
(the spec's seven kinds) and `settings`. The phone says which catalog version it draws. A new component is one
schema, one SwiftUI view and one line of the brief. The `answer` and `show` tools go, and with them a round trip.

While it works, Life sends steps, `{verb, what}`, written by code from the tool and its arguments. A second ask
while one runs is queued; Stop cancels.

A question about a matter reads the assignment's record first (its wait, its reason, its notes, its open cards);
if that is not enough the session asks the agent through `tell_agent` and waits up to 60 seconds, one step on
screen ("Checking on the boiler"). Past that it answers from the record and the reply lands in the thread later.

Quick or long: for each ask the session either does the work in its own turn or hands it to an agent with a kind
from a closed list (`redraft`, `reply`, `research`, `booking`, `lookup`, `other`). Its packet shows how long each
kind has taken (`estimateOf`: the median of that kind's last 20, from the hand-over to the agent's next card or
`finish`, both already timed; a fixed guess until there are five). Handed work is a thread item under way with
that estimate; its result lands as a follow-up. How under-way work looks is the owner's next prototype; the wire
gives the state, the kind, the estimate and since when, and fixes nothing about the look.

Reactions go both ways. Life's answer may be, or begin with, a reaction on the owner's bubble: the eyes when work
is handed on or a second message is queued (code puts that one, at once, with no model turn), a thumb when an act
is done and words would add nothing. The owner's reaction to one of Life's lines travels through
`ask_main_session` in place of words; it is recorded on the entry and starts no turn. It is never `said`: no act
and no answer to an ask can rest on a reaction, and a send still needs the tap on the exact draft.

The thread's entries are kept by the desk: one row per ask, with the owner's words, the answer, the refs it
cites and the reactions (store step `stepThread`); `stepTurnKind` adds the kind of handed work. The words and the
answer are columns that can be blanked while the row, its time and a deleted mark stay, so the purge of #1384 can
empty an entry in place.

Critical tests: a block with a wrong number is dropped; the two store steps; an act still refuses a `said` that is
not in the owner's words when an agent's reply is in context.

### The runtime, and the ground (bundle C)

`queue` and `cancel` on the runtime contract, through pi's `follow_up` and `abort`. Effort follows the turn: the
main session and the gate lower than background turns, on the one model. The guard reads every tool call, not
only shell and MCP ones. From Nod ([`nod.md`](nod.md)): a large tool result kept in a file with a preview and a
reference; results wrapped as data; a dangling tool call closed as "interrupted, outcome unknown" before a
session is resumed; compaction numbers from the model's window; background turns paused with a growing delay on a
failing provider while the owner's asks still try; 30 seconds of silence is a retry; a turn stops after five
failed calls of one tool. The runtime also gains the place where a block is added to every request, after
compaction and never part of it; A fills it with `inForceOf`.

It records, per ask, the time to the first step, to the first words and to the whole answer, each tool call's
time and size, and what the tool schemas cost; and per turn, its context. Nothing waits on those numbers. Deferred
tools are built later only if schemas prove to be more than a fifth of a turn's uncached input.

The ground: the first check run names the 7 failing tests, and each is fixed or deleted with the code it tested,
none skipped (#846 by the test making its own people, #1150 by building the fake agent once, #766 closed if
`510d5dfa` is on main). It creates `tests-owed.md`, settles #1030 in the glossary, closes #1006.

Critical tests: the guard on a tool that is neither shell nor MCP; the session repair.

### The Life thread and answering (bundle D)

What "the thread is stored in the desk's store" means, simply. Today the conversation with Life exists only on
the phone's screen: close the app and it is gone, and nothing else can show it. v4 keeps it on the Mac, in the
small database where Life already keeps its agents' state. It is not put in the memory, because Life's own words
must never be read back as if they were the owner's life. The phone asks the Mac for the last few days of it.
`show` was the old way for an answer to switch tabs; with no tabs it has nothing left to do.

`read_thread` merges, by time and a few days per page, the entries above, the asks as they were delivered and
answered, and Life's own checks. With them it returns every thread item the page names, each in one state worked
out by one function, `itemStateOf`:

| State | Read from |
|---|---|
| Needs you | an open check (`checksNow`) |
| Later | the latest `deferred` correction, until its time or place |
| Under way | the owner answered and the asker's turn runs, or handed work, with its estimate |
| Waiting on someone | the matter's status (`matterOf`) |
| Settled | the `answered` line and its outcome |
| Outdated | a `withdrawn` line, with its reason |
| Queued | the phone alone: answered while offline |

A held card is not a thread item yet. `deliveryOf`, one function in `memory/decisions.ts`, derives from a card's
`delivered` lines whether it is held and until when, delivered, or sent back; `decisionsNow` reads it, so a held
card is in no list, no count and no push, and the gate's tick and the hand-out's count read the same function.

Nothing stores an item's state. The phone polls with its version stamp every 3 seconds while open. An answer
finds its check by its ref's kind (#722). Later is one `deferred` correction for any check, replacing
`your-move-not-now` by a migration; Life picks the time (tomorrow 9:00, sooner before a deadline, on arrival home
for a fix at the Mac), or what a `later` instruction says.

Undo is an attempt, through `answer_check`. For an answered card: `answer-withdrawn`, and the desk's tick, which
already polls answers, calls `stopWithdrawn` to stop the asker's turn. "The agent acted" means the woken turn made a tool call or the card has an outcome line; after that
the undo is refused with what was done. For a send: only where the chat's own features allow a delete for
everyone, read from `com.beeper.room_features` at that moment (its `delete` and `delete_max_age`, which Life does
not read today), by a Matrix redaction; a GitHub comment through `gh`. The Undo says what the other side will see
("WhatsApp deletes it for both; they see that a message was deleted") and reports "Deleted" only once the bridge
confirms. iMessage and mail have no Undo: Messages.app cannot unsend from a script, and mail cannot be recalled.
Each network is tried on a real chat before its Undo is switched on. Undo on a send waits on question 20; if the
answer is no, a send has none, as the spec says.

Adjust is the same ask, amended (the owner's yes of 25 Nov). A quick redraft is the main session's own, asked as
a replacement card that takes the open card's place at once; a long one is handed to the card's agent and shows
under way. It comes two ways, and the wire says which (`changed: edit`, and whether by words or by a tap). A typed
or spoken change: the owner's bubble has pushed the draft up, so the old version collapses where it is and the
new one shows below. A tapped quick edit, one of the card's `edits`: the draft stays the last thing on screen and
the same element changes in place. A tapped edit's label is the owner's word for that redraft, as a question's
tapped answer is. The look of both is the UI session's.

A deletion reaches the thread in `host/life-thread.ts`, at read, since `memory/` cannot import the desk: an entry
whose answer cites what was deleted is hidden. The thread also holds the owner's own words to Life, a second copy
of them on the Mac that cites nothing; they stay until that entry is removed. D says so in `SECURITY.md`
(question 25).

D also deletes the four connector tools only the old app used (`read_projects`, `read_project` in
`mcp-projects.ts`; `read_agent_session`, `read_log_lines` at `mcp.ts:325`, `:338`) with their fixtures under
`apps/lifelog/fixtures/wire/life/` and their lines in `wire-fixture.ts`, after P1 has removed Kit's decoders.

Critical tests: the migration; the `deferred` correction; withdrawal before and after the agent acted; a redaction
sent only inside the room's window and never for iMessage or mail; deletion hiding an entry.

### Delivery (bundle E)

Every agent's card passes the gate. Code's limits: never held past three hours before its deadline; never more
than 12 hours, or the next `batch` moment; sent back to its agent at most once; a fix ask and a follow-up to what
the owner just did skip it; a call that fails or takes more than 10 seconds lets the card through. Each verdict is
a `delivered` line. Two of its fields are read back, by `deliveryOf` alone: the verdict and, for a hold, until
when. The tick delivers a held card at that time by appending a second line. The rest (the four readings, the
rules applied, the position shown) is a record for later learning that nothing reads to decide. A card sent back
wakes its agent with facts only; the agent reads the gate's note at its door. The gate's prompt is a new file in
`prompts/`, and its call joins `MODEL_CALL_FILES`.

With the gate, the order of what waits becomes broken first, then deadline, then the gate's importance, and the
ranks by kind go. An agent's card the gate delivers now pushes once, as the ask itself (its line, who and when,
the draft, the main answer and Later). The push through Apple still carries the card's `pushId` and nothing else:
the phone's notification extension reads the card from the connector and writes those words itself, so no words
of the owner's pass through Apple. Life's own checks wait in the list and do not push. The hand-out keeps its
pace (`desk.handOut`), and `cardsWaiting` counts held cards too.

The gate is given what the owner is doing now, from one read, `ownerStateNow`, not a fixed quiet-hours rule.
Signals Life already has: the hour where the owner is, a calendar event under way, speech the pendant heard in
the last minutes, whether the Life app is open, whether the owner has just arrived somewhere or is between
places. Cheap to add, sent by the phone each time the Mac's 15-minute silent push wakes it: whether a Focus is
on (sleep, driving and do-not-disturb all show as one), and whether a call is connected. With them the model
reads "a good moment" and code keeps its limits. iOS already holds an ordinary notification during a Focus, so
Life's part is to be honest about levels: time-sensitive only within three hours of a deadline. The phone's
motion (driving without a Focus) needs another permission prompt and waits (question 28).

Smart mode is three rules: an agent may draft a reply once the arrival reader confirms the message needs the
owner; the gate holds the card until the owner's usual reply time for that person has passed; Life withdraws it
when the owner answers in the chat. Drafts are for people who have a page unless an instruction says otherwise.
A courtesy close is drafted only where an instruction asks for it, as an ordinary draft with a day's deadline
whose silence sends nothing.

Fix asks are written by code from a fixed list (a bridge signed out, the budget about to be passed); the caretaker
takes what is not on it. A failed health read is never a fix ask. The monthly amount is one setting: projected
from billed spending, asked once before it is passed, then hand-outs and background work slow, and recording and
answering never stop. Subscriptions do not count.

The stop on one piece of work is not a fixed sum. It is 2% of the monthly amount, three times that for a matter
the owner marked important or the gate reads as high, or what a `budget` instruction says; an owner who does not
care sets a large amount once and never sees it. At the stop the agent ends its turn with what it has, and the
ask is about the work, not the money: "Finding a clinic is taking longer than usual. Keep going?", with what was
spent as its small line. It is one ask per piece of work, through the gate. The amount is changed through `change_setting` (question 22),
whose writer is in `core/settings.ts`; until the answer, the `settings` block shows it and cannot change it.

When the Mac itself stops, the phone's armed local notification says so three hours after the last contact
("Life hasn't checked in since 14:10"), each contact moving it further, a silent push every 15 minutes included.
Its limit: iOS may hold or drop a silent push (`apns.ts:271-280`) and sends none after a force-quit, so the notice
can be wrong; opening the app checks at once and removes it.

Discoverability, from a fixed list in code: Life offers a setting at the moment it helps, as a question in the
thread (after the third Later for one person, "Keep Sam quiet until Monday?"), at most one offer a week and never
the same one twice; the field's fixed suggestions include one ability not yet used; "what can I change?" answers
with the `settings` block.

"How am I doing?": three marks and a cross under an answered ask, sampled by code, at most once a day; an answer
is a `rated` line.

Critical tests: the gate's limits as a pure function; the push rule; the fix list; the settings step.

### The app (P1, P2, P3)

P1 deletes the old screens and closes #712, #938, #934, #928, #849, #1010, #1266, #823, #767, #651, #1341 and
the phone-only debt issues (#984, #1001, #1084, #1105, #1109, #1126, #1087, #1179, #1245, #979, the phone parts
of #1243, #820, #620, #1288), each checked against its text first.

P2: the thread (bubbles, Markdown inking in, day separators, Show earlier), the field (typing, hold to talk,
Stop), the edge, the two round buttons, the steps line, the components and question controls, and reactions
both ways.

P3: thread items as rows that unfold, one shape for every ask, answering with its states on the button, Later,
Undo, the under-way item as the owner's prototype settles it, the notification as the ask, the offline queue,
the notices, profiles with their code-only sections, and the heartbeat's two new fields (a Focus on, a call
connected). Offline, the phone's own notice ("Your Mac isn't
answering") unfolds to the settings that live on the phone: the pendant, pairing again, Face ID before Send,
appearance. The spec says a notice has no body; this is the one that does.

Left out of the first app, each additive later: suggested asks from a second model run, "where things stand" on a
profile until its nightly output exists (the owner's yes of 25 Nov), a project's mark, light mode, the open Duo.
No app tests; what they would be is in `tests-owed.md`.

### After v4 (Z)

Codex leaves Life.app and is fetched on demand (#869). `truth/` takes its new name (#1379, question 21) and the desk becomes
the dispatcher (#655), each one mechanical PR with its migration and the owner's yes to its list, once the server
bundles have landed: during them every bundle would conflict.

### Later, not in v4

AI phone calls (#1274), any bank (#1271), Connect Google (#1377), the parked #982, #981 and #983, Claude Code and
Codex parity (#748), the Life plugin's naming (#1016), direct mode, Mac admin access, the security plan (trust
checks, a gate on what the owner started, limits for other people's Lives), learned procedures, browser and
desktop control, the prediction layer's learner, a project's "about" line read by the matters step (a prompt
version), deletion reaching the agents' notes.

## Where the prototype differs from the spec

The build follows the spec, except where this plan changed the spec (the last three rows).

| Prototype (`2026-11-25-app-v4.html`) | Spec |
|---|---|
| The microphone toggles on a tap and types a fixed phrase | Hold to talk |
| No failure on a button | "Not sent" (tap again), "May have gone", "Already answered: Sent" |
| Under way always ends after 2.8 s | A limit, then back to needs you with one line of why |
| Rows inside an answer are static | Live items in their states |
| An answer that starts work shows a row with a line | Work that would send becomes an ask with its draft |
| A document is an inline receipt | A real document opens in the system viewer |
| Reopen adds the owner's bubble and a copy | Reopen brings the ask back, no bubble |
| Only the WhatsApp fix has an away variant | Every fix at the Mac offers "Remind me when I'm home" when away |
| A fix lands at the bottom once the owner is free | The thread opens on what is broken |
| The pendant button has no coral state | Coral when it needs the owner |
| A words question only rotates suggestions | The field starts the sentence with Life's suggestion |
| A notification answer shows the card before its answer | The card in its new state, then the bubble with the bell |
| No "I couldn't answer that." | Shown; a tap on the bubble asks again |
| Undo never on a send | Changed by this plan: Undo on a send where the platform allows it |
| A notice has no body | Changed: the unreachable notice unfolds to the phone's own settings |
| The caretaker writes fix asks | Changed, and fixed in the spec: code writes them from a fixed list |

## Speed and cost

| Measure | How it is measured | Today | Target | Moved by |
|---|---|---|---|---|
| Time to first useful answer | Per ask: first step, first words, whole answer (recorded by C) | 15 to 36 s warm, over 60 s cold | First step within 1 s, first words within 3 s for half of asks and 6 s for nine in ten, a lookup whole within 10 s | B (no `answer` round trip, words streamed, the record read before any agent turn), C (effort, bounded results) |
| Cost per completed task | Billed spends of an assignment's turns at its close; per ask, its turn's | Not reported per task | An ask under 1 cent for half of asks; a one-reply assignment under 5 cents for nine in ten; any assignment stopped at its share of the monthly amount; the gate under 0.2 cent a card | A (no plan-card turn), C, E (the stop) |
| Task success rate | Share of asks answered with the recommended option, sent back by the gate, withdrawn; blocks dropped by the checks; the three marks | Not measured | Recommended option on 7 asks in 10; no wrong number shown; at most 5 pushes a day on half of days | A (the contract), B (the checks), E (the gate) |

The numbers are read as bundles land; a bundle that misses its target gets a fix, not a phase.

## The owner's questions

### Answered on 25 Nov 2026

| | Question | The owner's answer |
|---|---|---|
| 1 | The gate as its own call | Yes, live from day one, on the agents' model |
| 2 | "How am I doing?" | Yes: three marks and a cross to dismiss; their look is the owner's to design |
| 3 | Direct mode later | Yes |
| 4 | A reply needs no plan card; drafts for people with a page | Yes |
| 5 | Instructions in `memory/instructions.jsonl`, with its two invariant changes | Yes |
| 6 | A project's agent only with a repo | Yes; a project is context, the repo is part of it |
| 8 | Later with no menu | Yes |
| 9 | Undo | Yes |
| 10 | A redraft replaces the agent's card at once | Yes: the same ask, amended; a typed change and a tapped quick edit (bundle D) |
| 11 | The thread kept by the desk; `show` goes | Yes |
| 12 | Stored changes (`stepThread`, `deferred`, the `notifications` setting) | Yes |
| 13 | "Where things stand" in "you", nightly | Yes |
| 14 | The edge's exception in `docs/brand.md` | Yes |
| 15 | The connector's four writes | Yes |
| 16 | The main session's three door tools | Yes |
| 17 | Three new decision lines | Yes |
| 18 | Life's own checks stop pushing | Yes |
| 19 | Remove the plan-card rule | Yes |
| 20 | Life may delete a message it sent, on the owner's Undo, where the chat allows | Yes |
| 22 | `change_setting` for the monthly amount | Yes |
| 23 | The effects `batch`, `later`, `hands-off` | Yes |
| 25 | `SECURITY.md` says the thread's copy plainly | Yes; true deletion is #1384, and the entries are built to be blanked in place |
| 21 | One list of people; the folder renamed `stated/` | Yes to one list and to `stated/` (it holds only what the owner stated; the merged list is a read, not the folder). He finds today's merging poor, with many duplicates: #727 |
| 26 | The effects `style`, `sensitive`, `budget` | Yes |
| 27 | Life's voice: today's plain voice in one file, its words settled with him later | Yes |
| 28 | The phone reports Focus and a connected call | Yes; motion later |
| 29 | His reaction through `ask_main_session`, stored on the thread entry | Decided by the planning session as recommended (a technical shape, never his word for an act) |

### Still the owner's

Nothing waits on these.

7. One session per assignment for the Personal agent. Open, on the context numbers C records: yes if a Personal
   turn carries more than twice a project agent's. Nothing waits on it.
24. After v4: a project's one line of what it is about, read by the matters step. A new version of the matters
    prompt, which regroups every matter. Recommended: try it on a few weeks of a copy first.

## Debt plan

Tier: hard: `desk/`, the connector, the send paths, writers of `memory/`, two desk store steps, a migration and a
settings step. Mode: fast on strict paths, ultrafast elsewhere (the owner, 25 Nov 2026, for v4); the bundles
open this page.

Inventory: [`2026-11-25-overhaul-code-facts.md`](../2026-11-25-overhaul-code-facts.md) holds the checked facts.
What already defines or decides what v4 touches: the main session's brief, `show` and its checks
(`desk/main-session.ts:62`, `:126-188`; `desk/desk-door.ts:520`), its wire (`records/main-session-wire.ts:46`),
one ask at a time (`main-session.ts:311`); the runtime contract with no queue or cancel
(`desk/runtimes/contract.ts:55-101`), one route for every pi turn (`models/llm.ts:155`), the guard's filter
inside pi (`pi-extension.ts:280-290`, `desk/send-guard.ts:32`); the card's shape and refusals
(`memory/card-request.ts:40-57`, `memory/card-problems.ts:271-310`), the plan-card rule (`desk/desk-door.ts:113-142`,
`host/inbox.ts:33-53`, `desk/first-turns.ts:10-45`, `desk/agent-actions.ts:65-69`); the arrival reader's confirm
(`memory/read-replies.ts:122-146`, `desk/arrival-route.ts:115-191`); the decision lines
(`memory/decision-lines.ts:19-130`), Later today (`memory/answer-check.ts:486-497`), the order and the push
(`memory/check-urgency.ts:18`, `:129`; `host/card-push.ts:42`, `:86`, `:193`), the inbox read an answer makes
(`host/inbox.ts:27`); who acts (`memory/held-matters.ts:59`, `memory/read-matters.ts:365`, `:453`); a project's
context in the packet (`desk/agent-actions.ts:720-760`, `memory/read-truth.ts:53`, `:109-137`,
`memory/project-situations.ts:21-31`), what the matters step sees of a project (`memory/matters.ts:646`); notes
per assignment (`agent-actions.ts:107-113`, `:449-478`); what a room takes, with no delete read
(`sources/matrix-content.ts:7-30`); the hand-out's pace (`desk/hand-out.ts:21`); idempotent wakes
(`desk/desk-store.ts:126`); the phone's silent push (`apps/lifelog/apps/server/src/apns.ts:271-280`); the check's
Swift steps (`scripts/check.ts:103-124`). Searches run: `rg "your-move-not-now"`, `rg "ASKS_KEPT"`,
`rg "follow_up|steer|abort" desk/runtimes`, `rg "Bash\|mcp" desk`, `rg -i "unique" desk/desk-store.ts`,
`rg "cardsWaiting|budget" core/settings.ts`, `rg "redact|delete_max_age" sources memory/draft-send.ts`,
`rg -c "truth/"`.

Shape: four sources of truth. The ask is `Ask` in `memory/card-request.ts`, reshaped first so the gate, the push
and the phone read the same fields. The answer is the main session's Markdown with blocks, one parser and one
catalog in `records/answer-blocks.ts`. A thread item's state is `itemStateOf` in `host/life-thread.ts`, the only
place that names a state; the Life thread is a read over the desk's entries and `decisions.jsonl`, never a second
copy. What the owner wants is `instructionsFor` in `memory/instructions.ts`, the only reader. The gate is one pure
function over four readings. A project is context read through the packet; no bundle adds a second place for it.

State: `memory/instructions.jsonl`, per instruction, written by `recordInstruction`. The thread's entries and a
turn's kind in the desk's store, written by the desk. Three new line kinds in `decisions.jsonl`, per card:
`delivered` (whose verdict and hold time `deliveryOf` reads back), `answer-withdrawn`, `rated`. One correction kind, `deferred`, per check, replacing
`your-move-not-now`. One setting, the monthly amount, global. On the phone: the offline queue, the armed
notification and the device's own settings. Nothing stores an item's state, an estimate or a count, and nothing
reads a stored order. The thread's entries are a second copy of the owner's words to Life, stated in `SECURITY.md`.

Deletes: the old phone screens and their wire models (about 13,500 lines); the plan-card rule and its texts;
`show`, the `answer` tool and their checks; four connector tools only the old app used and what fallow then finds
dead; the order's ranks by kind; the `notifications` setting; `your-move-not-now`; the routing of projects with
no repo.

Net lines: about +11,200 / −16,600 (phone +5,800 / −13,500; server +5,400 / −3,100).

Plan review: the first review said reshape and was answered in place (the check builds the app, so "broken" means
compiling and unused; four invariant changes gained their questions; the claim that card text must not share a
context with acts was dropped as wrong; the order's change moved to the gate's bundle; Later became one `deferred`
correction; `cardsWaiting` stays). The plan was then reworked after the owner's review of 25 Nov 2026: the ten PRs
re-cut into five server bundles and three phone bundles in three waves, agents together moved into the first
wave, the measuring PR and the gate's shadow week removed, the plan-card rule removed, projects restated as
context, sends given Undo where the platform allows, settings moved into the thread, quick or long work added.

The second review said reshape; every finding was checked in the code and held. Blocking. (1) A and B both edited
`desk/desk-door.ts` (`:44`, `:138-142`): a seam bundle S now lands first and moves `turnRefusalOf` to
`agent-actions.ts`, so the door's file is B's alone. (2) D and E shared files: `host/migrate.ts` and
`memory/checks.ts` (`:569`) are D's, D's list gains `memory/matters.ts`, `host/correct-matter.ts` and
`memory/check-context.ts`, and E's few joins into landed files are named. (3) `isCardOverdue`
(`desk/hand-out.ts:51-62`) becomes no card and no wait. (4) "Never read back" was wrong for a hold: `deliveryOf`
derives held-until from the `delivered` lines, read by `decisionsNow`, the tick and the hand-out's count; only the
readings and the position are record-only. (5) Each open question now says which bundle waits on it and what is
built on a no; question 22 is E's. (6) `recordInstruction` joins the synchronous-append exceptions, and both
invariant lists are in question 5. Lesser. Undo's stop is `stopWithdrawn` in `desk/turn-ends.ts`, called by the
tick; A lists the `asked` line (`decisions.ts:509`); E lists its prompt file, `MODEL_CALL_FILES` and the held
count; the push is stated as `pushId` only; D deletes the four old connector tools with their fixtures; the
thread's hiding is in `host/life-thread.ts` and its copy of the owner's words is stated in `SECURITY.md`
(question 25). Shape: one bundle added, S (a 60-line move, wave 0); nothing else moved.

Reworked again on the owner's second round of 25 Nov 2026. Answers recorded: 5, 10, 19, 20, 22, 23, 25. Added,
inside the same bundles and waves: the owner's state now given to the gate in place of quiet hours (E, P3); a
spending stop that follows the monthly amount and importance (E); the effects `style`, `sensitive` and `budget`
(A, E); reactions both ways (B, P2); Life's voice in one file and an in-force block on every request (A, with its
join in C's runtime); a typed and a tapped redraft with `edits` on a draft card (A, D); thread entries that can be
blanked in place for #1384 (B). Question 21 is rewritten around one list of people and now proposes `stated/`.
No bundle added or moved; A's in-force join into C's landed file is the one new seam. A fresh plan review has not
been run on this round.
