# Turn by turn and "hey Life": where the design stands (27 Nov 2026)

Explanation: for the next session picking up the app's design. It covers what the owner decided, what exists, what is
still open, and where the work stopped. All of it is design only: no app code was written.

## What the owner decided

On 27 Nov 2026 the owner chose the turn by turn direction for the app. He had parked it earlier the same day with
"Not now". His words, about "hey Life": "I'm definitely gonna go for the … turn by turn solution in terms of UX because I
think it makes sense … it's not a huge change in terms of code it's just I have to design it properly." He also wants
"hey Life" to feel progressive: a notification says the ask was heard, a tap opens the app on that ask, the main
session's answer follows, "with nice UI transition states".

Turn by turn means at most two turns on screen, his and Life's. His words sit in the centre, marked "You". Life works
from the centre under a soft mesh of light, and its answer then fills the screen. Scrolling up shows a centred
chronology of earlier turns.

What is still true: [app v4](../design/2026-11-23-chat-first/2026-11-25-app-v4.html) remains the one approved design.
Both turn by turn pages are proposals. Nothing is approved until the owner picks a drawn design.

## What exists

| File | What it is |
|---|---|
| [`2026-11-27-v5-turns.html`](../design/2026-11-23-chat-first/2026-11-27-v5-turns.html) | The first mock: an ask, from empty to answer and history (states `#1` to `#5`) |
| [`2026-11-27-v5-turns-proposal.md`](../design/2026-11-23-chat-first/2026-11-27-v5-turns-proposal.md) | What turn by turn gains and loses, whether SwiftUI can do it (yes), and the build in slices |
| [`2026-11-27-hey-life-turns.html`](../design/2026-11-23-chat-first/2026-11-27-hey-life-turns.html) | "Hey Life" from the owner's seat: every state, how each moves into the next, a play-through, decisions for him |
| [`2026-11-27-turns.css`](../design/2026-11-23-chat-first/2026-11-27-turns.css) | The turn parts both pages share: the phone, his turn, the mesh, the answer, the field |
| [`docs/design/README.md`](../design/README.md) | The index of every design, with its status |

Published copies to view in one click (private to the owner):

- Hey Life, turn by turn: https://claude.ai/artifact/9CkZF44cA6H2QmmBQKXGnv
- App v4: https://claude.ai/artifact/CvbKKXFzYTko1SZMNB2GrF

The published copies have the CSS inlined, because an artifact can't load `../` paths. The repo file is the source:
rebuild the copy from it and publish to the same URL.

## "Hey Life": what the design answers

An investigation on 27 Nov 2026 found three things:

- The wake word is found in the written transcript, not live: one ask reached Life 33 minutes after he spoke.
- No receipt notification exists.
- When the agent's action failed (his to-do list was down), he heard nothing.

The design answers each one:

- Heard: one notification quoting his ask, sent as soon as Life hears it. Later, when the answer is ready, the same
  notification is replaced by the answer, so there is never a second one.
- Every ask ends in a visible outcome, a failure included: "I couldn't add it to your list. Reminders isn't
  answering…", with what Life does next.
- Honest timing: a late notification says when he said it, and his turn shows "said at 14:02 · heard at 14:35". If he
  opens the app before his words are written down, it says it is still writing down; it never claims to be working on
  his ask.
- Not heard right: what was caught, with "Say it again" first. His words are never guessed.
- Offline (Mac not answering): the ask is kept, the edge goes still, and Life answers when the Mac is back.
- Slow: after about 20 seconds a line says he can close the app.

Decisions waiting on the owner, listed on the page:

1. A notification, or a Live Activity?
2. Should the answer be read aloud?
3. Should "hey Life" be heard live, so "heard" comes within seconds?
4. Should the phone's own "hey Life" work the same way as the pendant's?

## Still open in turn by turn itself

These come from the proposal's "What it loses" section, and none is designed yet:

- A rule for arrivals: what happens to a card or ask that lands while he reads an answer (for example a quiet "1 more"
  pill).
- Live asks in the history.
- "You" and "Life" labels versus marks.
- Long answers taller than the screen.
- The edge and the mesh as two signs of presence (the edge dims while the mesh shows).
- Large Dynamic Type sizes and Reduce Motion.

The proposal's build order still holds:

1. Each ask starts a fresh screen, with the mesh.
2. A large headline sentence above the answer.
3. Centring and the chronology, once the arrivals rule is written.

## How the designs share their CSS (and the trap)

Every design is a dated, plain HTML file under `docs/design/`, built from shared parts:

- [`assets/brand/tokens.css`](../../assets/brand/tokens.css) is Life's brand.
- [`components.css`](../design/components.css) holds the rules the app v4 pages had in common.
- `boards.css` is the 23 Nov boards' shared file.
- `2026-11-27-turns.css` is the turn pages' shared file.

A rule moves into a shared file only when no other page that links the file uses that rule's class names anywhere,
scripts included.

The trap: checking only a page's first render misses classes its scripts create in later states. PR 1503 fell into it:
the v5 mock's answer buttons lost their colour, and app v4's later scenes picked up foreign rules. PR 1504 fixed it.
Every page and every v5 state was then compared, pixel for pixel, with its version before PR 1503.

When you change a shared file, screenshot every state of every page that links it, before and after.

## Where the work stopped

- [PR 1504](https://github.com/eric-edouard/life/pull/1504), branch `claude/hey-life-turns`, holds:
  - the "hey Life" page;
  - `2026-11-27-turns.css`;
  - the shared CSS fix;
  - this note.

  Its first debt verdict asked for small fixes. They are made, and the verdict is being rerun on the new head. It is
  merged once that verdict passes.
- Next, on the owner's word: his four "hey Life" decisions, then the arrivals rule. Only after those, the first build
  slice in the app (`Thread/ThreadView.swift` and one mesh view).
- Nothing turn by turn is approved. The app is still built to app v4.
