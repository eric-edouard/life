# Life v4: the plan

Explanation: the plan for Life v4, the chat-first iPhone app and the agent layer behind it, written on 25 Nov 2026
from issue #1373, issue #1376, the [chat-first spec](../../design/chat-first/2026-11-23-current-spec.md), the
[code facts](../2026-11-25-overhaul-code-facts.md) and a read of Nod's source. Nothing here is built. The reasoning
behind each recommendation is in [`positions.md`](positions.md); what v4 takes from Nod is in [`nod.md`](nod.md). The
owner's questions are at the end, before the debt plan.

## What v4 is

v4 is a foundation: one thread with Life, a server that feeds it, and agents whose asks are few and clear. After it,
most work is one more answer component, one more ask body, one more rule. So the plan spends its effort on four
contracts and keeps the first app to what the spec needs.

| Contract | What it fixes | Where |
|---|---|---|
| The ask | One shape for everything Life puts to the owner: an imperative line, who it is about, one line of why, a body, answers with one recommended, suggested follow-ups | `memory/card-request.ts`, `decisions.jsonl` |
| The answer | Life's words as Markdown with Life's own components inside, streamed, checked against their sources | `desk/main-session.ts`, `records/main-session-wire.ts` |
| The Life thread | One read that gives the conversation and every thread item in its one state | a new `read_thread`, the desk's store |
| What the owner wants | The owner's instructions, scoped and dated, read by one reader everywhere | a new `memory/instructions.jsonl` |

## The recommendations, in one page

Each has its reasons in [`positions.md`](positions.md).

1. The gate on every agent's ask: yes, but not inside the main session's own session. A tool-less model call reads
   the card with what Life knows (the instructions that apply, what is open, the last exchanges, the hour) and
   returns four separate readings: importance, urgency, whether now is a good moment, whether the owner can act now,
   plus an optional note for the agent. Code alone turns them into deliver, hold or send back, inside fixed limits.
   The owner's own question never waits behind a card, and each verdict is a record a later learner can read.
2. "How am I doing?": yes, as two marks under an answered ask, at most once a day. Not a four-step scale.
3. Agents together: the main session reads an assignment's record at once, and can ask its agent one question and
   wait up to 60 seconds. No free agent-to-agent chat. From OpenBot: queue and cancel for Ask Life, the required
   reply, bounds by count.
4. Nod: 19 items now, 11 later, 8 no ([`nod.md`](nod.md)). The trust engine and the sandbox are later, in a security
   plan of their own that must land before any other person's Life gets agents.
5. Projects and matters: matters stay, as Life's reading and the one visible structure. Projects become a label.
   Who acts stops following where a matter was filed: a project has an agent only when it has a repo; everything
   else, life admin included, goes to the one Personal agent.
6. Personalization: the owner's instructions in one append-only file with one reader; delivery rules enforced by the
   code that notifies; the decision records keep what learning will need. No learner in v4.
