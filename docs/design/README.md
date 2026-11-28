# Designs

Every design of Life's app, by date, each named `YYYY-MM-DD-<name>` by the day it was first made. Open them in the
designs app (`apps/design`): https://designs.ericedouard.com from any device, served by the Mac from its live checkout
(`bun run design`, kept up by launchd), so it always shows what the checkout holds. Its tabs are this file's sections
below, each row an entry; it shows a page whole on any screen and draws the design system from `tokens.css`. Added to a
phone's home screen, it opens on its list, the three latest changed designs first, and each design fills the whole
screen as the app would, the list a tap away. These files are the only source: nothing is
published as a copy (no claude.ai artifacts). A new design goes here, dated, and a row below lists it.

The pages share their parts instead of copying them. Life's brand is [`assets/brand/tokens.css`](../../assets/brand/tokens.css).
[`components.css`](components.css) imports it and holds the rules the app v4 pages had in common that no other page's markup could pick up.
The turn by turn pages share [`2026-11-27-turns.css`](2026-11-23-chat-first/2026-11-27-turns.css). A rule only one page uses stays in that page.

## Start here

| Design | What it is |
|---|---|
| [Sources of truth](sources-of-truth.md) | What any person or agent reads before designing a screen or building a component, in order |

## Prototype

The one approved design: the app is built to it (the owner's yes of 26 Nov 2026). Nothing else here is a target until it
is baked into it.

| Design | What it is |
|---|---|
| [App v4](2026-11-23-chat-first/2026-11-25-app-v4.html) | The interactive phone, every scenario in its side panel |
| [Rulebook](2026-11-23-chat-first/2026-11-26-original-components.md) | What each of its parts is and does |

## Parity

| Design | What it is |
|---|---|
| [Parity board](2026-11-23-chat-first/2026-11-26-parity-board.html) | Each prototype state beside the app's screen of it, and whether it is green. `bun run parity` writes it to `parity/` (never committed); the owner's verdicts are [`parity-verdicts.json`](parity-verdicts.json), told in chat |
| [Reviewer prompt](2026-11-23-chat-first/2026-11-26-parity-review.md) | What the fresh reviewer is asked of each pair |

## Design system

Three pages the designs app draws itself, never copies:

- **Brand:** every value of [`tokens.css`](../../assets/brand/tokens.css) and the mark, with the rules of
  [`docs/brand.md`](../brand.md) and the [app v4 notes](2026-11-23-chat-first/2026-11-25-app-v4-design-system.md).
- **Glow:** the edge round every screen, live in each of its states.
- **Components:** every component of the approved prototype, live, its variations side by side, the
  [Answers](2026-11-23-chat-first/2026-11-25-answer-components.html) among them. The list is
  [`components.json`](components.json): each variation's scene, the part it draws, its parity board row and its status.
  "In the app" is never typed: it shows while that row is green. Every side-panel scene is a variation's or in its
  `leftOut` with why, so the board and the list cover the same scenes (`components.test.ts` checks).

## Philosophy and guidelines

| Design | What it is |
|---|---|
| [Philosophy and guidelines](philosophy.md) | The goal, the strategy, every rule and decision of the owner's, dated |

## Explorations

Proposals: none is built until the owner bakes it into the prototype.

| Design | What it is |
|---|---|
| [Mini projects](2026-11-28-mini-projects/index.html) | A one-off project from the ask to done, on App v4's thread: the project row and its quiet line, the access card whose steps tick themselves, the questions card, the preview and plan with Build it, a batch's yes, sending many in one card, over its cap, waiting for room in the month, the done page, dropped and parked; made-up data, new parts marked "new block" |
| [The chat, one component](2026-11-28-chat-component/index.html) | The one chat Life shows wherever a chat shows, three ways (as the app, as Life's thread, as a transcript), in every app and draft it takes; the two not chosen are deleted |
| [Card shapes](2026-11-28-card-shapes/index.html) | What goes in a card, every card kind of App v4 three ways: one shared shape, a shape per kind, or spoken (Life says the card as a sentence, the thing itself under it); each folded in the turn by turn's sideways row, unfolding on a tap; pick a kind and a variation |
| [Turn by turn: five directions](2026-11-27-turn-by-turn-v2/index.html) | Five ways the turn by turn could look and move (cinema, living page, face to face, cards on the table, path of work), on App v4's edge glow and top controls (tap the waiting count or the pendant); cards swipe sideways, one per item; play the same moment in each, the home with matters waiting included |
| [Turn by turn: the real flow](2026-11-27-turn-by-turn-v2/2026-11-28-real-flow.md) | What really happens when you ask Life, with measured timings and your decisions of 28 Nov; the five directions follow it |
| [Hey Life, turn by turn](2026-11-23-chat-first/2026-11-27-hey-life-turns.html) | “Hey Life” from your words to the answer: heard, the tap, Life working, the answer; not heard, offline, slow, couldn’t do it, heard late |
| [v5 turn by turn](2026-11-23-chat-first/2026-11-27-v5-turns.html) | Turn by turn instead of a thread, chosen as the next direction on 27 Nov 2026; [the verdict](2026-11-23-chat-first/2026-11-27-v5-turns-proposal.md), [where it stands](../handoff/2026-11-27-turn-by-turn.md) |
| [First screen](2026-11-23-chat-first/2026-11-26-first-screen.html) | What the phone opens on |
| [Design lab](2026-11-23-chat-first/2026-11-26-design-lab/index.html) | Every card and page in variants A, B, C, drawn in the prototype |
| [Settings board](2026-11-23-chat-first/2026-11-25-settings-board.html) | Nine settings proposals, not decided |

The 21 Nov canvas (about 490 frames from before chat-first) stays on claude.ai only: its frames need the Design tool's
runtime to draw. Earlier files (reviews, audits, their screenshots, the 23 Nov canvas) are in git history.
