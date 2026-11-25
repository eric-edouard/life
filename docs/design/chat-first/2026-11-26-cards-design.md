# Ask cards with no design yet (26 Nov 2026)

What each card shows, in its recommended variant, and what only the owner can decide. Each item is one use case, and its three variants
show that same case in three designs; they are in `prototypes/2026-11-26-card-variants.html`, where he picks or mixes; `shell.html` plays the recommended
ones (side panel, "Cards with no design until 26 Nov"). Both draw cards from one file, `prototypes/card-blocks.js`:
a card is data (which blocks, in which order, in which mode).

Sources: `docs/research/2026-11-26-ask-coverage.md` (every kind the server sends), `memory/card-request.ts`,
`memory/needs.ts`, `memory/checks.ts`, `memory/life-checks.ts`, `memory/draft.ts`.

## The seven cards

| Card | What it shows | Answers |
|---|---|---|
| Voice naming, with a guess | Who is this voice?, where it was heard and how much; each clip with a play button and its words; a hint that TV or radio can be named so | Yes, Nora (Life's guess) · Someone else… · Don't name |
| Voice naming, no guess | The same, then the people it may be as rows, someone new last; someone new asks their name in the thread | (the rows) · TV or video · Don't name |
| New matter | The matter as a title, where it came from; its goal and next step; one line on what Start does ("nothing goes without you") | Start · Edit goal · Not this |
| Is this done? | On its matter's page only, on the step it would close: the later words that seem to close it | Yes, done · Not yet |
| Same person | The two side by side, each with where he sees them | Same person · Different |
| Contacts card | The card's name and number, then the people it may be; a tap on one answers | (the rows) · Someone new |
| At organization | Is Lea at Fernway?, with the role and where it comes from | Yes · No |
| Your move | His step with where and when (place, phone) | Mark as done · Hand it to Life (when Life can) · Later · Drop |

## What a card shows so he can answer without leaving

| Detail | Recommended |
|---|---|
| Amount and account | The amount large, the account as rows, a link to his bank |
| Payment code | The code large enough to scan, the amount, the message it came from |
| Link | A preview: the vendor, the page's title and domain |
| Event | A box: when, where, its reminders as chips |
| Paid search | What it gets, "About $1.20", "Never more than $3" |
| Plan | Each step with who does it (his steps marked You) and when; the source chip under |
| Context | A short paragraph with Life's links in it, then a quote and its source |
| Seen done | Nothing to tap: when the payment shows in his bank, the ask closes itself and Life says so once |
| Voice clip | Play, waveform, the words |

## Answers

| Answer | Recommended |
|---|---|
| Add to calendar | The row's line becomes "In your calendar · Thu 18:00 · Undo" |
| Run it | The row shows a still ring and "about 4 min", then "38 found · cost $1.10" |
| I paid it (looks) | "Looking in your bank…", then found, or "Not in your bank yet · I look again until Fri" |
| How am I doing? | The bar under a settled row: three monotone marks and a cross (as in v4) |
| Changing a draft by a tap | Quick-edit chips under the draft change it in place, with a back arrow (as in v4) |
| Changing a draft by words | The old card folds to an "Earlier draft" row; his words, then a new card below (as in v4) |
| A late reply | His question quoted on top of Life's reply |
| I'm on it | A sentence, then the row with a still ring and its estimate (as in v4) |
| Life's mark on his bubble | On the bubble's corner, monotone (as in v4) |

## Left out on purpose (a builder's view, not his)

- No clip count, conversation list or likeness score on the voice card; two clips and the words are enough.
- No Apify actor name or input, no plan step roles, no importance or urgency badges: none helps him answer.
- No "more details" on any card: the context is the detail, and he can ask.

## Open questions for the owner

Each with the recommendation first.

1. The new matter card's server words say "Start an agent on this?", "Start an agent" and "No agent", which name
   the agent. Show the matter's title as the question and answer "Start" and "Not this".
2. "Your move" also offers Hand over when Life could do the step. Keep it as a pill, "Hand it to Life", only then;
   Mark as done stays the recommended answer (variant B makes Hand over first).
3. "Is this done?": ask on the step (A), rather than show it done with one tap to reopen (C). Closing a step wrongly
   hides something he still owes.
4. A paid search costs dollars (Apify bills in dollars) while his monthly amount is in euros. Show it in his currency,
   "about 1.10 €".
5. When Life can see the payment in his bank, show no "I paid it" at all and close the ask when it appears (seen
   done, C). Keep "I paid it" only where Life cannot see it.
6. A Contacts card's row answers on one tap, with Undo on the row after, and no confirm step.