7. Direct and smart mode: v4 ships smart mode only. Direct mode comes later; v4 builds its two prerequisites that
   are useful anyway (a notice when Life can't be reached, per-person rules).
8. Settings: no settings to browse. The thread is the setting, a person's profile shows what was set for them, and
   one small page keeps devices, sending and the monthly amount.
9. How answers are drawn: components the session composes from Life's own catalog, written as fenced blocks inside
   its Markdown. Not fixed whole blocks, not generated HTML, not A2UI.

## How the pieces work

### The ask (PR 3)

A card gains three fields the asking agent must write, refused when missing as a plan card's steps are today: `ask`
(a short imperative line, "Pick a clinic for the scan"), `recommended` (the option id drawn full width) and `follow`
(up to three suggested next asks, written as the owner's own words). The `asked` line also keeps the matter's id
(#842) and the ids of the instructions the agent was given. A card that replaces an earlier one says what changed
(`deadline`, `condition`, `option`, `message`); without it the same subject is never asked twice.

A reply needs no plan card: the draft is the ask, and Send is the yes. The plan card stays for work of several
steps or work that costs money. "Draft an answer for X?" is therefore never asked for a reply (two asks for one
message is load); it remains the plan card of longer work.

### The answer (PR 4)

The main session's final text is Markdown. A component is a fenced block in it, named by the catalog:

````
Twelve bags, 4,820 ฿ in all.

```life:table
{"from":"life:file/receipt-7f2","columns":["Bead","Bags"],"rows":[["Tila",19],["Half Tila",14]],"total":33}
```
````

Words stream as they come; a block is checked when its fence closes (its shape by zod, its `life:` refs by
`findRef`, each number and name against the text of `from`) and is drawn only then. A block that fails is dropped
and recorded as a miss with what was wanted; the words still stand. A question is a last block, `life:question`,
of one of the spec's seven kinds; an answer that starts work carries `work: true`.

This removes the `answer` tool and its extra round trip, and removes `show`. The catalog starts with the seven
drawn components (`text` is the Markdown itself; `items`, `pictures`, `table`, `phrase`, `document`, `place`) and
`question`. The phone sends the catalog version it draws; the brief lists only that version's components. A new
component is one zod schema, one SwiftUI view and one line of the brief.

While it works, Life sends steps, `{verb, what}`, written by code from the tool and its arguments (the table in the
[chat-first plan](../2026-11-23-chat-first-app.md)), never by the model. A second ask while one runs is queued
(pi's `follow_up`), and Stop cancels (pi's `abort`); both exist in pi's RPC and only the runtime contract lacks them.

### The Life thread and thread items (PR 5)

The Life thread is a read, not a new copy of anything. `read_thread` merges, by time and a few days per page:
the owner's asks and Life's answers (new: one row per main session ask in the desk's store, with the answer's
blocks and the refs it cites), the asks as they were delivered and answered (`decisions.jsonl`), and Life's own
checks. With them it returns every thread item the page names, each in one state worked out by one function,
`itemStateOf`, from what is stored:

| State | Read from |
|---|---|
| Needs you | an open check (`checksNow`) |
| Later | the latest `deferred` correction (new), until its time or place |
| Under way | the owner answered and the asker's turn runs, or work a question started |
| Waiting on someone | the matter's status (`matterOf`) |
| Settled | the `answered` line and its outcome (`sent`, `ended`, `added`, `ran`) |
| Outdated | a `withdrawn` line, with its reason |
| Queued | the phone alone: answered while offline |

Nothing stores an item's state. The phone polls `read_thread` with its version stamp every 3 seconds while open
(an unchanged read is one small answer, as today); a socket waits until a measure asks for it. An answer finds its
check by its ref's kind instead of reading the whole inbox (#722).

Later is the owner's tap with no menu: Life picks the time (tomorrow 9:00, or before the deadline if that is
sooner; for a fix at the Mac while away, on arrival home, through the `places` channel that exists). Another time is
said or typed, and the field suggests two. Later is stored the same way for every check, an agent's card or one of
Life's own: one `deferred` correction keyed by the check's subject, the owner's single line as `your-move-not-now`
is today, which it replaces. It is not a line of `decisions.jsonl`. Adjust is the same idea: with a draft unfolded, the owner says the change
and the main session asks the replacement card on those words.

### Delivery (PR 7)

Every agent's card passes the gate before it reaches the owner. Code's limits, never the model's: a card is never
held past three hours before its deadline; never held more than 12 hours; sent back to its agent at most once; a fix
ask and a follow-up to what the owner just did skip the gate; a gate call that fails or takes more than 10 seconds
lets the card through. Cards waiting are read in one call. Each verdict is one `delivered` line beside the card,
with the four readings, the rules that applied and the position it was shown at: a record of what was shown, never
read back to order anything. A card sent back wakes its agent with facts only (`decision.returned`, the card's id);
the agent reads the gate's note at its door, as data, the way a contested draft is read today.

Smart mode is three of those rules. An agent may draft a reply as soon as the arrival reader confirms the message
needs the owner; the gate holds the card until the owner's usual reply time for that person has passed
(`exchange-counts`), and Life withdraws it if the owner answers in the chat first (it does today). Drafts are for
people who have a page, unless an instruction says otherwise. The owner's own promises wake their agent a few hours
later, not within minutes (#785).

What is broken and needs the owner is a fix ask written by code from a fixed list (a bridge signed out, the budget
about to be passed), never by a model: only code can promise that a step is one Life can really do. The spec gives
this to the caretaker; the plan differs, and the caretaker keeps what is not on the list. A failed health read is
never a fix ask: unknown is not broken.

When the Mac itself stops, nothing on the Mac can say so. The phone arms a local notification three hours ahead
("Life hasn't checked in since 14:10") and every contact from the Mac, a silent push every 15 minutes included,
moves it further. Nothing new leaves the Mac. Its limit: a silent push goes at priority 5, which iOS may hold or
drop (`apns.ts:271-280`), and none arrives after the owner force-quits the app. So the notice can be wrong, and
three hours is the price of making that rare; it says "hasn't checked in", not "is down", opening the app checks
at once and takes it away, and after a force-quit it fires once and is not armed again until the app is opened. An
outside checker is faster and surer, and belongs with direct mode.

The monthly amount is one setting. Life projects the month from billed spending, asks once before passing it
(a fix ask: raise it, or keep it and slow down), then slows hand-outs and background work, and never stops
recording or answering. Subscriptions do not count: they do not grow with use. An assignment that passes 3 dollars
stops starting turns and asks whether to go on.

### Undo (PR 8)

Undo is an attempt. For an answered card it appends `answer-withdrawn`, and the desk stops the asker's turn if it
still runs. "The agent acted" has one test: the turn the answer woke has made a tool call (the desk sees each one's
start), or the card has an outcome line (`sent`, `added`, `ran`, `ended`). Before that the undo holds; after it the
undo is refused with what was done. A send has none. Later is lifted by a `deferred` correction with no time; an event added from a card is removed; an Apify run is aborted and what it spent is
said.

### Agents together (PR 9)

`tell_agent` gains a reply: the main session asks the agent that holds a matter, the desk gives that agent one turn
(cause `main_question`), and its answer comes back as data within 60 seconds, shown as one step ("Checking on the
boiler"). It is data like every read the main session makes: its acts still take `said` from the owner's words of
that ask alone. Past the limit Life answers from the record and the reply lands in the thread when it comes. Before any of
that, the main session reads the assignment's record (its wait, its reason, its notes, its open cards), which
answers most "where are we" questions at once.

A standing intention ("call Sam about once a month") is an instruction plus one assignment of the Personal agent
anchored on it, waiting on events with that person and a date. Its nudge is an ordinary ask through the gate.

## Where the prototype differs from the spec

The build follows the spec in each case.

| Prototype (`shell.html`) | Spec |
|---|---|
| The microphone toggles on a tap and types a fixed phrase | Hold to talk |
| No failure on a button | "Not sent" (tap again), "May have gone", "Already answered: Sent" |
| Under way always ends after 2.8 s | A limit, then back to needs you with one line of why |
| Later is always tomorrow 9:00, with no way to say another time | What Later offers is open (question 8) |
| Rows inside an answer are static | Live items in their states |
| An answer that starts work shows a row with a line | Work that would send becomes an ask with its draft |
| A document is an inline receipt | A real document opens in the system viewer |
| Reopen adds the owner's bubble and a copy | Reopen brings the ask back, no bubble |
| Only the WhatsApp fix has an away variant | Every fix at the Mac offers "Remind me when I'm home" when away |
| A fix lands at the bottom once the owner is free | The thread opens on what is broken |
| The pendant button has no coral state and is not tied to the pendant fix | Coral when it needs the owner |
| A words question only rotates suggestions | The field starts the sentence with Life's suggestion |
| A notification answer shows the card before its answer | The card in its new state, then the bubble with the bell |
| No "I couldn't answer that." | Shown; a tap on the bubble asks again |
| No Settings | Open; settled in [`positions.md`](positions.md) |

## The build

Ten PRs. The server track is one line, because most PRs touch `desk/desk-door.ts`, `memory/decisions.ts` or the
runtime; the phone track runs beside it. Every server PR below is on strict paths and keeps the full workflow: plan
review, the debt verdict and a confirming round.

`bun run check` builds the iPhone app and runs the Kit tests (`scripts/check.ts:103-124`), so "the phone app may
stay broken" means this: from PR 2 to PR 6 the app compiles, passes the check and does nothing useful. It never
means a red build. Two rules follow. PR 2 lands before PR 4, since both edit Kit's wire models. And every server PR
that changes the wire updates Kit's decoders and the fixtures under `apps/lifelog/fixtures/wire/` in that same PR
(PR 4: `AskLife.swift`'s `show`, and the fixtures of the four tools it removes). PRs 7 to 9 add only optional
fields, which Kit's tolerant decoders ignore; the Swift that uses them lands in files PR 6 does not own, or after
its part.

| | PR | Track | Can run beside |
|---|---|---|---|
| 1 | Ground: measures, the failing tests, names | server | 2 |
| 2 | The old phone screens go | phone | 1, 3; lands before 4 |
| 3 | Asks: the card contract, instructions, fresh wakes | server | 2 |
| 4 | Answers and the runtime | server | — |
| 5 | The Life thread and thread items | server | — |
| 6 | The first app (two stacked parts) | phone | 7 server half, 8, 9 |
| 7 | Delivery: the gate, pushes, fix asks, the budget | server, then the notification extensions | 6 (other files) |
| 8 | Undo | server | 6 |
| 9 | Agents together | server | 6 |
| 10 | After v4: Codex on demand (#869), then the desk renamed (#655) | server | — |

Tests owed are written to `docs/plans/tests-owed.md`, one line per test with its PR. PR 1 creates it and PR 2
does not touch it (PR 1 carries PR 2's one line), so the two never meet in a file. A glossary line lands in the PR
that adds its concept. No app tests
while the product moves, except the Kit tests that decode the server's own JSON, which are regenerated, not written.

### PR 1. Ground

It records, for every main session ask, the time to the first step, to the first words and to the whole answer,
each tool call's time and result size, and the model's time (`pi-runtime.ts` already sees every event); and for
every turn, the tokens the tool schemas cost. It adds a question bench: 12 made-up questions on the demo Life
(`bun run e2e:demo`), graded by `judge` and `tally`, and a set of 20 made-up cards graded for ask quality. It runs
the suite once and settles each of the 7 failing tests by name in its description: fixed, or deleted with the code
it tested. None is skipped. #846 is fixed by the test making its own people; #1150 by building the fake agent once
before the test; #766 is closed if `510d5dfa` is on main. It closes #1006 after checking #1093 landed.

Deletes: nothing but dead tests. Invariants: none. Migrations: none. It settles #1030 in the glossary only: "agent
move" and "exchange move", "assignment subject" and "read subject", the two "action step" rows merged. Tests owed:
#767's fourth item, a cold-cache assertion in `lifelog-voices.test.ts`, written down for PR 2.

### PR 2. The old phone screens go

It lands before PR 4. Deletes about 13,500 Swift lines: `Inbox/`, `Matters/`, `People/`, `AskLife/`, `Profile/`, the old `Shell/`,
`Fixtures/`, most of `Settings/`, `AppRouter`, `ReadScreen`, the design-system pieces only they used, their wire
models (`RegisteredAgent`, `AgentSession`, `AgentMove`, `YourMoves`, `Project`, `MatterThread`, `ModelSpending`,
`WakeLine`), and their entries in `scripts/design-system.test.ts`. It keeps the pendant pipeline, the notification
extensions, pairing, `LifeStore`'s connection and write paths, `DraftBlock`, `DictationField` and the tokens. What
is left compiles, passes the check, and opens on pairing, the pendant sheet and an empty thread. The server still
writes the fixtures of tools it has not removed yet; Kit simply stops decoding them, and PR 4 removes both.

Its description closes #712, #938, #934, #928, #849, #1010, #1266, #823, #767, #651, #1341, and the phone-only
debt issues it makes moot: #984, #1001, #1084, #1105, #1109, #1126, #1087, #1179, #1245, #979, the phone parts of
#1243, #820, #620 and #1288. Each is checked against its text before closing; #767's fourth item is in
`tests-owed.md` by PR 1. The server halves of #938 and #928 are dropped: v4 has no
project page and no move-back control. Invariants: none. Tests owed: none.

### PR 3. Asks: the card contract, instructions, fresh wakes

The card gains `ask`, `recommended`, `follow`, the matter id (#842) and what changed since the card it replaces;
`CARD_SELF_CHECK` gains the line "check you can't do it yourself first" (#784, step 1). An assignment whose whole
work is one reply may ask its draft as its first card. Wakes on the owner's own promises are delayed three hours
(#785), and the brief tells an agent to read the chat first and wait when the owner is mid-conversation.

`memory/instructions.ts` is new: `recordInstruction` appends one line (id, scope: a person, project, matter,
channel or everything; the text; an optional effect from a closed list: `quiet`, `interrupt`, `drafts`,
`no-drafts`, `intention`; `until`; `replaces`; the owner's words as `said`), and `instructionsFor` reads the ones
that apply. Within a scope, "ask first" and "never" beat a grant, and a correction narrows what it addresses, never
more. The main session writes one through its door on the owner's words, and the connector on the owner's token.
`MAIN_BRIEF`'s "two short sentences" becomes the default an instruction can replace; agents' packets and drafts
read the same reader. It also carries the audit of the settling pass that left a paid bill "overdue", with its
regression case.

Deletes: the plan card forced on one-reply work. Invariants, for the owner (questions 4, 5, 15 and 16): the
first-turn rule gains its third exception; `memory/instructions.jsonl` joins the append-only files, lock-free, one
writer; the connector and the main session's door each gain the instruction writer. Glossary: instruction.
Migrations: none (new optional fields on lines that truly lack them). Tests owed, all written in this PR since
they are memory and desk: the refusals of the new fields, the reader's scope and precedence, expiry, the delayed
wake.

### PR 4. Answers and the runtime

The answer becomes Markdown with fenced blocks, checked and streamed as above; steps replace `working` lines; the
`answer` and `show` tools, `MainSessionShow`, `keepShow`, `LIST_ROWS` and `showProblemOf` go. The runtime contract
gains `queue` and `cancel`, and `ask_main_session` a cancel call. Effort follows the turn: the main session at
medium, background turns at high as today, on the same model (DeepSeek Flash 4.1 1017, already the default route).

From Nod, each small ([`nod.md`](nod.md)): any tool result over a size is kept in a file and the model gets a
preview and a reference; tool results are wrapped as data with the delimiter neutralised; a dangling tool call in
a session file is closed as "interrupted, outcome unknown" before the session is resumed; compaction numbers follow
the model's window; a provider that keeps failing pauses background turns with a growing delay while the owner's
own asks still try; a model silent for 30 seconds is retried; a turn stops after five failed calls of one tool.
The send guard reads every tool call, not only shell and MCP ones. Then, only if PR 1 shows tool schemas above a
fifth of a turn's uncached input: the rarely used tools are deferred through pi's tool search, after a test proves
the guard sees a deferred call by its name. CodeMode stays off.

Deletes: about 400 lines of `show` and its checks, and the connector tools only the old app used
(`read_projects`, `read_project`, `read_agent_session`, `read_log_lines`), with whatever fallow then reports dead.
Invariants (question 11): the registered-agents invariant's list of the main session's door loses `answer` and
`show`; "what his phone shows with the answer" becomes "the blocks of its answer, each checked when shown"; the
connector's `ask_main_session` gains a cancel (question 15). Kit and the fixtures change here, as above.
Migrations: none. Tests owed, written here: the block checks (a wrong number is dropped), the guard on a non-MCP
tool, cancel and queue on the fake runtime, the session repair.

### PR 5. The Life thread and thread items

One desk store step adds `thread_entry` (the ask's key, the owner's words, the screen's refs, the answer's Markdown
and the refs it cites, the times). `host/` gains `readThread` and `itemStateOf`; the connector gains `read_thread`
and `answer_check` takes `later`, which writes the `deferred` correction for any check; `your-move-not-now` becomes
`deferred` by one migration, so there is one Later. A draft card
asked on the owner's words replaces the open card into that chat at once (Adjust). `openCheckOf` reads one check
by its ref's kind (#722), measured before and after. The count's shortcut ("What's waiting on me?") is built by
code from the same read.

`deleteFromMemory` reaches the thread: an entry whose answer cites what was deleted is hidden at read, and its
preview counts them.

The order stays `inboxOrderOf` as it is, ranks by kind included, until the gate decides (PR 7).

Deletes: `your-move-not-now` and its readers' own Later (`memory/your-move.ts`, `memory/answer-check.ts`,
`host/correct-matter.ts`). Invariants (questions 10, 11 and 15): the Life thread lives in the desk's store, never
`memory/`; a deletion reaches it; the draft-contest rule gains "a card asked on the owner's words replaces the open
one at once"; `answer_check` takes Later for any check. Migrations: one desk store step, `stepThread`, with its
dated copy; one migration of `corrections.jsonl` renaming `your-move-not-now` lines to `deferred` (same count, same
order), on the owner's yes to the list (question 12). Glossary: Life thread, thread entry, thread item, deferred.
Tests owed, written here: the store step, the migration, `itemStateOf`'s table, the deferred correction, the
replacement, deletion hiding an entry.

### PR 6. The first app

Part one: the thread (the owner's bubbles, Life's Markdown inking in, day separators, Show earlier), the field
(typing, hold to talk through `DictationField`, Stop), the edge, the two round buttons, thread items as rows that
unfold with one shape for every ask (bodies: draft, options, payment, call, event, plan, fix, waiting), answering
with its states on the button, Later, the steps line, and the offline queue. Part two: the seven components and
the question controls, the profile overlay with its code-only sections, the small settings page (devices, Face ID
before Send, the monthly amount), reached by asking or from the pendant sheet, and the notices.

Left out of the first app, each additive later: the suggested asks from a second model run (the field rotates the
open item's `follow` and code's fixed three), "where things stand" on a profile (question 13), light mode, the
open Duo, haptics. It needs the owner's exception for the edge written into `docs/brand.md` first (question 14).
Deletes: nothing more. Tests owed: listed in `tests-owed.md`, none written (thread paging, item state rendering,
the offline queue's re-check, each component's limits).

### PR 7. Delivery

The gate, first in shadow: for one week it records its verdicts and changes nothing, and its verdicts are read
against what the owner did. Then it decides. With it: `delivered` lines; the push as the ask (the ask line as
title, who and when, the draft, the main answer and Later); pushes only for cards the gate delivers now; quiet and
interrupt effects enforced in `levelOf`; smart mode's hold; fix asks by code; the heartbeat push and the phone's
armed local notification; the monthly amount and its ask; the 3-dollar stop on an assignment; the two marks of
"How am I doing?" and their `rated` line.

Once the gate leaves shadow, the order of what waits becomes broken first, then deadline, then the gate's
importance, and `inboxOrderOf`'s ranks by kind go. The hand-out keeps its pace as it is (`desk.handOut`, both
`aDay` and `cardsWaiting`, `paceRefusalOf`): the gate times when a card reaches the owner, the pace limits how much
work starts, and `cardsWaiting` now counts the cards the gate holds too.

Deletes: the `notifications` setting (levels per kind), replaced by the gate and instructions; the ranks by kind;
`pushNewCards`' grouping of Life's own checks, which stop pushing. Invariants (questions 1, 2, 12, 17 and 18): a
model's reading may hold an agent's card or send it back once, inside code's limits; the main session stays woken
only by the owner's words; fix asks are code's; `decisions.jsonl` gains the writers of `delivered` and `rated`;
"every new open card pushes once, whatever its kind" becomes "an agent's card the gate delivers now pushes once;
Life's own checks do not push". Migrations: one settings step dropping `notifications`. Glossary: gate, fix ask.
Tests owed, written here: the gate's limits as a pure function (deadline, 12 hours, once back, fail open), the
level rules, the fix list, the budget's projection.

### PR 8. Undo

`answer-withdrawn` and its writer; the desk stops the asker's turn; refusals with what was already done; removal
of a card's calendar event; the Apify abort. Invariants (questions 9, 15 and 17): "a repeat of an answered
decision's same answer gets its first result, another answer is refused" gains "until the owner withdraws it";
`decisions.jsonl` gains the writer of `answer-withdrawn`; `answer_check` takes the undo. Migrations: none.
Tests owed, written here: withdrawal before, during and after the asker's turn; a send never withdrawn.

### PR 9. Agents together

`tell_agent` with a reply; the assignment's record as a read for the main session; `finish` and `set_wait` refused
while the owner's words to that assignment are unread; the list of tools a subagent never gets, checked and written down; a project's agent only when
the project has a repo (`agentForOf`), the fold following it; the standing intention as an instruction with its
assignment. If question 7 is a yes: the Personal agent runs one session per assignment. #713 is settled here by
doing instead of asking: an idle agent is ended by the desk, the pace is the gate's, and Life never suggests
changes to projects, agents or pace (they are Life's insides); the bridge to relink is PR 7's fix ask.

Deletes: the routing of non-repo projects to their own agent. Invariants (questions 6, 7 and 16): the main
session's door gains the record read and `tell_agent`'s reply. Migrations: a desk
store step only if question 7 is a yes. Tests owed, written here: the reply's limit, the routing rule, the refused
`finish`.

### PR 10. After v4

Codex leaves Life.app and is fetched on demand (#869); pi is already the built-in runtime. Then, once the desk is
quiet, #655: the desk becomes the dispatcher in one mechanical PR with its migration, on the owner's yes to the
list (question 12).

### Later, not in v4

AI phone calls (#1274), any bank (#1271), Connect Google (#1377), the parked #982, #981 and #983, Claude Code and
Codex parity (#748), the Life plugin's naming (#1016), direct mode, Mac admin access, the security plan (trust
checks, a gate on what the owner started, a sandbox for other people's Lives), learned procedures, browser and
desktop control as tools, the prediction layer's learner.

## Speed and cost

| Measure | How it is measured | Today | Target | Moved by |
|---|---|---|---|---|
| Time to first useful answer | Per ask, from the phone's send: first step, first words, whole answer (PR 1) | 15 to 36 s warm, over 60 s cold, whole answer | First step within 1 s, first words within 3 s (half of asks) and 6 s (nine in ten), a lookup whole within 10 s; a cold start adds at most 3 s | PR 4 (no `answer` round trip, words streamed, medium effort, bounded results), PR 9 (the record read before any agent turn) |
| Cost per completed task | Billed spends of an assignment's turns, at its close (`spendsOfTurn`, by assignment); per ask, its turn's | Not reported per task | An ask under 1 cent (half of asks); a one-reply assignment under 5 cents (nine in ten); any assignment stopped at 3 dollars; the gate under 0.2 cent a card | PR 1 reports it; PR 4 (schemas, bounded results), PR 7 (the stop), PR 9 if sessions go per assignment |
| Task success rate | Asks: share answered with the recommended option, share sent back by the gate, share withdrawn. Answers: the bench's points held, blocks dropped by the checks | Not measured | Recommended option taken on 7 asks in 10; the bench holds 9 points in 10 with no wrong number shown; at most 5 pushes a day for half of days | PR 3 (the contract), PR 4 (the checks), PR 7 (the gate) |

PR 1 sets each baseline on the owner's real Life before anything changes; a PR that claims a measure reports it
before and after.

## The owner's questions

Only what is the owner's to decide. Each has the recommendation first.

1. The gate as its own call. Recommended: yes, as described, after a week in shadow. Yes: an agent's card may be
   held up to 12 hours or sent back once on a model's reading, inside code's limits, and the main session stays
   woken only by the owner's words. No: cards keep reaching the phone by code's fixed order. The other form, a turn
   of the main session per card, makes the owner's own question wait behind cards. The gate's note to an agent is a
   model's words about a card: the wake still hands facts only, and the agent reads the note at its door as data.
2. "How am I doing?" as two marks, at most once a day. Recommended: yes. Four steps asks for a judgement where a
   yes or no is one glance; say so if four is wanted anyway.
3. Direct mode later. Recommended: yes, later. In v4 it would make one sleeping Mac the cause of every missed
   message.
4. A reply needs no plan card, and drafts are for people who have a page. Recommended: yes. It changes the
   first-turn rule in `AGENTS.md`. No: every arrival asks twice.
5. The owner's instructions live in `memory/instructions.jsonl`. Recommended: yes. They are dated lines that expire
   and replace each other, which `truth/` (who and what, strict, hand-edited) is not built for. The other answer
   puts them in `truth/` behind `changeDirectoryEntry`.
6. A project has an agent only when it has a repo. Recommended: yes. Home, a bill, the dentist all go to one agent,
   whatever they are filed under. No: who acts keeps depending on filing.
7. One session per assignment for the Personal agent. Recommended: decide on PR 1's numbers; yes if a Personal
   turn carries more than twice the context of a project agent's turn. It reverses "one agent, one session"
   (20 Nov) for that agent only.
8. Later with no menu. Recommended: Life picks the time, another time is said. The note in #1373 asked for several
   choices; a menu makes every Later a decision. Yes to the menu adds a sheet of four times.
9. An answer can be withdrawn (Undo). Recommended: yes; it changes the decisions invariant's "another answer is
   refused".
10. A card asked on the owner's words replaces an agent's open card into the same chat at once (Adjust).
    Recommended: yes. No: Adjust waits up to 10 minutes on the draft contest.
11. The Life thread is stored in the desk's store, deletion reaches it, and the main session loses `show`.
    Recommended: yes.
12. Stored changes to approve: the desk store step `stepThread` and the migration renaming `your-move-not-now` to
    `deferred` in `corrections.jsonl` (PR 5); the settings step dropping `notifications` (PR 7); after v4, the
    rename of the desk to the dispatcher with its list (#655). Recommended: yes to the first three now; the
    rename's list comes with its PR.
13. "Where things stand" on a profile, written in "you". Recommended: a short display version written each night
    beside the situation, for people whose situation changed, and one first run for everyone with a page. It is a
    new output of a prompt and a run on the owner's quota; until the yes, the profile ships without that section.
14. The edge's exception in `docs/brand.md` (a border, motion by itself, Life's blue). Recommended: yes, worded as
    the spec has it. PR 6 waits on it.
15. The connector's invariant ("never add a tool that sends or edits anything else") gains four things, all on the
    owner's token only: the instruction writer (PR 3), a cancel on `ask_main_session` (PR 4), Later for any check
    through `answer_check` (PR 5), and the two marks and Undo through `answer_check` (PR 7, PR 8). Recommended:
    yes. None sends anything.
16. The main session's door, listed today as exhaustive ("nothing else of the door"), gains the instruction
    writer with `said` (PR 3), the read of an assignment's record, and `tell_agent`'s reply (PR 9). An agent's
    reply and notes then enter the main session's context as data, as every chat and mail it reads already does.
    Recommended: yes. No: "where are we with the plumber" is answered from the matter alone.
17. `decisions.jsonl`'s listed writers gain three: the gate's `delivered`, the owner's `rated`, and
    `answer-withdrawn`. Each is one synchronous append; no line is rewritten. Recommended: yes.
18. The push rule changes from "every new open card pushes once, whatever its kind" to "an agent's card the gate
    delivers now pushes once; Life's own checks (a voice, a name, the same person) wait in the list and do not
    push". Recommended: yes. No: those checks keep pushing at their kind's level.

## Debt plan

Tier: hard: `desk/`, the connector, the send paths, writers of `memory/`, a desk store step and a settings step.

Inventory: [`2026-11-25-overhaul-code-facts.md`](../2026-11-25-overhaul-code-facts.md) holds the checked facts.
What already defines or decides what v4 touches: the main session's brief, `show` and its checks
(`desk/main-session.ts:62`, `:126-188`; `desk/desk-door.ts:520`), its wire (`records/main-session-wire.ts:46`),
one ask at a time (`main-session.ts:311`); the runtime contract with no queue or cancel
(`desk/runtimes/contract.ts:55-101`), pi's RPC that has them, one route for every pi turn (`models/llm.ts:155`),
tools all direct (`pi-extension.ts:239`, `:245`), the guard's filter inside pi (`pi-extension.ts:280-290`,
`desk/send-guard.ts:32`); the card's shape and refusals (`memory/card-request.ts:57`, `:83`,
`memory/card-problems.ts`), the decision lines (`memory/decision-lines.ts:19-50`, kinds at `:29-130`), the order
and the push (`memory/check-urgency.ts:18`, `:129`; `host/card-push.ts:42`, `:86`, `:193`), the inbox read an
answer makes (`host/inbox.ts:27`); who acts (`memory/held-matters.ts:59`, `memory/read-matters.ts:365`, `:453`,
`desk/matter-net.ts:464`); idempotent wakes, already there (`desk/desk-store.ts:126`); settings read once
(`core/settings.ts:221-225`); the places channel (`host/event-channels.ts:225-244`); the phone's silent push
(`apps/lifelog/apps/server/src/apns.ts:271-280`). Searches run: `rg "your-move-not-now"`, `rg "ASKS_KEPT"`,
`rg "follow_up|steer|abort" desk/runtimes`, `rg "Bash\|mcp" desk`, `rg -i "unique" desk/desk-store.ts`,
`rg "cardsWaiting|budget" core/settings.ts`.

Shape: four sources of truth. The ask is `Ask` in `memory/card-request.ts`, reshaped first (PR 3) so the gate, the
push and the phone read the same fields. The answer is the main session's Markdown with blocks, one parser and one
catalog in `records/`. A thread item's state is `itemStateOf` in `host/`, the only place that names a state; the
Life thread is a read over the desk's `thread_entry` and `decisions.jsonl`, never a second copy. What the owner
wants is `instructionsFor` in `memory/instructions.ts`, the only reader. The gate is one pure function over the
model's four readings.

State: `memory/instructions.jsonl`, per instruction, written by `recordInstruction`. `thread_entry` in the desk's
store, per ask, written by the desk. Three new line kinds in `decisions.jsonl`, per card: `delivered` (the desk's
gate), `answer-withdrawn` and `rated` (the owner's taps, through `answer_check`). One correction kind, `deferred`,
per check, replacing `your-move-not-now`. One setting, the monthly amount, global. On the phone: the offline queue
and the armed notification, per device. Nothing stores an item's state or a count, and nothing reads a stored
order: `delivered` keeps the position a card was shown at as a record only.

Deletes: the old phone screens and their wire models (about 13,500 lines); `show`, the `answer` tool and their
checks; four connector tools only the old app used and what fallow then finds dead; the order's ranks by kind;
the `notifications` setting; `your-move-not-now`; the plan card on one-reply work; the routing of non-repo projects.

Net lines: about +9,700 / −15,800 (phone +5,500 / −13,500; server +4,200 / −2,300).

Plan review: reshape, fixed in place. Every finding was checked in the code and held; none is contested.
Blocking. (1) The check builds the app and runs Kit (`scripts/check.ts:103-124`; `AskLife.swift:99` decodes
`show`; the fixtures exist): "broken" now means compiling and unused, PR 2 lands before PR 4 and runs beside PRs 1
and 3 only, and each wire change carries its Kit and fixture changes. (2) Four invariant changes had no question:
added as 15 (the connector's tools), 16 (the main session's door), 17 (`decisions.jsonl`'s writers) and 18 (the
push rule). (3) The claim that card text must not share a context with acts was wrong on its own terms, since the
main session already reads other people's messages as data under `said`; it is removed, the gate now rests on
speed and on its records, an agent's reply is named as data in question 16, and a sent-back card wakes its agent
with facts only, the note read at the door (question 1). (4) The order's change moved from PR 5 to PR 7, with the
gate. Lesser. Later is one `deferred` correction for every check, replacing `your-move-not-now` by a migration
(question 12), and is no longer a line of `decisions.jsonl`; `tests-owed.md` is PR 1's alone until PR 2 has
landed; a glossary line lands with its concept; the heartbeat's window is three hours and its false alarm is
stated (`apns.ts:271-280`); the shown position is a record, never read back; "the agent acted" is a tool call of
the woken turn or an outcome line; `desk.handOut.cardsWaiting` stays and counts held cards too
(`desk/hand-out.ts:21`), so the settings step drops `notifications` only. Shape: no PR added or removed; the order
changed only by PR 2 before PR 4 and the order's change moving to PR 7.
