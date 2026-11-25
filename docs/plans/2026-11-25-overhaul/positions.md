# Life v4: where the plan stands, and why

Explanation: the reasoning behind each verdict of [the v4 plan](README.md), on every "to weigh", open question and
note of issue #1373, on issue #1376, and on the owner's review of 25 Nov 2026. Most of that review was input, not
decisions; where this page disagrees with it, or concludes that what exists was right, it says so. Each section
ends on its verdict and the bundle that carries it.

## The gate on every ask

The goal is right: something that knows the owner's load should stand between an agent and the owner's attention,
and a fixed order by card kind is not that. The only question was where it runs. The main session takes one ask
at a time (`desk/main-session.ts:311`), so a turn per card would make the owner's own question wait behind cards,
and its session would grow by every card ever asked. And what the main session "knows" is not in its head: the
instructions, what is open, the last exchanges and the hour are records code can hand to any call.

So the gate is a call with no tools, on the agents' own model (DeepSeek Flash; v4 has one model), given the card
as the phone would show it and that packet. Following Nod's proactivity code (`src/server/proactivity.ts`), the
model does not decide delivery: it returns four readings (importance, urgency, whether now is a good moment,
whether the owner can act now) and an optional note to the agent, and code decides. A model cannot talk a card
past a limit, and the four measures stay apart as the personalization research asks.

It is live from the first day (the owner, 25 Nov). That is sound because the limits are code's: a deadline is
never passed, 12 hours at most, one send-back, and any failure lets the card through. Every verdict is a
`delivered` line, so a wrong call is seen and corrected by an instruction or a fix, not by a week of watching.
Issue #784's draft check and "could you do this yourself?" check are this gate's send-back. Bundle E.

### "How am I doing?"

Worth having: it is the only signal of whether asking at all was right. The first draft of this plan argued for
two marks; the owner chose three (down, up, delighted) and a cross to dismiss, and that is a question of feel
that is the owner's to settle. What stays from the plan: code samples it, at most once a day, never on two asks
in a row; the cross and silence write nothing. An answer is a `rated` line; in v4 it feeds the gate's packet as
examples. Bundle E.

## Agents working together

"Where are we with the plumber?" should reach what the agent knows. Most of that is already Life's record, by the
owner's own rule that nothing rests on an agent's memory: the assignment's wait, its reason, its notes, its open
cards. The main session cannot read them today; giving it that read answers the common case at once. When it is
not enough, the main session asks the agent, which has 60 seconds. Research stays in the agent's context: the
main session gets the answer, not the pages read to reach it, which keeps its own session small and fast.

The reply enters the main session as data, like every chat and mail it already reads; an act still takes `said`
from the owner's words of that ask alone. Free agent-to-agent chat: no. Content would travel with no record of
where it came from, and two agents would each believe the other owns the next step. From OpenBot, ideas only: a
message to a busy agent is queued, delegated work needs an explicit reply and never moves ownership, bounds by
count. Bundles A and B, in the first wave (the owner, 25 Nov).

## Plan cards, and which arrivals become work

The owner asked for a step back: plan cards were never designed, and a cleaning company writing "thanks for your
payment, we'll come tomorrow at 12" surely needs none.

On arrivals, the step back finds the present design right. The arrival reader's confirm already leaves out "what
others will do; greetings, thanks, reactions, news, receipts", and a matter needs "something to be done or
awaited" that can end. So that message wakes no agent and is no matter. The one thing Life may do with it is its
own appointment read: if it judges a visit agreed, it adds it to the calendar as Life's own event, free and
removable, and says so once. That is the right rung of acting without asking. Nothing here needs a prompt change.

On plan cards, the step back finds the rule wrong. It makes an agent ask permission to read, research and draft,
which need none: the Mac and the web are free, and every step that does need the owner (anything outward,
anything that spends, anything only the owner can do) is already a card on the exact thing. The rule's effect
today is a first ask that carries no decision, and a door that refuses `finish` before a card, so an agent woken
on an arrival that needs nothing cannot simply end. The verdict is to remove the rule, not to add exceptions to
it. A plan's steps stay as an optional body of any card, for saying what happens after a yes. What replaces the
rule as a bound is cheaper than an ask: the two-hour close on work that neither asked nor waits, the seven-day
wait, the spending stop.

