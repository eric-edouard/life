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

## The rules

`docs/design/philosophy.md`, "Items and asks", "Buttons and colour", "Taps and feedback" and the 28 Nov log (cards:
one main button, the middle per kind, what happens if he does not answer, plan steps, sources, next suggestions).

## Designs to start from

- App v4 and its rulebook: `docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`,
  `2026-11-26-original-components.md` (open the section you need, not the whole file).
- Card shapes exploration (one shape, a shape per kind, spoken): `docs/design/2026-11-28-card-shapes/index.html`.
