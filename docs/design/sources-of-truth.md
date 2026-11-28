# Sources of truth

What any person or agent reads before designing a screen or building a component, in this order. On what a screen should
be, an earlier source wins over a later one, and within one the newest dated line wins; what the system really does
(6, 7) bounds what can be built, so a design it can't carry proposes the change, marked "new component". Every design or component brief names this page (`AGENTS.md`,
Workflow); nothing else is put in front of an agent on its own.

Composed, never bespoke: a screen is built only from these components filled with data, a missing one proposed as a
general component with its data shape (marked "new component"), and checked by swapping its example for a very
different one ([philosophy](philosophy.md), "How a design is done").

## What it must follow

1. [Product rules](../product.md): what any screen, notification or mail shows, and when. The owner's rules about what
   reaches him.
2. [Philosophy and guidelines](philosophy.md): every design decision the owner took, with its date, and the log. A
   decision here is never asked again or designed away.
3. [App v4](2026-11-23-chat-first/2026-11-25-app-v4.html) and its [rulebook](2026-11-23-chat-first/2026-11-26-original-components.md):
   the one approved design. The app is built to it.
4. The brand: [`tokens.css`](../../assets/brand/tokens.css) (every colour, size, radius and motion value),
   [`docs/brand.md`](../brand.md) and the [app v4 design system notes](2026-11-23-chat-first/2026-11-25-app-v4-design-system.md).
   The designs app's Brand, Glow and Components pages draw them live.
5. [The glossary](../glossary.md): the one name of each thing, on screen and in code.

## What the system really does

6. [The real flow](2026-11-28-turn-by-turn-v3/2026-11-28-real-flow.md): what happens between an ask and its answer,
   its timings, and the data each step has.
7. The data a screen can draw: a card's parts (`apps/server/src/memory/card-request.ts`, `needs.ts`, `draft.ts`) and an
   answer's blocks (`apps/server/src/records/answer-blocks.ts`). A design may propose more, marked "new component".

## What is built

8. [The parity board](2026-11-23-chat-first/2026-11-26-parity-board.html) and the
   [parity handoff](../handoff/2026-11-27-app-parity.md): which prototype states the app matches today.

## Not sources

Explorations (the Explorations tab, turn by turn included) are proposals. They become a source only once a decision in
the philosophy page bakes them into App v4.