The "in between" message (a conversation that a short "thank you, see you tomorrow" would close): this is not a
new kind of ask. Asking the owner to approve a thanks costs more attention than typing it. By default Life drafts
none. Where an instruction asks for it ("close conversations politely with the cleaner"), it is an ordinary draft
with a day's deadline whose silence sends nothing, which the gate rates low and never pushes. Bundle A; the rule's
removal is question 19.

## Projects: label or container of context

The first draft said projects "become a label" while a project "has an agent when it has a repo". The owner found
that contradictory, and it was: a thing with repos, people, chats and deadlines is not a label.

The code settles what a project is. Its file in the owner's directory holds a status, an area, people, chats,
repos, deadlines and a free-text body; each night Life writes the project's situation from its running matters;
and the packet gives every agent working on a matter the context of each project that matter is under: the
header, the body, the situation (`desk/agent-actions.ts:720-760`). So a project is already a container of context
shared by the agents on its matters, whoever they are. What the plan changes is only who acts: the worker no
longer follows the filing. A dedicated agent exists where the context includes a place to work, a repo, since
code work needs that folder, its rules and its own session. Everything else goes to the Personal agent, which
reads the same project context. One sentence: a project holds context, never agents, and a repo is context that
calls for a dedicated worker.

Should a project also hold knowledge that its agents write and other agents read? The honest weighing:

For it: knowledge larger than one matter (the contractor always quotes high, the landlord answers only by mail)
is useful the same day, and today it reaches other agents only through the night.

Against it: it would be a second memory. Written by models, so interpretation would be stored where other agents
read it as fact, against the owner's own point that only what happened is sure. Outside the checks every memory
line passes (a quote verified against its source). Outside deletion and correction, which reach `memory/` and
nothing else. And with several writers, which the memory avoids with one lock.

And the path already exists: what an agent did enters the memory as the agent's source, the night extracts facts
from it with their quotes, and the project's situation is rebuilt from them. That is slower by a day and right in
every other way. The same-day gap is closed without a new store: an agent can read the records of the other
assignments under the same project, as the main session can.

Verdict: no store of project knowledge written by agents. A project's context is the owner's declaration, Life's
nightly situation, and its matters' records. A matter can be under several projects, as the data model already
allows. The owner's idea of a line of what a project is about, read by the matters step to group matters, is
good and is the body's first line; but it is a new version of the matters prompt, which regroups everything and
changes every matter's id, so it comes after v4, proved on a few weeks of a copy first (question 24). A project's
view is an answer built from its matters, and its mark is additive UI. One gap found on the way: deletion does
not reach the agents' notes; the brief keeps the owner's words out of them, and closing the gap is named as
later. Bundle A.

Matters themselves stay. They are Life's reading, what the thread shows as an item, what cards, done and deletion
hang on, and what bounds an agent's reads. On a cheap model, structure is what makes the work reliable; the
systems that let agents organise themselves, Nod included, keep a task table with one owner each and a unique key
per piece of proactive work, the same structure by another name. Issue #713 (Life proposes changes to projects,
agents and pace) is closed by doing instead of asking: the desk ends an idle agent, the gate and the pace are
Life's insides, and the one part the owner should see, a source that stopped, is the fix ask.

## What `truth/` is, and the two lists of people

The owner finds the name misleading, and believed people and organizations come from the sources, not only from
the owner. Both are true, and that is the real finding: there are two lists. The folder holds what the owner
named or confirmed (people, organizations, chats, areas, projects, and in `me.md` the goals). Life's guesses from
the sources are lines in `memory/` (`people-inferred.jsonl`, the people the Contacts name). Every reader merges
them into one directory, the owner's word winning. That the owner could not tell which was which is evidence that
the split is hard to see, and the question is whether it should be seen at all.

It should not. From the owner's seat there are people; some Life is sure of and some it is not, and when being
unsure matters Life asks (a guessed person, the same person twice). A "confirmed" mark on every row would put
Life's bookkeeping on screen and invite the owner to audit it: a builder's view. So the owner sees one list,
always. The split stays inside, where it does real work: only the owner's word can state who someone is, and a
guess is used at once and corrected later.

