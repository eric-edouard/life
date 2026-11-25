# Life v4: where the plan stands, and why

Explanation: the reasoning behind each recommendation of [the v4 plan](README.md), on every "to weigh", open
question and note of issue #1373, on issue #1376, on Settings, on how answers are drawn, on the pi audit and on the
open issues. Each section ends on its recommendation and the PR that carries it.

## The main session gates every ask

The idea is right about the goal: something that knows the owner's load should stand between an agent and the
owner's attention, and the fixed order by card kind is not that. It is wrong only about where to run it. Three
facts from the code decide.

The main session takes one ask at a time (`desk/main-session.ts:311`). A turn per card would make the owner's own
question wait behind cards, on the session whose speed matters most. Its session would also grow by every card
ever asked, which every later answer then pays for. And what the main session "knows" is not in its head: the
owner's instructions, what is open, the last exchanges and the hour are all records that code can hand to any
call. Safety is not the argument: the main session already reads other people's messages as data, and `said`
protects each of its acts whatever it has read.

So the gate is a model call with no tools (as every memory step is), given the card as the phone would show it and
that packet. Following Nod's proactivity design, which holds up in its code (`src/server/proactivity.ts`), the model
does not decide delivery. It returns readings: importance, urgency, whether now is a good moment, whether the owner
can act now, and an optional note to the agent (a clearer question, a better draft, something the agent can settle
itself). Code turns the readings into deliver, hold or send back. This keeps the four measures apart, as the
personalization research asks, and it means a model cannot talk a card past a limit.

