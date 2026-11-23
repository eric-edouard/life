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
  Later pill on the right. The whole row is the tap: the thing opens in the thread, ready to act on. Later takes the row out,
  lowers the count and leaves one line ("Pay the plumber, tomorrow morning · Undo"). Details and the other decisions
  of the design session: [`docs/design/chat-first/2026-11-23-design-decisions.md`](../design/chat-first/2026-11-23-design-decisions.md).
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
  Camille · Undo"), which is also the history of what Life did; words asked on a pushed page, the exchange, marked
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
- Measured: a small set of real cards (anonymized for the repo) graded for those three before and after, the way
  prompt changes are proved (`AGENTS.md`, "Prove a change cheaply").

## Steps

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