The name is then for builders alone, and it should say which half the folder is. `truth/` claims too much.
`directory/`, proposed in the first rework, is wrong for the reason the owner's confusion shows: the directory is
the merged list. The halves are what was stated and what was inferred, and the code already calls the second
"inferred". So: `stated/`. In one sentence: what the owner stated to exist, by hand or by a word or tap that
Life wrote down; never what Life read from the sources, and never the owner's dated statements about how Life
should behave or what was wrong, which are appended lines in `memory/` (corrections, instructions).

The rename (#1379) depends on the owner's yes to the name, one exception to "`truth/` is never migrated" (the
folder moved once, files untouched), and the server bundles having landed. Bundle Z; question 21.

## Memory in git

Nod was read for this ([`nod.md`](nod.md)). Its memory is one JSON document of at most 256 KiB in a Postgres
row, built only from the user's chat messages, with the whole of it placed in every prompt. No git, no files, no
index. It cannot hold ten years of many sources and is no model for Life.

Is git right for Life? For what it is used for, yes. The data repo holds append-only lines and derived text; git
adds a diff of every night, a rollback of one bad night, plain files with no server, and a backup that is a
folder. Its limits are real and known: history keeps what was deleted (Life applies a deletion at read, and
`SECURITY.md` says a purge needs code that does not exist); it answers no query (the index does); and it wants
one committer (the lock gives that). None of those argues for another store; two of them argue for work later: a
purge that rewrites history, and a measure of how the repo grows with files rewritten every night. Git would be
the wrong store for knowledge with several writers, which is one more reason not to build that.

Verdict: git stays, for the memory and for what the owner stated. No project knowledge in git or anywhere else. From Nod's memory
only ideas Life already has: a quote checked against its source, only the owner's words making a stated fact.

## Quick or long work

The owner's input is right and fits what exists. The main session should not decide by rule whether a redraft is
quick; it should know how long each kind of work takes and choose. The desk already times every turn. So handed
work carries a kind from a closed list, and `estimateOf` reads the median time of that kind's recent runs; the
main session sees those numbers in its packet, does in its own turn what fits a chat reply, and hands the rest.
Handed work is a thread item under way with its estimate; its result lands as a follow-up. The wire carries the
state, the kind, the estimate and since when; the look is the owner's next prototype.

This also answers Adjust, which the owner calls the same ask, amended. A quick redraft is the main session's own
replacement card, taking the open card's place at once; a long one goes to the card's agent and shows under way.
The owner's note on its look is right and the wire leaves room for it: a change asked in words has pushed the
draft up the thread, so the old version collapses and the new shows below; a tapped quick edit (a draft card's
`edits`) changes the same element in place. Bundles A, B and D.

## Personalizing behaviour

The owner's list, weighed. Batching asks into set moments: yes, an effect the gate enforces. What Later means:
yes, one effect read when Later is tapped. How proactive per project: yes, as `hands-off`, which the hand-out
enforces. How much Life does alone before asking: no effect, because there is nothing left for it to switch.
Once plan cards go, everything that needs no send, no spend and no deletion is done without asking, and those
three stay fixed. An effect that changes nothing would be a dial for its own sake.

The rule for the list stays: an effect exists only when some code enforces it; everything else is text a model
follows. Bundles A, D and E; question 23.

## What the owner is doing now

The first plan borrowed Nod's quiet hours. The owner's point is better: Life often knows more than the hour.
Weighing what it knows, and what is cheap:

| Signal | Has it today | Cost to use |
|---|---|---|
| The hour where the owner is | Yes (`zoneNow`) | None |
| A calendar event under way | Yes (the calendar reads) | None |
| Talking with someone | Yes: the pendant's speech in the last minutes | One read of lifelog |
| In the Life app | Yes: the presence call | None |
| Just arrived, or between places | Yes: the stays | None |
| Asleep, driving, do-not-disturb | No | The phone reports that a Focus is on: one permission prompt |
| On a call | Only once it has ended | The phone reports a connected call: no prompt |
| Driving with no Focus on | No | The phone's motion: a second prompt |
| Asleep, from sleep data | Only the night after | Not live; no use here |

Two things keep this small. iOS already holds ordinary notifications during a Focus, so sleep and driving are
handled if Life is honest about a push's level. And the phone cannot report continuously in the background, but
the Mac's silent push every 15 minutes (built anyway for the unreachable notice) wakes it, and it answers with
its state. The gate gets one line of state in its packet; code's limits do not change. It applies wherever Life
chooses a moment: the gate, a setting's offer, "How am I doing?". Bundle E; question 28.