The limits are in the plan (never held past three hours before a deadline, 12 hours at most, sent back once, fail
open in 10 seconds, fix asks and follow-ups skip it). Cost: cards waiting are read in one call on the fast tier,
under 0.2 cent a card at today's prices. A card sent back wakes its agent with facts only, and the agent reads
the gate's note at its door as data, so it learns within its session and no wake carries words. Every verdict is a `delivered` line. Issue #784's steps 2 and 3
(a draft check and a "could you do this yourself?" check at Life's door) are this gate's send-back and are not
built apart.

It runs in shadow for a week first: verdicts recorded, nothing changed, then read against what the owner did with
each card. Recommendation: yes, in this form (PR 7, question 1).

### "How am I doing?"

Worth having, because it is the only signal that says whether asking at all was right; an accepted first option
only says the option was fine. Two marks, not four: a four-step scale asks the owner to grade, which is thinking,
and its extra resolution serves the builder. Code samples it: at most once a day, never on two asks in a row,
never within an hour of a deadline, twice as likely for an asker's first five cards. No answer writes nothing and
changes nothing. An answer is a `rated` line with the ask as shown; in v4 it feeds one thing, the gate's packet
(the last twenty ratings as examples). The marks are a thumb up and a thumb down, no words. Recommendation: yes
(PR 7, question 2).

## Agents working together

The gap the owner names is real: "Where are we with the plumber?" should reach what the agent knows. Most of what
it knows is already Life's record, by the owner's own rule that nothing rests on an agent's memory: the
assignment's wait, its reason, its notes file and its open cards. The main session cannot read those today. Giving
it that read answers the common case at once, with no agent turn.

When the record is not enough, `tell_agent` gains a reply. The words are the owner's (found in the ask, as today);
the desk gives the holding agent one turn; its reply returns as data, read like any chat the main session opens,
and no act can take its `said` from it. Sixty seconds, then Life answers from the
record and the reply lands in the thread later. One step on screen, "Checking on the plumber", never a name.

Free agent-to-agent chat: no. Content one agent read would travel to another with no record of where it came from,
and two agents would each believe the other owns the next step. Life's records are the shared channel, and the desk
is the only dispatcher.

From OpenBot, ideas only (its licence forbids its code): a busy agent's incoming message is queued or steers the
turn (Ask Life's queue and cancel, PR 4); delegated work needs an explicit reply and keeps its parent's owner (the
reply above; a question never moves an assignment); bounds by count (one open question per assignment). Not taken:
shared channels, reactions and file transfers between agents, its many runtimes (ACP is already there), agents made
from a prompt (the owner never sees agents), its embedded browser (later, behind the guard). Recommendation: the
record read and the reply (PR 9).

## Is Life too opinionated about projects and matters?

Partly, and the part that is can go.

Matters earn their place. They are Life's reading, not the owner's filing; they are what the thread shows as an
item; cards, done, dropped and deletion hang on them; and they bound what an agent reads. An agent that organised
its own work with no matters would have to rebuild the same thing in its notes, where the owner could neither see
nor correct it. On the default model (DeepSeek Flash), structure is also what makes a cheap model reliable. The
systems that let agents organise themselves, Nod included, track tasks in a table with one owner each and a unique
key per piece of proactive work: the same structure under another name, and none of them holds a person's whole
life.

Projects do not earn the routing they have. Which agent works on the plumber depends today on whether a Home
project exists and has an agent: a filing choice. The only real reason for a second agent is capability: an agent
that works in a repo needs that repo's folder, rules and session. So a project gets an agent only when it has
`repos:`; every other matter goes to the Personal agent, and "life admin" needs no concept. Projects stay as a
grouping the owner names when one helps, and the ruling that Ask Life can make a Home project stands: it makes a
label.

What this costs is one honest risk: one agent, one session, holding every life matter. Each wake would load
context from unrelated matters, which costs tokens and mixes one matter's messages with another's drafts. PR 1
measures it. If a Personal turn carries more than twice a project agent's context, the Personal agent should run a
session per assignment, with the desk still the only one that opens them. That reverses the 20 Nov ruling for one
agent, so it is the owner's (question 7).

What stays fixed by code: who acts, the gates, deletion, the audit trail, the owner's corrections. What an agent
works out itself: how to do the work inside an assignment, in its notes and with subagents, as today.
Recommendation: matters stay, projects become a label, routing by repo (PR 9, question 6).

Issue #713 (Life proposes changes to projects, agents and pace) is mostly a builder's view under this model: the
owner never sees agents or pace, so asking about them is load. The desk ends an idle agent itself; the gate
replaces the pace on cards; Life does not suggest filing. Its one user-facing part, a source that stopped, is the
fix ask.

## The personalization foundation

The research is right on sequencing: lay the contract now or the gate, the push and the drafts each grow their
own. It overreaches on the learner, which stays in the prediction plan.

Where instructions live: `memory/instructions.jsonl`, append-only, one line per instruction, the latest per id
ruling, written by one function as the owner's single lines already are (a correction, a fact-check answer). Not
`truth/`: that is the directory of who and what, strict YAML the owner may edit by hand, and a line that expires
on Monday and replaces last week's does not belong in it. Not settings: those are read once per process, so
nothing the owner can change by voice may live there. An append-only file read through `readAppended` is fresh in
every process at the next read, which gives "takes effect at the next turn or send" with no cache to invalidate.

An instruction has a scope, the owner's words, an optional end, the one it replaces, and optionally one effect from
a closed list that code enforces: `quiet` and `interrupt` (the push and the gate), `drafts` and `no-drafts` (smart
mode), `intention` (a standing intention). Everything else is text for a model to follow. The closed list is small
on purpose: an effect exists only when some code enforces it.

One reader, `instructionsFor`, given the people, project, matter and channel at hand. Its callers in v4: the main
session's brief, an agent's packet, a draft's start, the gate, `levelOf`. Precedence follows Nod's rule, which is
sound: within a scope a refusal beats a grant, and a later correction changes only what it addresses.

Inferred preferences get their place in the contract (a `source` of `said` or `inferred` on what the reader
returns) and no writer in v4. The decision records start keeping what a learner will need: `recommended` and the
instruction ids on the `asked` line; the four readings, the level and the position shown on `delivered`;
`answer-withdrawn` and `rated`; and the `deferred` correction. A standing intention is an instruction with an assignment, as the plan
says. Recommendation: as above (PR 3, PR 7, question 5).

## Direct and smart mode (#1376)

Direct mode asks the owner to silence every messaging app and trust one Mac to deliver everything within seconds.
Today a message takes up to five minutes to be read as an arrival, and a closed lid delivers nothing. Getting to
seconds is possible (the archive copies every 5 seconds; a push straight from the copy, with the phone reading the
message itself, would do it) but the failure case is the whole of the owner's messaging going silent, and the only
defence is a second path that does not exist yet. For a mode whose gain over the apps' own notifications is one
tidier lock screen, that is the wrong trade to make first.

Smart mode is where Life adds something no app does: one notification, hours later, with the reply ready. Its rule
is in the plan (the arrival reader's yes, a person who has a page, the owner's usual reply time passed, withdrawn
when the owner answers). The agent drafts early and quietly so the card is ready the moment it is due; wasted
drafts cost fractions of a cent.

Who Life answers for: people who have a page, by default; "never draft to my mother" and "let Life answer for
Sam" are instructions with the `no-drafts` and `drafts` effects. No setup card and no list of everyone, which the
settings board itself flagged as a chore. The words "direct" and "smart" never show.

v4 builds what direct mode would need and smart mode already wants: the notice when Life can't be reached, and
per-person instructions. Recommendation: smart only in v4; direct mode in its own plan (PR 7, question 3).

## Settings

The board's recommendations hold, cut to what the first app needs.

How the owner wants things: said in the thread (1B), answered by one line with Undo ("I'll keep the kitchen quiet
until Monday"); "what have I told you" is an answer that lists them. A person's profile shows what was set for
that person (1C), one more section fed by the same reader. No page of all choices (1A): it grows, and nobody opens
it.

Something broken: the fix ask comes first in the thread and in the count, and the count's button turns coral (2B).
The Mac itself down is the armed local notification (the board's 2C, done without an outside service; the mail path
needs one and would add to what leaves the Mac, so it waits for direct mode).

Mode: nothing to set (3A and 3C wait for direct mode).

What is left is one small pushed page: the Mac and the pendant with their state, Face ID before Send, the monthly
amount, and one row for the developer (diagnostics, kept code). It opens when asked for, and from a quiet mark at
the bottom of the pendant sheet, because re-pairing must be reachable when Life cannot answer. Face ID before Send
is a switch on that page only: turning a protection off by voice would need Face ID anyway, so Life answers that
request by showing the page.

## How answers are drawn

Four ways were on the table. The owner's real questions settle it: a bead order wants a table, a receipt its own
type, a phrase to show a shopkeeper, and no fixed set of whole blocks foresees the next one.

Generated HTML is out: slow, costly in tokens, and it gives up Dynamic Type, VoiceOver and the brand. Fixed whole
blocks are too few shapes. A2UI 1.0 now answers the earlier objections, but once Life's catalog replaces its basic
one, its acts become renderer-only and its data becomes refs, what remains is an envelope, paid for with a Swift
package still at 0.12, a build plugin Xcode must trust and a 200 MB checkout.

So: components composed from Life's own catalog, as the answer-components page proposes, carried as fenced blocks
in the Markdown the session already writes. That last choice matters for speed: there is no `answer` tool call
and no second round trip, words stream as they come, and a model writes Markdown with fenced JSON very reliably.
The rules of the answer-components page all hold: refs and never copies for what Life holds, written values
checked against `from`, no style in any block, nothing composed can act (only `items` act, through the owner's
own answers), a miss recorded when nothing fits.

Room for what follows v4: a component is a schema, a view and a brief line; the catalog has a version the phone
declares; the shape (flat blocks, a catalog the client owns, acts the agent cannot call) is A2UI's, so wrapping it
in A2UI later, if its Swift side settles, is a change of envelope and not of components (PR 4, PR 6).

## The other notes of #1373

Sends approved in an agent's chat, or in Claude Code. In the Life app there is no agent's chat: the thread is the
chat, and a draft with its Send button in it is this note, built. In one of the owner's own Claude Code sessions
the path exists and stays: the session asks the card as `owner` and answers it once the owner approved the exact
text there. The decision line is still written, because it is the record of every send; what goes is the card on
the phone, which shows such a send only as history when asked. No new send path, no invariant changed.

"Draft an answer for X?" Not for a reply (the draft is the ask). It is the plan card of longer work, which stays.

Standing intentions. In the foundation (PR 3's `intention` effect, PR 9's assignment). The nudge is an ask through
the gate, so it waits when the owner is loaded, and its Later is the ordinary one.

Mac admin access. Later, in the security plan. Its shape when it comes: the password entered once into the
Keychain by the app, never seen by Life or an agent; each use an ask that names the exact command and what it does
to the machine, answered by a tap; no automatic mode until a check that reads only the program's text has been
measured. Nod has nothing for sudo to borrow.

Life or the Voice host unreachable. Fixed in PR 7: a notice in the thread judged by the phone, and the armed local
notification when the app is closed.

The default model on OpenRouter. Already `deepseek/deepseek-v4.1-flash-1017` for every pi turn
(`models/llm.ts`, `routed`). v4 keeps it and varies only the effort by turn.

Remind me. The Later pill, with Life picking the time and other times said (question 8).

Adjust. Said or typed with the draft unfolded; the main session asks the replacement on those words; the field
suggests "Shorter" and "Warmer" from the card's `follow` (PR 5, question 10).

The monthly budget. In PR 7, as the plan says: soft, projected, asked once, subscriptions not counted.

## The pi audit

Its conclusion holds: keep pi; the gains are in Life's configuration and request flow. Its ranks, weighed.

| Gap | Verdict |
|---|---|
| Tool schemas deferred | Measure first (PR 1). Life's model caches a stable prefix, so the gain may be small. Done in PR 4 only above a fifth of a turn's uncached input |
| Model and effort by task | Effort yes (PR 4). A second model no: one more thing to prove, and the bench has no case for it yet |
| Provider failover | The route already names two hosts. Added: background turns pause on a failing provider, the owner's asks still try (PR 4) |
| Cold starts | Only the main session's matter to the owner, and it is kept warm. A background turn's start is unseen. Measured in PR 1, nothing built |
| Steer, queue, cancel | Queue and cancel yes (PR 4). Steering a running answer no: a second message is a second ask |
| Web and documents, browser and desktop tools | Later, behind the guard |
| Subagents with their own model | No |

The audit's benchmark is one outside run on other tasks; nothing in the plan rests on it.

## The open issues

| Issue | Position |
|---|---|
| #784 agent gating | Step 1 in PR 3; steps 2 and 3 are the gate's send-back (PR 7); step 4 is the stops in PR 4 and PR 7 |
| #785 fresh wakes | PR 3: the delay on the owner's own promises, the brief rule; the gate holds the rest |
| #713 Life proposes changes | No to suggestions about projects, agents and pace; the stopped source is the fix ask (PR 7) |
| #842 the matter id on a decision | PR 3 |
| #722 an answer reads the whole inbox | PR 5 |
| #1006 payment and event cards | Closed in PR 1 after checking #1093 |
| #1341 ask card follow-ups | Closed with the old app (PR 2) |
| #869 pi built in, Codex on demand | PR 10 |
| #1150, #846, #766 flaky tests | Settled in PR 1 |
| #1243 | Not a flaky test: phone leftovers, closed in PR 2 |
| #655 the desk renamed | Yes, after v4 (PR 10): during it, every PR would conflict |
| #1030 glossary names | PR 1, in the glossary only |
| #1274, #1271, #1377, #982, #981, #983, #748, #1016 | Later, not in v4 |

Next: [what v4 takes from Nod](nod.md).
