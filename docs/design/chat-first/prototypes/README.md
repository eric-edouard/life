# Chat-first prototypes

Explanation: the HTML prototypes of the chat-first app as they stood on 25 Nov 2026, copied from the owner's private
artifacts so a new design session can open them, change them and publish them again. Every person, place, business and
order in them is made up: the live artifacts use the owner's real questions, these copies do not. Keep it that way
(`AGENTS.md`: nothing personal is committed here).

| File | What it is | Its live artifact (private to the owner) |
|---|---|---|
| `shell.html` | The interactive phone: the thread, the field, the edge, asks, profiles, answers to real questions, failures, notifications, and since 25 Nov (v4) long work handed off, redrafts, reactions, "How am I doing?", Undo after a send, settings in the thread, held asks and the spending stop. The side panel drives it. | [app v4](https://claude.ai/artifact/CvbKKXFzYTko1SZMNB2GrF); before v4: [Life shell prototype](https://claude.ai/artifact/7DNThcrd9u89WPWhjfBFCg) |
| `design-lab.html` | The design lab: one phone, one item at a time; A, B and C swiped sideways; pick, mix and a note per item, saved to the artifact's store; Prototype mode plays `shell.html` with his picks. Holds every card item, the design system, the answer components, the Settings proposals, the aura and his decided answers | [Life design lab](https://claude.ai/artifact/CWn2a8uSCY22i3CMcpB1Cs) |
| `card-blocks.js` | The one set of parts (the design system) the lab and the shell draw from: a card is data, never hand-written markup | (no artifact of its own) |
| `card-variants.js` | Every card item and its variants, as data | (no artifact of its own) |
| `lab-pages.js` | The design system's views, the answer components (from the old `answer-components.html`), the nine Settings proposals (from the old `settings-board.html`) and his eleven answers, as data | (no artifact of its own) |

## Read first

1. [`../2026-11-23-current-spec.md`](../2026-11-23-current-spec.md): what is decided, in one place. It wins over the prototype where they differ.
2. [`../2026-11-23-design-decisions.md`](../2026-11-23-design-decisions.md): how each decision was reached.
3. [`../2026-11-23-answer-components.md`](../2026-11-23-answer-components.md) and [`../../../plans/2026-11-23-chat-first-app.md`](../../../plans/2026-11-23-chat-first-app.md).
4. `docs/product.md` and `docs/brand.md` (tokens in `assets/brand/tokens.css`).

## The owner's standing rules for design

- The least to think about: do everything that can be done without him, show only what needs him or what he asked.
- The yardstick: what a human assistant could do for him in iMessage or WhatsApp, Life does in its thread.
- No words on buttons except "Later": icons, and the answer's own words on an ask's options.
- No agent names or roles anywhere he looks; "Life is working on it".
- Warn him when a UI idea serves a builder's view rather than his (a "more details" button, a full list, a toggle just in case).

## Working on a prototype

- Edit the file here, then render it with Playwright (Chromium is preinstalled) to check, and publish it as an artifact
  for the owner to try on his phone. In the owner's own session, the live artifact may use his real data; never copy
  that back here without replacing every name, place, business and number.
- The shell is one file: CSS first, then a script with the asks (`ASKS`), the questions he tries (`TRY`), the failures
  (`SYSD`) and the profiles (`PEOPLE`). Its side panel lists every scenario.

## Settings: open (proposals of 24 Nov 2026, in the lab)

Three ideas for each of: how he wants things (1A one page of his choices, 1B no page, the thread is the setting, 1C each
choice on its person or matter); something broken first (2A a card atop Settings, 2B the count pill becomes a warning
with the fix as a sheet, 2C the phone warns when Life itself is down, with mail as a second path); direct or smart mode
(issue #1376: 3A one setup card in the thread, 3B a choice per person, 3C the "Life only" checklist, app by app).
Recommended, not decided: 1C with 1B, 2B with 2C, 3A then 3C. Settings keeps only mode, devices and sending; live logs,
diagnostics and the agents count go behind one "For the developer" row. Not yet drawn: Face ID before Send changed by
voice still asks for Face ID.
