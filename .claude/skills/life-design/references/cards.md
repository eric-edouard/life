# Cards

A card is one decision of his. Read the real shape before drawing one; never draw a field the server can't send
without marking it "new component".

## The data

- The card an agent asks: `Ask` in `apps/server/src/memory/card-request.ts:72` (`title`, `ask`, `question`,
  `options`, `recommended`, `follow`, `context`, `deadline`, `onSilence`, `plan`, `needs`, `draft` or `drafts`).
  What each field means and its length: `CARD` at `card-request.ts:137`; what a card must pass before it is asked:
  `CARD_SELF_CHECK` at `card-request.ts:134`. An option's acts (`outgoing`, `ends`, `looks`, `runs`, `takes`):
  `Option` at `card-request.ts:22`; plan steps: `PlanStep` at `card-request.ts:43`.
- What he needs in hand (the middle of a card, per kind): the registry `KINDS` in `apps/server/src/memory/needs.ts:165`
  (`access`, `account`, `amount`, `app`, `apify`, `event`, `link`, `text`, `place`, `qr`), each with its `line` and
  its page.
- The kinds of card he sees: `CheckKind` in `apps/server/src/memory/life-checks.ts:179` (`decision`, `ending`, `fix`,
  `new matter`, `person`, `voice`, `your move`); how each is built: `BUILDERS` in `apps/server/src/memory/checks.ts:143`.
- A draft on a card: `apps/server/src/memory/draft.ts` (`MessageDraft:22`, `StoredDraft:76`, several drafts with one
  Send all: `isBatchOf:115`). See `chat.md`.

## The rules in force (philosophy.md, "Items and asks", "Buttons and colour", 28 Nov log)

- One decision per card: what, why, what each answer does. The title is the one-line ask, verb first.
- A card that arrives says first why, in one line ("Sam just texted that Café Dalon is closed today. Here's your draft.").
- One main button, cream, full width, saying what it does ("Send to Nora"); the rest small equal pills. Side by side,
  Later first and the main answer on the right.
- The middle is drawn per kind: a payment is the act first, then the amount large, the payee and IBAN in mono, the
  reference, and a button that opens his bank; a calendar add is when, where, reminder; a fix is why and numbered steps;
  a choice is option cards with Life's pick in blue.
- Also shown: what happens if he doesn't answer (`onSilence`), Life's plan steps (`plan`), the sources read
  (`context` links), next suggestions (`follow`).
- No matter shown on an ask; no "more details" button; every fact once.
- Taps show their result on the button: doing, then done for a second, then the new state; failures on the button.

## Designs to start from

- App v4 and its rulebook: `docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`,
  `2026-11-26-original-components.md` (open the section you need, not the whole file).
- Card shapes exploration (one shape, a shape per kind, spoken): `docs/design/2026-11-28-card-shapes/index.html`.
