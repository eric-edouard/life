# Chat-first Life app: exploration of 23 Nov 2026

Explanation: an exploration of a phone app whose one entry point is the Ask Life conversation with the main session,
what was decided, what was researched, and what it would take in code. Nothing here is built. The design is the canvas
[Life app (Chat)](https://claude.ai/artifact/CwiSJncrntgP6CsKSFrkpu); its boards' sources are in
[`docs/design/chat-first/`](../design/chat-first/).

## The brief

The owner's direction: the only entry point is the Ask Life chat, which can suggest places to go, in the spirit of an
assistant that lives in iMessage, but with every piece of Life's data and any native UI behind it. The main session
decides what the owner sees, reusing the app's components. The bar for cognitive load is a 70-year-old who doesn't
know how to use an iPhone. The question to solve was navigation: what happens when a tap on something the chat showed
opens something else, whether there is a Back button, and how deep pages go.

## What the owner decided

- The text field and the voice button are always at the bottom of every screen, and anything said on a page is about
  that page (its refs go with the ask, as `MainSessionScreen` already carries).
- A Back button is fine. Having to say "go back" is a pain. Pages are pushed over the conversation with Back; the
  conversation is always the bottom of the stack.
- The rest of the screen is mostly driven by the main session.
- An animated edge shows that Life is always there: always on, slowly breathing, moving more while the owner speaks,
  with a different motion while Life answers. Greys only for now: a gradient around the screen's edge, no colour.
- Build it step by step inside today's app, without breaking it (the order is under "Steps").

The always-on, always-moving edge breaks three rules of [`docs/brand.md`](../brand.md): no borders, nothing moves by
itself but the recording dot, a spinner and a countdown, and nothing says that all is well. It needs the owner's
exception written into that page before it is built.

## The rules the design follows

These came out of the discussion; the ones marked as proposed were drawn without an explicit yes.

- Every tap does one of three things, and each looks different. An act (Send, Done, Pay, a setting's switch) works in
  place, its result on the button, through the owner's own token (`answer_check`), never through any agent. An open (a
  row, a name) pushes a page instantly from Life's own reads, with no model turn. An ask (a suggestion button, "Change
  it") becomes the owner's words and a turn of the main session.
- The main session decides what to bring up; moving around what it brought up is local and instant. A tap that waited
  seconds for a model would make the app unusable.
- The same thing getting longer expands in place ("Show the other 6"); a different thing is pushed.
- Back says "Back" from the first page and names its destination from the second on ("‹ Boiler repair").
- The owner's decision of 23 Nov 2026: "what's waiting on you" is an always-on badge with the count, not a message. Tapping it plays a shortcut: a bubble from the owner, "What's waiting
  on me?", and Life's answer ("9 things wait on you. The most pressing first." with the rows). Both are built by code
  from the inbox (`openChecksNow`, `inboxOrderOf`), never by the model: instant, offline, and never leaving an ask out,
  which the inbox invariant requires. The badge is only the count and the flag dot, no words (brand: minimal); the
  pendant's pill is only its dot. With nothing waiting, the badge goes rather than saying all is well (brand rule).
- The owner's decision of 23 Nov 2026, the waiting list: no headline sentence (the button already gave the count), no
  dot per row, no dividers, no line of what Life prepared (that shows once the thing is open). Each thing is a row on
  its own solid rounded background (`card`, no gradient, no border): who it is about (their picture or initial; an
  organization's mark), their name, what it is in a few words with when it is due (coral only for today), and a quiet
  Later pill on the right. The whole row is the tap: the item unfolds where it is, ready to act on. What the app does
  today, in one place: [`docs/design/chat-first/2026-11-23-current-spec.md`](../design/chat-first/2026-11-23-current-spec.md),
  which wins over this page's older lines where they differ.
- The shortcut's bubble is not the owner's words. It reaches the main session as an event of the screen ("the owner
  opened what's waiting", with the rows' refs, as `MainSessionScreen` carries), never as text that `hisWordsIn` could
  find, so no act can take its `said` from a tap. The owner's next words ("the second one", "do the plumber first")
  are a normal ask, about the rows on screen.
- The owner's decision of 23 Nov 2026: the pendant's button is always on screen too, beside the badge, as today's top
  bar has it (it opens the Pendant sheet, `PendantView`). It is a control, not a question: pausing in front of someone
  must be one tap, instant, never a turn of the main session. So it opens the sheet rather than playing a bubble. It
  shows the pendant's state itself: the recording dot while it records (one of the brand's three things that move by
  themselves), a flag when something needs the owner (not paired, offline, battery low, not recording when it should).
- The owner's decision of 23 Nov 2026: what is wrong and needs the owner comes before what is waiting. The thread then
  opens on it, not empty: Life's line and the one button that fixes it, then the badge as usual. What Life fixes itself
  never shows, and what is degraded but works shows nothing. The phone judges its own part (the pendant, its network,
  whether the Mac answers), since an unreachable Mac can't say what is wrong; the Mac judges the rest, one read over
  what exists (`read_life_status`, `agentHealthOf`, `deskHealthOf`, messaging status, `ConnectionSummary`).
- The owner's decision of 23 Nov 2026: one monthly amount for Life's paid services, set at setup, a soft cap, with a
  burn rate projected from spending and a prepaid balance watched (rules in [`docs/product.md`](../product.md)).
- Proposed: the same pattern for the other fixed doors (Today, People, Projects): a tap plays a deterministic bubble
  pair, so the conversation is the one way in and still nothing waits on a model.
- The owner's decision of 23 Nov 2026, the thread: one endless conversation that opens at its bottom, with Show
  earlier at the top (a few days at a time) and day separators. Small blocks stay as they are in it: a card, up to
  about 10 rows, an outside-data block, short text. A page-sized answer (the full view of a matter, a person, an
  organization, a project or settings; more than one section; more than about two-thirds of the screen) shows
  expanded in the thread while it is the latest answer: asked "show me the boiler matter", the matter is simply
  there, no button and no push, and the field speaks about it. It collapses into a preview (title, its key line, a
  couple of facts) when the owner sends the next message, so nothing changes size on its own. A preview shows the
  thing as it is now, never a snapshot. Tapping a preview in the history opens it in the thread, the same way an ask
  opens (which way is still being tried), never another screen: no zoom, no push.
- The owner's decision of 23 Nov 2026: action buttons (Later, Send, any act) show only on the thread's latest item;
  older items keep only their tap to open.
- What a page adds to the thread: looked and left, nothing; an act on it (Send, Done, Pay), one line ("Sent to
  Camille"; Undo only on what can be taken back, never a send), which is also the history of what Life did; words asked on a pushed page, the exchange, marked
  "Asked on Boiler repair" (on the expanded latest page, no marker: it is already the conversation).
- Proposed: nothing moves by itself after an act. After Send, two buttons offer the next item or the list.
- Proposed: an answer that arrives while the owner is elsewhere comes as a note with See, never a jump; ignored, the
  note goes after 8 seconds and the answer waits in the conversation.
- Proposed: on the open Duo the conversation stays the conversation, wider. It does not become a sidebar (the owner:
  a sidebar "sounds like it's not chat first").

Rejected along the way: a conversation with no pages, where every open is appended as a card and Back means scrolling
up (the chat fills with whole pages); a canvas the model rebuilds each turn (Back becomes ambiguous); a map or menu
button beside the chat (not needed once Back and suggestions exist; revisit if discoverability suffers).

## The edge

| State | The edge |
|---|---|
| At rest | A soft gradient drifts around the edge (one turn in 26 s) and breathes every 6 s |
| The owner speaks | Brighter, wider, flickering with the voice |
| Life answers | A different motion: one bright light running around the edge, about once every 2 s, on any screen |
| An answer lands | One bright breath, then rest |
| Life can't be reached | Still and dim, with one plain line of why; the only still state |

Under Reduce Motion the light stays in place and only its brightness changes. Life receives refs of what is on
screen, never pixels, and only with an ask, so the edge means "Life knows what you're looking at", not "Life is
watching".

## The three flows drawn

1. Answer a thing that waits on you: tap a row of the opener, its page with Back, "Change it" by voice aimed at the
   draft, the draft rewritten in place, Send, then Back to the conversation at the same scroll point, the row reading
   "Sent at 9:14" and the count down by one.
2. Ask, then go deeper: Life answers with words plus a matter row and a person row, the owner opens the matter, then
   the person (Back names "Boiler repair"), asks on the person's page and is answered there, and the exchange is kept in
   the conversation.
3. Life answers after the owner moved on: an ask on one page, Back while Life works (the edge keeps running), another
   page opened, the answer as a note with See, the answer in the conversation, and the offline state.

## What the code does today

- The main session's `show` door (`desk/desk-door.ts`) takes one `MainSessionShow` (`records/main-session-wire.ts`):
  one page (matter, person or organization, project, agent) or one list of one kind (matters, checks, people) of up to
  50 refs. `keepShow` (`desk/main-session.ts`) keeps one per turn; a later call replaces it. Each is checked when
  shown (`showProblemOf`).
- The phone reads that one `show` from the final result (`AskLife.swift`) and applies it by switching tab
  (`AppRouter.open(shown:)`): a filter on the tab's list, or the page. Nothing is drawn inside the conversation, and the
  `show` arrives only with the final answer, not while the session works.
- There is no catalog for `show`: the door's description is all the session knows. Cards have one
  (`memory/card-request.ts`: a short `CARD` summary, each part's page opened by `fetch("ask/<name>")`), but the
  connector's `fetch` takes one `id`, so discovery is one page per call.

## Rendering what the agent asks for: research

- Expo Exact (github.com/expo/exact): a whole app framework with its own declarative language and a Rust runtime,
  rendering with UIKit (no SwiftUI), with no way to embed one of its views in an existing app. Pre-1.0, "changes
  daily". Adopting it is a rewrite. Not an option.
- A2UI (github.com/a2ui-project/a2ui, protocol v1.0): agents stream JSON describing a flat list of components with
  ids; the client owns the catalog, agents run no code, and updates are incremental (`createSurface`,
  `updateComponents`, `updateDataModel`). An official SwiftUI renderer exists as a Swift package (0.11, iOS 17+), so it
  could be hosted in today's app. Three of its defaults go against Life's rules: the agent sends the data to display,
  where Life's `show` sends refs that the app reads and checks itself; a tap goes back to the agent, where Life's acts
  go through `answer_check` on the owner's token; and its basic catalog is layout primitives. Once those are removed,
  what remains is an envelope around Life's own components plus a pre-1.0 dependency. The ideas worth taking: blocks
  in a flat list with ids, a block updated in place, and the client saying which catalog version it draws.

### A2UI 1.0, read again on 24 Nov 2026

A2UI 1.0 is out (11 Nov 2026, Apache 2.0; read from the specification in its repository,
`specification/v1_0/docs/a2ui_protocol.md`). It answers the three objections above:

- **Its own catalog only.** A renderer can declare its own catalog and give the agent only that, "in place of the basic
  catalog", to "restrict the agent to using exactly the components and visual language that exist in your
  application"; catalogs can be mixed, and 1.0 removed themes from the wire, so all styling is the app's. Life's
  components (refs as props, no layout primitives) can be an A2UI catalog.
- **Taps that act stay the app's.** An action is either an event sent to the agent or a local function of the
  renderer. A function marked `rendererOnly` can never be called by the agent, and one marked
  `requiresUserActivation` runs only on a real tap. Life's acts (`answer_check` on his token, a send) fit as local,
  renderer-only, tap-only functions; the agent's events stay words.
- **Data.** The agent still sends a data model, but a component of Life's catalog can take refs and read Life's data
  itself, as `show` does.

Also new and useful: streaming updates of a flat component list (`updateComponents`), a whole answer in one
message, typed function calls both ways (checked against the catalog), accessibility rules every component gets, and
an MCP binding (Life's connector is MCP). The SwiftUI renderer (iOS 17+) hosts custom SwiftUI components in a custom
catalog, but its package is still 0.12 with breaking changes between minor versions. Its engine alone, `A2UISwiftCore`
(`swift/core`: the message parser, the data model and its bindings, the calls both ways, validation, and catalogs
of custom components and functions, with no views), would let Life draw its own components in its own SwiftUI and
keep the protocol's checks; it builds for iOS 17 and up (the app targets 27), depends on a pre-1.0 JSON Schema
library, and has tests of its own. A TypeScript agent package (`typescript/agents`) exists for the server side.

So the plan's choice for answers ("For the plan to decide", below) has a fourth way: A2UI 1.0 as the envelope, with
Life's own catalog and renderer-only acts. The plan weighs it with the others; the 0.12 Swift package and how much
of the protocol Life would use are its costs.

## Recommendation: Life's own catalog of blocks

The agent chooses what to show, never how it is laid out: layout, spacing and how many rows show before "Show more"
are the app's. The owner asked whether to keep low-level components; the recommendation is no layout primitives at
all, and three kinds of block:

| Kind | Examples | Its data |
|---|---|---|
| Life's full blocks | an ask (draft, plan, payment, call), a matter, a person, a message preview, an appointment, a setting with its switch | refs; the app reads Life's data; taps are the owner's |
| Life's rows and lists | asks, matters, people, a matter's thread, spending | refs, with an optional label in the session's words |
| Designed shapes for outside data | choices with links (trains from a web search), key facts, a comparison, a simple chart | sent by the session, capped in count and length, shown as data; a link opens only on the owner's tap |

No separate UI agent: what it would check is code's to check (the block's shape, its refs live, the load limits such
as 3 rows before "Show more", a cap on blocks per answer, one main button). The catalog follows the card pattern: one
line per block in the door's description, always in context (it also tells the session everything it can do), and
`fetch("show/<name>")` for a block's rules, shape and example. `fetch` should take several names at once
(`show/ask,person,choices`), and `ask/` the same, so composing an answer costs at most one extra round trip. When no
block fits, the session answers in words (with `life:` links) and Life records the miss with what was being shown; the
catalog grows from those records, each new block designed, never improvised.

**For the plan to decide, not a decision yet (the owner, 23 Nov 2026: "I'm not sure; make the best decision on what
we got").** His real questions showed that a good answer's shape depends on its content (a bead order as a table, a
shop's receipt in its own type, a phrase in Thai with his language under it), which a small fixed set of blocks may
not foresee. Three ways are on the table; the plan weighs them on the research above, on
[json-render](https://github.com/vercel-labs/json-render) (Vercel Labs, Apache-2.0: a catalog of components defined
as zod schemas, from which the model's instructions are generated; the model writes a flat JSON spec, streamed in
patches, never layout or style; React and shadcn components) and on MCP Apps (the official MCP extension of
26 Jan 2026: a server's predesigned HTML in a sandboxed frame), and picks one, saying why:

1. Fixed blocks, as recommended above: each designed whole, the agent only picks them and gives refs.
2. A library of smaller display components, already in Life's brand, that the agent composes per answer as JSON
   (json-render's way, drawn natively in SwiftUI): more shapes for few tokens; the risk is a library that drifts into
   layout primitives, which the recommendation above warns against.
3. Generated HTML in a sandboxed web view: any shape, but slow, costly in tokens, and every web hassle (Dynamic Type,
   VoiceOver, dark mode).

Whatever it picks, these hold: what acts (an ask, a matter, answers, Undo) stays Life's own and fixed, and nothing
composed can act beyond opening a link on his tap or a picture full screen; what Life holds goes as a ref the app
reads; values the agent writes (a table, a translation) are checked against the sources the answer cites before they
show; and it must cover the 23 Nov answers (Markdown text, a table, pictures, a phrase to say, a document as sent, a
place: the [answers page](https://claude.ai/artifact/USSnwciU3CovKtHYrXoj7R), private to the owner).

A starting library to weigh, drawn on 23 Nov 2026 (its reference:
[`2026-11-23-answer-components.md`](../design/chat-first/2026-11-23-answer-components.md); its look: the Answers page
of the Chat design canvas, private to the owner): `text` (Markdown), `items` (Life's own, refs, they act), `pictures` (photo refs, full screen on
a tap), `table` (groups, notes per cell, a total, `from`), `phrase` (`lang`, `text`, his words under it; said aloud,
shown full screen), `document` (a paper as sent: `from`, title, key lines, total), `place` (a ref, or a name and an
address). The three answers drew from them alone, each spec about 140 to 170 tokens with Life's words. It serves
option 1 or 2 alike: the same seven, picked whole or composed.

Growing the library comes later, in bulk (the owner, 23 Nov 2026): a workflow of real questions asked, answers
generated, A/B tested with him until he is happy, then each new component designed and specced.

## The order of the work (for the plan)

The owner's yes of 23 Nov 2026: the plan orders its work by what most lowers his load, so the first big PRs go where
the load is decided, not to the most visible part.

1. **Ask quality:** few, clear asks (below). It decides the load more than any screen. Answer speed (below) goes with it: a slow answer is load too.
2. **The thread:** the field, the thread and items with their states, unfolding, answering
   ([the current spec](../design/chat-first/2026-11-23-current-spec.md)).
3. **Notifications:** the notification as the ask, answers on it entering the thread, arrivals in the app.
4. **Undo,** once the rest works (below).

Then, in a planning session of its own, the prediction layer (end of this page).

## Items have one set of states (for the plan)

Every ask and matter the app shows follows one grid of states, wherever it appears (a list row, a folded card, an
unfolded item): [the current spec](../design/chat-first/2026-11-23-current-spec.md), "Items". The app builds it once,
as one model of an item's state read live from Life, not per screen.

## Ask quality comes first (for the plan)

The owner's word of 23 Nov 2026: the app's low load rests on the asks Life sends more than on how they look. No
thread design saves 15 vague asks. The plan treats ask quality as a deliverable of its own, ahead of the app's
polish:

- Few: the main session ranks what reaches the owner (top few, the rest after them), the complete list kept by code.
  Life settles what it can on its own before anything becomes an ask (`docs/product.md`).
- Clear: each card carries a short imperative ask line ("Pick a clinic for the tattoo"), never news or a name, and
  Life's suggested follow-ups: two new fields of the card's contract, written by the agent that asks, refused when
  missing like a plan card's steps.
- Answerable in place: the recommended answer first, the others as equal pills, what each answer does said plainly.
- Interrupting: today every new card notifies once at its kind's level. Whether Life should notify fewer unrelated
  asks at all (ranked, not every card), on the lock screen and in the app alike, is the plan's to decide with the
  ranking (the owner's word of 23 Nov 2026). The design's proposal meanwhile: in the app, an unrelated ask follows
  its push level (off or quiet, only the count; normal or urgent, it lands once he is free); a follow-up to what he
  just did always lands (`docs/design/chat-first/2026-11-23-current-spec.md`).
- Measured: a small set of real cards (anonymized for the repo) graded for those three before and after, the way
  prompt changes are proved (`AGENTS.md`, "Prove a change cheaply").

## Answers come fast, and right (for the plan)

On 23 Nov 2026 the owner's real questions went to the main session through the connector ("Where are we regarding
the house?", "What was the order for Alice's beads?", "What do I say to the guy when I arrive there?"). The answers
were good, the third one what a human assistant would text, but each took more than a minute: too long (the owner's
word). A question to Life must feel like a reply in a chat, so the server rework the plan proposes includes speed:

- Measure first, per answer: time to its first words, time to its whole answer, each tool call's time and size, the
  model's time. A target to start from: first words within about 3 seconds, a lookup answered within about 10.
- Then what the measures point to. Candidates: the session kept warm while he is in the app (the presence call
  exists); tool calls in parallel; a compact read made for questions, so a lookup isn't a whole matter's JSON; a
  faster model for lookups that hands over when it needs depth; the words streamed as they come; answers to the
  likely next asks prepared ahead (the prediction layer's suggested asks).
- Right: a number or name in the words is checked against the source the answer cites before it is shown.
- Six more questions taken from his days (23 Nov 2026, late evening, the session warm): each answered in 15 to 36
  seconds, counted from the call to the reply. Still too slow for a chat, and the first three of the day took more
  than a minute: a cold session costs the most.
- What they showed, for the plan:
  - Life does not settle what it can read: a bill paid on 9 Nov (the payment matches the bill's amount) was still
    "stuck, overdue" in his due list on 23 Nov, though the session found the payment at once when asked. The
    settling pass should have closed it (`docs/product.md`); an audit with its regression case.
  - Sources must be right: a spending answer cited an unrelated matter as its source.
  - Just after midnight "today" and "this morning" meant the day before to him; the session answered with a
    question. Near midnight, answer for the day he most likely means and say which.
  - Answers still use the old app's shapes: raw GitHub links in the words, and `show` opening a person's page ("her
    page is open on your screen"), which the chat-first app has no more.
  - A voice Life had named "lawyer" was a gym trainer counting reps: the session caught it; the day record kept it. The beads
  answer said "16 bags of Tila, 17 of Half Tila" while its own source, the shop's receipt, gives 19 and 14.

## Questions that start work (for the plan)

The main session's `question` answer kind gets suggested answers that can act (the owner, 23 Nov 2026): his tap on
one is his word, so the session may then tell an agent, correct a matter, start or hand over work, as it does on his
typed words today. The plan decides how an answer says it will act (a field on the answer, so the app can mark it),
how that work shows as an item with its state and Undo, and keeps the send guard as it is: anything outward in his
name still becomes a card on the exact words.

## Profiles of people and organizations (for the plan)

Tapping a face opens that person's or organization's profile as an overlay over the thread (the face rises to the
top, the thread blurs and darkens behind; a glass back button, or a drag in any direction, lets it go). Its sections,
in order: who they are to him, the ways to reach them, what needs him, where things stand, what waits on them, what
is coming up, the last time, what they are like ([the shell prototype](https://claude.ai/artifact/7DNThcrd9u89WPWhjfBFCg); the owner kept plain titled sections on
24 Nov 2026, after trying a letter, swipeable moments, a timeline, their own words set large, progressive disclosure
and a labels rail). A lead paragraph is no longer asked for. Checked against the connector's read of a real person on
24 Nov 2026, what it needs:

- Already there: the picture, the ways to reach them, what needs him, what waits on them (open matters naming them),
  their last exchange (with code to pick the newest episode's title and its app), what they are like (the persona's
  first sentence, while the personas add-on is on), the birthday.
- A small reader, code only: what is coming up with them (appointments, dated open steps naming them, a birthday
  within a month).
- New output, and the one open question for the owner: where things stand reads naturally only in "you", two or three
  short lines. Stored readings name the
  owner, never a pronoun (`AGENTS.md`, "Prompts and what they write name the owner"). Two ways: rewrite them for
  display when the profile opens (a model call, slow), or write a short display version in "you" each night beside
  the situation, for the people whose situation changed (a new output of a prompt, and a first run for everyone with
  a page: a backfill of a new output, not of the memory). The second is the recommendation; it needs the owner's yes,
  on the wording rule and on the run.
- Two gaps seen: the line of who someone is comes from his directory and can go stale (one read "partner — confirm
  role" while every reading says otherwise), so Life should ask him to correct it rather than show it as is; and an
  organization Life only inferred came back with no ways to reach it although he has a chat with it, which looks like
  a bug in how reach finds an inferred organization's chats.

## Fix asks (for the plan)

Failures that need the owner are asks of a kind of their own, "fix", written by the caretaker for where he is
([the current spec](../design/chat-first/2026-11-23-current-spec.md), "When Life can't be reached"). Two things to
check before any fix ask offers a step: Life reads WhatsApp from the Mac's app and its bridge only sends, so the
bridge signed out means "can't send on WhatsApp", not "can't read"; and whether the bridge can be linked again by
WhatsApp's 8-character pairing code (typed in WhatsApp's Linked devices) instead of a QR code, which would let the
phone alone fix it. Until then, signing the bridge in is a fix at the Mac.

## Undo, tried wherever it can be (for the plan)

The owner's word of 23 Nov 2026: every answer but a send gets an Undo that Life tries, and says plainly whether it
worked. On screen: Undo turns to "Undoing…" while Life tries; then either "Undone", with Reopen, which brings the ask
back as the newest item in the thread, or, when it can't, one line saying so ("Can't undo: Life already drafted the
booking") and nothing else. A send never has Undo: it is gone.

What each undo needs, none of it built today:

- A decision's answer (any card option): today the first answer stands and a second is refused
  (`answerDecision`, `memory/decisions.ts`), and its asker is woken at once. Undo needs a withdrawal of his answer (a
  new line, the file staying append-only) and the asker told: stopped mid-turn if it is still on it (the desk
  interrupts its run), or, once it acted, the undo refused with what it already did. Strict paths: `decisions.ts`,
  `desk/`; changes an invariant in `AGENTS.md`, so the plan words it for his yes.
- An Apify run (a `runs` option): abort the run on Apify; what it spent stays spent and is said.
- A calendar event added from a card (an `adds` option): remove that one event, its `added` line followed by a
  removal (today one he deletes stays deleted, and only Life's appointments have Remove and Undo).
- Later or Not now (`your-move-not-now`, a pin): a correction that lifts it; nothing lifts one today.
- Done or dropped: already there, as Reopen (`matter-reopened`, `correctMatter`).


1. The bar and the edge in today's app: the Ask Life round button and strip become the always-on field and voice
   button on every screen, and the edge shows Life's state. Navigation unchanged. Needs the brand exception first.
2. Home becomes the conversation: the opener built by code, a row pushing today's thread page with Back.
3. `show` becomes a list of blocks per answer, each with an id, added to across the turn and drawn in the
   conversation, with the catalog and its batched `fetch`. Strict paths: `desk/`, `records/` wire, the connector.
4. The drawer and tabs go once the conversation covers what they did.

## Open questions

- The brand exception for the edge: its words and date in `docs/brand.md`.
- Whether the session may add a line after code's answer to the badge's shortcut, or it stays code's alone.
- Whether fixed subscriptions count toward the monthly amount.
- Whether suggestion buttons are a fixed set or chosen by the session with "what's waiting" always among them.
- The open Duo was discussed but not drawn. The notification path and the unhappy paths are next in the design.
