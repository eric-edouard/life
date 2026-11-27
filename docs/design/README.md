# Designs

Every design of Life's app, by date. Each is plain HTML: open it in a browser, or serve the repo
(`python3 -m http.server`) for the pages that read a neighbour (the lab, the parity board). Each is named
`YYYY-MM-DD-<name>`, by the day it was first made.

To view one, from any device: https://designs.ericedouard.com/docs/design/ serves the Mac's live checkout (`main`)
as it is, so git stays the only source. Nothing is published as a copy (no claude.ai artifacts).

The pages share their parts instead of copying them. Life's brand is [`assets/brand/tokens.css`](../../assets/brand/tokens.css).
[`components.css`](components.css) imports it and holds the rules the app v4 pages had in common that no other page's markup could pick up. The 23 Nov boards
have their own shared file, [`boards.css`](2026-11-23-chat-first/2026-11-23-design-canvas/boards.css), because their class
names mean other things. The turn by turn pages share [`2026-11-27-turns.css`](2026-11-23-chat-first/2026-11-27-turns.css). A rule only one page uses stays in that page.

## Approved

| Date | Design | What it is |
|---|---|---|
| 25 Nov 2026 | [App v4](2026-11-23-chat-first/2026-11-25-app-v4.html) | The one approved design: the app is built to it (the owner's yes of 26 Nov 2026). Its parts are in [the design system](2026-11-23-chat-first/2026-11-25-app-v4-design-system.md) and [the guidelines](2026-11-23-chat-first/2026-11-27-v4-guidelines.md) |

## Proposals

None is built until the owner picks it into App v4.

| Date | Design | What it is |
|---|---|---|
| 25 Nov 2026 | [Answer components](2026-11-23-chat-first/2026-11-25-answer-components.html) | The blocks an answer is made of |
| 25 Nov 2026 | [Settings board](2026-11-23-chat-first/2026-11-25-settings-board.html) | Nine settings proposals, not decided |
| 26 Nov 2026 | [First screen](2026-11-23-chat-first/2026-11-26-first-screen.html) | What the phone opens on |
| 26 Nov 2026 | [Design lab](2026-11-23-chat-first/2026-11-26-design-lab/index.html) | Every card and page in variants A, B, C, each pick saved; it draws them in the App v4 prototype |
| 27 Nov 2026 | [v5 turn by turn](2026-11-23-chat-first/2026-11-27-v5-turns.html) | Turn by turn instead of a thread; [the verdict](2026-11-23-chat-first/2026-11-27-v5-turns-proposal.md); the owner chose this direction on 27 Nov 2026, [where it stands](../handoff/2026-11-27-turn-by-turn.md) |
| 27 Nov 2026 | [Hey Life, turn by turn](2026-11-23-chat-first/2026-11-27-hey-life-turns.html) | “Hey Life” from your words to the answer: heard, the tap, Life working, the answer; not heard, offline, slow, couldn’t do it, heard late |

## Tools

| Date | Design | What it is |
|---|---|---|
| 26 Nov 2026 | [Parity board](2026-11-23-chat-first/2026-11-26-parity-board.html) | Each prototype frame beside the app's screenshot; `bun run parity` writes its pairs to `parity/`, which is never committed |

## Superseded

| Date | Design | What it is |
|---|---|---|
| 21 Nov 2026 | [Life app canvas](https://claude.ai/artifact/1TKciQqLXVGnQ3dBEBXfPm) | About 490 frames from before chat-first (an agents list, tabs). It stays on claude.ai only: its frames need the Design tool's runtime to draw, and the agents list was dropped on 22 Nov 2026 |
| 23 Nov 2026 | [Chat-first canvas](2026-11-23-chat-first/2026-11-23-design-canvas/main.html) | The first chat-first boards: [the edge](2026-11-23-chat-first/2026-11-23-design-canvas/main.html), [an answer](2026-11-23-chat-first/2026-11-23-design-canvas/flow-answer.html), [going deeper](2026-11-23-chat-first/2026-11-23-design-canvas/flow-deeper.html), [later](2026-11-23-chat-first/2026-11-23-design-canvas/flow-later.html) |

Reviews, audits and screenshots sit beside the designs in `2026-11-23-chat-first/`, each dated the same way.
