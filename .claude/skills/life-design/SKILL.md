---
name: life-design
description: >
  The brief for designing anything a person sees in Life: a screen, a component, a card, an answer, a prototype, the
  iPhone or Mac app's UI, a notification. Use it before any design, component, UI, prototype or screen work for
  Life's apps, and before building one in Swift or HTML. It holds the rules in force; its references open the real
  sources only when the work needs them.
---

# Designing for Life

The rules in force, newest decision first. The dated history is `docs/design/philosophy.md`; the full index is
`docs/design/sources-of-truth.md`. A decision of his is never asked again or designed away.

## The goal

- Lower his cognitive load and do things for him; show only what needs him or what he asked for
  (`docs/product.md`, "The rules"). The bar: a 70-year-old who doesn't know an iPhone.
- At a glance, with no context, anything he sees answers: what is this about, and what is asked of me?
- No agents, roles, models, prompts or tool names on screen. Every fact once; no number he can't act on.
- Minimalism is the brand: a mark over a word, fewer things over labelled buttons. An empty screen is fine.

## Composed, never bespoke

- Every screen is built only from Life's fixed components filled with data (the answer blocks, the card parts, App
  v4's components). Agents can't draw UI at runtime.
- A missing part is proposed as one general component with its data shape, marked "new component".
- The test: swap the example for a very different one (a photo cleanup for a party). If the screen breaks, it's bespoke.

## Turn by turn

The app's thread is turn by turn: the rule is `docs/design/philosophy.md`, "The thread" (its turn by turn line, 28 Nov),
built as `ThreadTurns` and `ThreadView`. `references/turns.md`.

## Answers

One headline sentence that answers him, then blocks over prose, then 2 or 3 follow-ups. A day's events are one
vertical timeline. `references/answers.md`.

## Cards

One decision per card, spoon-fed: what, why, what each answer does. One main button (cream, saying what it does) plus
small pills. The middle is drawn per kind (a payment: the amount, the payee's IBAN, a button that opens his bank). Also
shown: what happens if he doesn't answer, Life's plan steps, the sources read, next suggestions. `references/cards.md`.

## Drafts and the chat

One chat component everywhere: a head (picture or initials, name, app, arrow that opens the chat); only the messages
that matter, the rest one quiet count; opens on the latest. The draft takes the app's sent colour with a dashed
outline. `references/chat.md`.

## Look and motion

- Brand tokens are the only values: `assets/brand/tokens.css`. Dark only. No borders but the draft's dash and the
  edge. `references/brand.md`.
- Nothing jumps; what moves by itself is a short list. `references/motion.md`.
- iPhone Duo and regular iPhone place the top controls differently. `references/duo.md`.
- What the system really does, and how fast: `references/flow.md`.

## How a design is done

- A dated file under `docs/design/`, listed in `docs/design/README.md`, viewed at
  `https://designs.ericedouard.com/#/<path under docs/design>`. Never a claude.ai artifact or any other copy.
- Made-up names, places and numbers only; nothing of his in the repo.
- App v4 (`docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`) is what the app is built to, and where it draws
  something it wins, until he picks a drawn turn by turn. Explorations are proposals until he picks one.
- A new or changed card is scored first, as a screenshot, by a reviewer with no context. Done means ran live on his
  real Life, then compared with the prototype (`.claude/rules/surfaces.md`).