## A spending stop that is the owner's

A fixed 3 dollars was a builder's number. Some owners do not care and some are careful, and a bill worth 2,000
deserves more effort than a table booking. The least-load shape adds no setting: the stop follows the one amount
the owner already sets for the month (2% of it), tripled for what is important, and an instruction can set it
where the owner wants to ("never more than a euro on errands"). The ask at the stop is about the work ("taking
longer than usual, keep going?"), since that is the decision; the sum is there as a small line, because money
matters and hiding it would be worse than showing it. Bundle E; the `budget` effect is question 26.

## Sensitive subjects

An effect of its own, not the model's judgement alone. A plain instruction ("don't bring up the lawsuit") would
be followed most of the time, and the times it is not are the ones that cost trust. Code cannot recognise a
subject, but it can do three things once the gate's model has: never push such a card, never put the subject in
a suggested ask, an offer or "How am I doing?", and keep the instruction in front of every model on every
request, whatever the scope at hand. It is different from deleting (the memory keeps it) and from `quiet` (which
is about a person or project, and timing). Bundles A and E; question 26.

## Reactions

The owner expected them in v4, and they earn it: a reaction is the cheapest acknowledgement there is, and the
plan's own async work needs one. The moments, found by going through the flows: the owner's second message while
Life works (the eyes, by code, at once); work handed to an agent (the eyes, then the follow-up when it lands);
an act done with nothing more to say (a thumb in place of "Done."); and from the owner, a reaction to a question
or a result that needs no words. A reaction and words can come together.

One line must hold: a reaction is not the owner's word. It closes a question or records how an answer landed; it
never answers an ask, never stands as `said`, and a send still needs the tap on the exact draft. The owner's
reactions are also the unasked form of "How am I doing?", and are recorded the same way. Bundles B and P2;
question 29.

## Life's voice, and style that does not fade

Life has no decided voice today: the main session's brief says two short sentences, no emoji. The owner wants a
warm one that is there and takes load off, not quirky, to be written together. Where it lives matters more than
its first words: one file, `prompts/life-voice.md`, that the main session's brief and the agents' card rules both
include, so an ask and an answer sound like one Life.

The owner saw a large lab's agent drop a style instruction after a while. That is context rot: an instruction
given once sinks under a long session and is lost at compaction. The fix is mechanical, and Nod's code shows it
working: the voice and every `style` and `sensitive` instruction are read fresh from the file and put before the
model again on every request, after compaction and outside it. Nothing relies on the session remembering. One
style is also checkable, so code checks it: "never an emoji" strips them from what Life says. Bundles A and C;
questions 26 and 27.

## Settings, and finding them

The owner's version is better than the plan's small page: no page at all. Settings are a component of the answer
catalog whose switches act in place on the owner's token, and "what can I change?" shows all of them in one
block. Offline, when Life cannot answer, the phone's own notice unfolds to the settings that live on the phone
(the pendant, pairing again, Face ID before Send, appearance), built by the app alone. This removes the page and
the quiet mark the first draft added to reach it.

Discoverability is the real risk of having no page, and offering a setting at the moment it helps is the right
answer, with one caution: every offer is an ask. So offers come from a fixed list in code, at most one a week,
never the same one twice. The field's fixed suggestions carry one ability not yet used. Bundles B, E and P3;
question 22 for the one setting the Mac holds.

## Undo of a send

The spec said a send never has Undo. The owner asks for it where a platform allows, and that is right: the
platforms do it, and "deleted for both, they'll see that a message was deleted" is honest.

What each allows, as far as it could be checked from outside (windows change; the last column is what matters):

| Channel | Take back for everyone | What the other side sees | Through Life's route |
|---|---|---|---|
| WhatsApp | Yes, for about two and a half days | "This message was deleted" | The bridge maps a Matrix redaction to it |
| Telegram | Yes, no limit in private chats | The message disappears | The bridge maps a redaction |
| Messenger, Instagram | Yes; windows reported differently | "Unsent a message" | The bridge lists redactions as supported |
| LINE | Yes, an hour (longer on its paid plan) | "Unsent a message" | Not verified |
| LinkedIn | Yes, about an hour | The message removed | Not verified |
| iMessage | Two minutes, in the app only | Older systems still show it | No: Messages.app cannot unsend from a script |
| Mail | No | — | No |
| GitHub comment | Yes | The comment gone; mails already sent | `gh api -X DELETE` |

Two rules follow. Life never hardcodes a window: it reads the chat's own features when Undo is tapped (the
bridges publish `delete` and `delete_max_age`; Life reads neither today), and shows Undo only when they allow it.
And it says "Deleted" only on the bridge's confirmation, since a redaction can succeed on Life's side and fail on
the network's. A notification already delivered keeps the text on every network, and the Undo line does not
pretend otherwise. Each network's Undo is switched on after one real try. Mail could get a true undo by delaying
every send a few seconds; that changes when a send happens, so it is not in v4. Bundle D; question 20.

