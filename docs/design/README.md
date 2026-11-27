# Designs

Every design of Life's app, by date, each named `YYYY-MM-DD-<name>` by the day it was first made. Open them in the
designs app (`apps/design`): https://designs.ericedouard.com from any device, served by the Mac from its live checkout
(`bun run design`, kept up by launchd), so it always shows what the checkout holds. Its tabs are this file's sections
below, each row an entry; it shows a page whole on any screen and draws the design system from `tokens.css`. Added to a
phone's home screen, it opens full screen on the approved prototype. These files are the only source: nothing is
published as a copy (no claude.ai artifacts). A new design goes here, dated, and a row below lists it.

The pages share their parts instead of copying them. Life's brand is [`assets/brand/tokens.css`](../../assets/brand/tokens.css).
[`components.css`](components.css) imports it and holds the rules the app v4 pages had in common that no other page's markup could pick up.
The turn by turn pages share [`2026-11-27-turns.css`](2026-11-23-chat-first/2026-11-27-turns.css). A rule only one page uses stays in that page.

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

Drawn from `assets/brand/tokens.css`, with the notes and catalogs built on it.

| Design | What it is |
|---|---|
| [Answers](2026-11-23-chat-first/2026-11-25-answer-components.html) | Every kind of answer the app can give, as its blocks |
| [Design system notes](2026-11-23-chat-first/2026-11-25-app-v4-design-system.md) | The parts, sizes and motion of app v4 |

## Philosophy and guidelines

| Design | What it is |
|---|---|
| [Philosophy and guidelines](philosophy.md) | The goal, the strategy, every rule and decision of the owner's, dated |

## Explorations

Proposals: none is built until the owner bakes it into the prototype.

| Design | What it is |
|---|---|
| [Turn by turn: five directions](2026-11-27-turn-by-turn-v2/index.html) | Five ways the turn by turn could look and move (cinema, living page, face to face, cards on the table, path of work), on App v4's edge glow; play the same moment in each |
| [Turn by turn: the real flow](2026-11-27-turn-by-turn-v2/2026-11-28-real-flow.md) | What really happens when you ask Life, with measured timings and your decisions of 28 Nov; the five directions follow it |
| [Hey Life, turn by turn](2026-11-23-chat-first/2026-11-27-hey-life-turns.html) | “Hey Life” from your words to the answer: heard, the tap, Life working, the answer; not heard, offline, slow, couldn’t do it, heard late |
| [v5 turn by turn](2026-11-23-chat-first/2026-11-27-v5-turns.html) | Turn by turn instead of a thread, chosen as the next direction on 27 Nov 2026; [the verdict](2026-11-23-chat-first/2026-11-27-v5-turns-proposal.md), [where it stands](../handoff/2026-11-27-turn-by-turn.md) |
| [First screen](2026-11-23-chat-first/2026-11-26-first-screen.html) | What the phone opens on |
| [Design lab](2026-11-23-chat-first/2026-11-26-design-lab/index.html) | Every card and page in variants A, B, C, drawn in the prototype |
| [Settings board](2026-11-23-chat-first/2026-11-25-settings-board.html) | Nine settings proposals, not decided |

The 21 Nov canvas (about 490 frames from before chat-first) stays on claude.ai only: its frames need the Design tool's
runtime to draw. Earlier files (reviews, audits, their screenshots, the 23 Nov canvas) are in git history.
