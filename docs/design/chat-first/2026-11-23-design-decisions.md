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
- What a page adds to the thread: looked and left, nothing; an act, one line with Undo; words asked on it, the
  exchange marked "Asked on <page>".

## What waits on you

- An ask (one thing needing the owner now) and a matter (the running thing it belongs to) open the same page, with
  the ask on top, so they share one row look.
- The waiting list: no headline, no dots, no dividers, and no line of what Life prepared. Each row sits on its own
  solid rounded background: face or initial, name, what it is with when it is due (coral only for today), and the
  Later pill. Later takes the row out, lowers the count and leaves "…, tomorrow morning · Undo".

## Open

- The matter's full view: three directions on the [options page](https://claude.ai/artifact/LRTUmmswRj64fECboXFocT)
  (just the ask; the conversation; one sentence), tried on a real matter. The recommendation is "just the ask"; not
  decided.
- The icons of the two always-on buttons.
- What Later offers (a fixed "tomorrow morning", or a few choices).
- Found while trying real data: a card can sit on the wrong matter (a builder's pipe question filed under the lawyer's
  site report). A Life bug to file, not a design question.