## Direct and smart mode (#1376)

Direct mode asks the owner to silence every messaging app and trust one Mac to deliver everything within
seconds. Its failure case is all of the owner's messaging going silent, and the second path that would guard it
does not exist. Smart mode is where Life adds what no app does: one notification, hours later, with the reply
ready. v4 ships smart mode, and builds two things direct mode would need anyway: the notice when Life can't be
reached, and per-person instructions. The owner agreed on 25 Nov. Bundle E.

## How answers are drawn

Generated HTML is slow, costly, and gives up Dynamic Type, VoiceOver and the brand. Fixed whole blocks are too
few shapes for the owner's real questions. A2UI 1.0 answers the earlier objections, but with Life's catalog,
renderer-only acts and refs in place of data, what remains is an envelope, paid for with a Swift package at 0.12,
a build plugin and a 200 MB checkout. So: components composed from Life's own catalog, carried as fenced blocks
in the Markdown the session already writes. There is no `answer` tool call, words stream, and a model writes
Markdown with fenced JSON reliably. The rules of the answer-components page hold: refs and never copies, written
values checked against `from`, no style, nothing composed can act. The shape (flat blocks, a catalog the client
owns) is A2UI's, so wrapping it later is a change of envelope. Bundles B and P2.

## The other notes of #1373

Sends approved in an agent's chat, or in Claude Code: in the Life app the thread is the chat, and a draft with
its Send in it is this note, built. In one of the owner's own Claude Code sessions the existing path stays (the
card asked as `owner`, answered once the exact text was approved there); the decision line is still written as
the record of the send.

Standing intentions: an instruction with an assignment (bundle A). Mac admin access: later, in the security
plan; Nod has nothing for sudo. Life or the Voice host unreachable: the notice and the armed notification
(bundles E and P3). The default model on OpenRouter is already DeepSeek Flash 4.1 1017 for every pi turn. The
monthly budget: bundle E, soft, subscriptions not counted.

## The pi audit

Its conclusion holds: keep pi; the gains are in Life's configuration and request flow.

| Gap | Verdict |
|---|---|
| Tool schemas deferred | Recorded by C; built later only above a fifth of a turn's uncached input |
| Model and effort by task | Effort yes (C). A second model no |
| Provider failover | The route names two hosts; background turns pause on a failing provider (C) |
| Cold starts | Only the main session's matter to the owner, and it is kept warm |
| Steer, queue, cancel | Queue and cancel (C, B). Steering no: a second message is a second ask |
| Web, documents, browser and desktop tools | Later, behind the guard |
| Subagents with their own model | No |

## The open issues

| Issue | Position |
|---|---|
| #784 agent gating | The self-check line in A; the gate's send-back in E; the stops in C and E |
| #785 fresh wakes | A: the delay on the owner's own promises; E: the gate holds the rest |
| #713 Life proposes changes | No to suggestions about projects, agents and pace; the stopped source is the fix ask (E) |
| #842 the matter id on a decision | A |
| #722 an answer reads the whole inbox | D |
| #1006 payment and event cards | Closed in C after checking #1093 |
| #1341 ask card follow-ups | Closed with the old app (P1) |
| #869 pi built in, Codex on demand | Z |
| #1150, #846, #766 flaky tests | Settled in C |
| #1243 | Not a flaky test: phone leftovers, closed in P1 |
| #655 the desk renamed, #1379 `truth/` renamed | Z, after the server bundles; the name is question 21 |
| #1030 glossary names | C, in the glossary only |
| #1274, #1271, #1377, #982, #981, #983, #748, #1016 | Later, not in v4 |

Next: [what v4 takes from Nod](nod.md).
