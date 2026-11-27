# Turn by turn and "hey Life": where the design stands (27 Nov 2026)

Explanation: for the next session picking up the app's design. It covers what the owner decided, what exists, what is
still open, and where the work stopped. All of it is design only: no app code was written.

## What the owner decided

On 27 Nov 2026 the owner chose the turn by turn direction for the app. He had parked it earlier the same day with
"Not now". The owner's words, about "hey Life": "I'm definitely gonna go for the … turn by turn solution in terms of UX because I
think it makes sense … it's not a huge change in terms of code it's just I have to design it properly." The owner also wants
"hey Life" to feel progressive: a notification says the ask was heard, a tap opens the app on that ask, the main
session's answer follows, "with nice UI transition states".

Turn by turn means at most two turns on screen, the owner's and Life's. The owner's words sit in the centre, marked "You". Life works
from the centre under a soft mesh of light, and its answer then fills the screen. Scrolling up shows a centred
chronology of earlier turns.

What is still true: [app v4](../design/2026-11-23-chat-first/2026-11-25-app-v4.html) remains the one approved design.
Both turn by turn pages are proposals. Nothing is approved until the owner picks a drawn design.

## What exists

| File | What it is |
|---|---|
| [`2026-11-27-v5-turns.html`](../design/2026-11-23-chat-first/2026-11-27-v5-turns.html) | The first mock: an ask, from empty to answer and history (states `#1` to `#5`) |
| [`2026-11-27-v5-turns-proposal.md`](../design/2026-11-23-chat-first/2026-11-27-v5-turns-proposal.md) | What turn by turn gains and loses, whether SwiftUI can do it (yes), and the build in slices |
| [`2026-11-27-hey-life-turns.html`](../design/2026-11-23-chat-first/2026-11-27-hey-life-turns.html) | "Hey Life" from the owner's seat: every state, how each moves into the next, a play-through, decisions for the owner |
| [`2026-11-27-turns.css`](../design/2026-11-23-chat-first/2026-11-27-turns.css) | The turn parts both pages share: the phone, the owner's turn, the mesh, the answer, the field |
| [`docs/design/README.md`](../design/README.md) | The index of every design, with its status |

Published copies to view in one click (private to the owner):

- Hey Life, turn by turn: https://claude.ai/artifact/9CkZF44cA6H2QmmBQKXGnv
- App v4: https://claude.ai/artifact/CvbKKXFzYTko1SZMNB2GrF

The published copies have the CSS inlined, because an artifact can't load `../` paths. The repo file is the source:
rebuild the copy from it and publish to the same URL.

## "Hey Life"

An investigation on 27 Nov 2026 found three things:

- The wake word is found in the written transcript, not live: one ask reached Life 33 minutes after the owner spoke.
- No receipt notification exists.
- When an agent's action failed (the to-do list was down), the owner heard nothing.

The page answers each one. There is a "heard" notification as early as Life can hear the ask, every ask ends in a
visible outcome (failures included), and timing is honest while the words are written down. Its "When it doesn't",
"How it moves" and "Decided" sections hold the details.

The owner decided on 27 Nov 2026:

- A notification, replaced by the answer. A Live Activity is parked for later.
- The answer is not read aloud.
- No live listening: "hey Life" is found in the written words, which Life makes as fast as it can. The 33 minutes came
  from something being offline, not from the normal path; the "heard late" state covers that case.
- The pendant only: the owner's phone works differently and is not part of this flow.

## Still open

- What turn by turn must solve before it ships: the "What it loses" section of
  [the proposal](../design/2026-11-23-chat-first/2026-11-27-v5-turns-proposal.md). The arrivals rule comes first.
- The build order: the proposal's slices.

## How the designs share their CSS (and the trap)

Every design is a dated, plain HTML file under `docs/design/`, built from shared parts:

- [`assets/brand/tokens.css`](../../assets/brand/tokens.css) is Life's brand.
- [`components.css`](../design/components.css) holds the rules the app v4 pages had in common that no other page's
  markup could pick up.
- `boards.css` is the 23 Nov boards' shared file.
- `2026-11-27-turns.css` is the turn pages' shared file.

A rule moves into a shared file only when no other page that links the file uses that rule's class names anywhere,
scripts included.

The trap: checking only a page's first render misses classes its scripts create in later states. PR 1503 fell into it:
the v5 mock's answer buttons lost their colour, and app v4's later scenes picked up foreign rules. PR 1504 fixed it.
Every page and every v5 state was then compared, pixel for pixel, with its version before PR 1503.

When you change a shared file, screenshot every state of every page that links it, before and after.

## Where the work stopped

- Merged in [PR 1504](https://github.com/eric-edouard/life/pull/1504): the "hey Life" page, `2026-11-27-turns.css`,
  the shared CSS fix and this note.
- Next: the arrivals rule (the owner's four "hey Life" decisions are made). Only after it comes the first build slice in the app (`Thread/ThreadView.swift` and one mesh view).
- Nothing turn by turn is approved; the app is still built to app v4.
