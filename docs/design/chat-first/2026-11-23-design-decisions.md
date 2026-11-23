# Chat-first app: design decisions of 23 Nov 2026

Explanation: what the owner decided, and what was learned, while designing the chat-first app's shell and first
components on 23 Nov 2026. The plan is [`docs/plans/2026-11-23-chat-first-app.md`](../../plans/2026-11-23-chat-first-app.md);
the product rules are [`docs/product.md`](../../product.md); the brand is [`docs/brand.md`](../../brand.md). The canvas is
[Life app (Chat)](https://claude.ai/artifact/CwiSJncrntgP6CsKSFrkpu); the clickable shell is the
[shell prototype](https://claude.ai/artifact/7DNThcrd9u89WPWhjfBFCg). Both are private to the owner.

## How to work

- Get the main loop right before any component: a clickable prototype on the phone beats boards, because only using
  it shows whether a conversation can replace an app's navigation.
- The old design kit is not the design system. Only foundations stay (colour, type, larger text, buttons and fields,
  motion, native first, brand); component boards from the old app were deleted from the new canvas (the old canvas
  keeps them) because they carry the old navigation's assumptions.
- Every proposal is tried on a real matter from the owner's Life, not only on a made-up one: a group chat with a long
  draft breaks layouts a dinner reply never does. Real data stays in private artifacts, never in the repo.

## The always-on layer

- On every screen: the edge, the field at the bottom, and two round buttons at the top: what waits on you (left),
  the pendant (right). No tab bar, no drawer.
- The edge has three states. Waiting on you and You speak use Ember's motion in grey: two soft lights turning in
  opposite directions over a faint even ring that never goes dark; speaking doubles their speed and pools the light
  at the bottom by the field, flickering with the voice. Life is working uses the blue swell in Life's ai colour
  (`#9aa8ec`), stronger and faster: light rising up both sides and falling from the top, a third light turning, a
  blue ring with a wider glow. Colour and motion both change, so working never reads as idle.
- State changes glide: speed, colour, brightness and glow ease over about a second; nothing jumps or restarts. (CSS
  animations restart when their speed changes; the prototype drives the values frame by frame, SwiftUI animates them.)
- The answer landing gives one bright breath of the ring, then rest.
- The edge needs the owner's exception written into `docs/brand.md` (borders, motion, colour) before it is built.

## Buttons and words

- Minimal is the brand: a button shows a mark or a number, not a word, wherever a mark can say it. Words go to
  VoiceOver. The 70-year-old bar means fewer things on screen, never labelled buttons.
- Exception: "Later" is a word on a quiet pill (solid `tint` background, no border); a clock icon confused.
- A voice button is always the microphone. The voice bars appear only while someone speaks, and move with the voice.
- The waiting button is round. Its icon is open (ideas on the canvas: the number, stacked cards, a ring of asks, your
  turn, lit dots, a raised hand); the prototype shows the number.
- The pendant is never coral while it simply records: coral means only "needs you". Recording is the brand's lit
  cream dot, breathing; paused is a hollow ring. Its icon is open too (lit dot, the pendant, the lens, a lit dot that
  opens into voice bars while it hears speech).

## The field and dictation

- No timer and no "Writing…" state. No cursor while dictating.
- Dictated words arrive a word at a time, and each word's letters ink in one after another (from blurred to sharp).
- The voice levels fill the whole width between Cancel and the microphone.
- The live microphone is filled in `fg`, never in the ai blue: the blue means Life, not the owner.

- When an ask is the latest thing (its page open, or the newest item of the thread), the empty field's placeholder
  becomes Life's suggested follow-ups for that ask ("Say 8:30 instead", "Ask her to book it"), one at a time, changing
  every 3 seconds. A quiet send button (the usual arrow on a `tint` background) sits at the end of the suggestion and
  sends it as the owner's ask. Tapping anywhere else in the field types as usual; typing hides the suggestion.

## The thread

- One endless conversation, opening at its bottom, with Show earlier at the top and day separators.
- Small blocks stay as they are: a card, up to about 10 rows, an outside-data block, short text.
- A page-sized answer (the full view of a matter, person, organization, project or settings; more than one section;
  more than about two-thirds of the screen) shows expanded while it is the latest answer, with no button to press:
  asked "show me the boiler matter", it is simply there. It collapses into a preview when the owner sends the next
  message, never on its own.
- A collapsed matter is a row on a subtle solid card: the face or initial, the title, one line of where it stands. It
  shows the thing as it is now, never a snapshot. Its line has the same shape as a waiting row's: what it is, then
  when it is due ("240 € for the leak · Fri"), coral only for today; a matter with no date shows none.
- Tapping a preview, a row or a person opens the page with the system's zoom out of what was tapped
  (`navigationTransition(.zoom)`), never a right-to-left push; Back shrinks it back into the same spot.
- Whatever Life adds to the thread (its words, a list, a page, an ask, a line) comes in progressively, like
  dictated words: text word by word, blocks one after another, each from blurred to sharp. The thread follows as it
  grows and stops with the new block's top in view. The owner's own words appear at once. Under Reduce Motion,
  everything appears whole.
- Action buttons (Later, Send, Mark as done, any act) show only on the latest item of the thread. Once anything newer
  arrives, older items keep only their tap to open: the history is read, not acted on in place, and only the newest
  thing asks for a decision.
- What a page adds to the thread: looked and left, nothing; an act, one line with Undo; words asked on it, the
  exchange marked "Asked on <page>".

## What waits on you

- An ask (one thing needing the owner now) and a matter (the running thing it belongs to) open the same page, with
  the ask on top, so they share one row look.
- The waiting list: no headline, no dots, no dividers, and no line of what Life prepared. Each row sits on its own
  solid rounded background: face or initial, name, what it is with when it is due (coral only for today), and the
  Later pill. Later takes the row out, lowers the count and leaves "…, tomorrow morning · Undo".

## A matter's page

- Not everything is shown, but everything stays reachable by asking. Something shows only if the owner needs it to
  answer what is asked now, if it changes what the owner does next, or if the owner would otherwise have to ask for it.
- The matter's state decides the layout. Needs you: the ask first (a draft with Send, or the decision), then the few
  messages that explain it. Waiting on someone: one line ("Waiting on Marc's quote · since Tue · Life will bring it to
  you") and their last relevant message. Life is on it: what Life is doing, in one line. Done: how it ended, and
  Reopen.
- Kept: the name; one status line (what, when it is due, who it is with as faces); the ask; the relevant messages.
- Dropped from the old page: the icon, people's roles, the project, the token cost (it lives in Settings), the
  "since" span.
- Hidden: the goal (Life's framing; changed by saying so). Done and Drop show only when nothing is asked; Drop is also
  said. One ask at a time; the others show as "1 more after this".

## One page shape for every ask

- Every ask, whatever its kind, opens on the same shape: who asks, in large (their face or mark, their name, and the
  row's own line "what · when"), then the body of its kind, then one action bar: a quiet Later and one wide button
  that says what it does ("Send to Camille", "I paid it", "Add to calendar", "Confirm Thu 27 Nov", "Done"). A
  standard way to show what an ask is about matters more than a layout that suits one kind (owner, 23 Nov 2026,
  choosing "who asks, in large" with the wide Send of the action-bar proposal).
- The page repeats the row: the same face, name and line, in the same type roles, only larger, then what the row had
  no room for. What the owner saw in the list is what they find at the top of the page.
- The bodies by kind: a reply, the chat with the draft; a choice, its options as rows to pick (the button waits for a
  pick and then names it); a payment, the amount large, to whom, the IBAN in mono, the reference, and "Open your bank";
  a calendar add, the event's when, where and reminder; a call, the number as a tap to call and what to say. A matter
  waiting on someone has no action bar: one line and their last message.
- Every action reads the same way, on a row or a page: the button turns to doing (a spinner and "Sending…"), then to
  done (a tick and "Sent", green) for one second, and only then does anything move (the row leaves, the page shows
  its done state, a line with Undo lands in the thread). It shows the owner that Life did it and recorded it.
- An ask that is done leaves what waits on you, and the count goes down.

## Tried on the owner's real asks

What the real inbox showed when two real asks went into the prototype (a recap to send with a file, and a choice
between two places), and what changed because of it:

- A row's title is the one-line ask, what is asked of the owner ("Send Idris the call recap", "Pick a dentist"), never a
  person's name: a name alone does not read as something waiting. Its line is who it is about and when it is due. The
  page's header repeats both.
- Life's card titles today are mostly news ("The ads numbers are in…", "… gone from Google"), and the card's question
  is too long for one line. Cards need a short imperative ask line, written by the agent that asks: a new field of the
  card's contract, for the plan.
- Real cards often carry two or three answers. The page keeps one wide button for the recommended answer (the
  card's first option); the other answers sit as one quiet line just above the bar ("Send the recap only", "Drop
  it"); an option meaning "not now" takes the Later slot, in the card's own word.
- Later on a row only for a task the owner does outside Life (pay, call, create a passkey). A decision has no Later
  on its row: answering takes a second, and an unanswered decision waits anyway.
- A rich choice shows each option as a row with its few deciding facts and Life's pick marked; the pick is preselected
  and the button names it ("Contact Clinic North").
- The answers (owner, 23 Nov 2026): the main answer alone and full width; under it the others as equal quiet pills
  (`tint`) in one row: Later (or the card's own "Not now"), an alternative ("Recap only"), Drop it. Never bare text.
- A choice's options are cards: a radio, the name and Life's pick, one line of deciding facts, and for a place a
  "Google Maps ↗" chip with the Maps mark inside the card, which opens the place without picking it.
- Open question being tried in the prototype: with the noise gone, many asks no longer need a full screen. A switch
  lets the owner try an ask coming into the thread as its newest message, in the same layout, with no empty space
  between the ask and its answers; Later folds it into its preview. In the thread it keeps the page's spacing a
  little tighter (header to content), with more space above it to set it apart from what came before.
- No one can foresee every ask. What makes that safe: asks are built from a few typed parts, and an option can carry
  the same parts as a card (a place, a link, an amount) from the registry of card needs; anything the parts don't fit
  still renders through a plain fallback (text, answer buttons, links); every fallback is recorded as a miss, and the
  owner's real inbox, run through the prototype from time to time, is the test set that surfaces new kinds.
- At most one line of why under the header; the rest of a card's long context stays reachable, not shown.
- Naming voices is a separate, larger problem (many open voice cards), left for later.

## A draft

- Branded per app. The chat's head: the app's own logo (never a generic bubble), the chat's name, and its size in a
  quieter face ("Halden house · 5"), no app name; on the right, a subtle button in the app's colour, "Open WhatsApp ↗",
  which opens the real chat. The owner's own messages and the draft take the app's colour (WhatsApp's green) mixed
  into the brand's black.
- Only the messages the matter's facts cite, at most the last 5 plus the one the draft replies to; older ones are
  "Earlier in WhatsApp". Messages in between that are not the matter's become one quiet count ("3 unrelated
  messages"), not tappable.
- Tapping any message also opens the real chat.
- The draft: a subtle background of the app's colour and the brand's dashed outline (1.5 px) in that colour too,
  which fades once it is sent.

## Open

- The icons of the two always-on buttons.
- What Later offers (a fixed "tomorrow morning", or a few choices).
- Found while trying real data: a card can sit on the wrong matter (a builder's pipe question filed under the lawyer's
  site report). A Life bug to file, not a design question.
