---
type: grilling
blocked_by: []
---

# Scale, and the value of a read

## Question

His word (10 Nov): be careful about the exponential reads problem. The project must scale reasonably while
maximizing information value. So: where could the number of model reads multiply (by families, by subjects, by
levels, by re-reads, by cascades), what bounds each, and how is a read spent where it tells the most.

## Where reads could multiply in the spec as drafted (designer's analysis, 10 Nov)

| Multiplier | Why it happens | Bound to write into the spec |
|---|---|---|
| Families per exchange | Four new focused reads beside today's two: six passes over the same words | One full read of every exchange, which also says which families have something; a focused read runs only where it does. The pilot measures what routing misses |
| Tiny exchanges | A three-line exchange pays a whole prompt and codebook | Short exchanges of one chat are read together, by month, in one call |
| Subjects per record | A record about him, a person and a project is read by each one's month summary | A record is summarized under at most two subjects besides him |
| His own history | He is in every exchange, so his month would read everything again | His month reads the month's episodes, what he says of himself, what code measured and the other subjects' month summaries, never their acts |
| Cascades | One late message reopens a month, its year, its story, the overview, for each subject | A sealed month reopens only for evidence that matters; the rest joins a late tail. Upper levels read only their children, so a cascade is a few small calls |
| Nightly standings | Thirty subjects touched in a day, thirty calls | A standing is rebuilt only when its tail matters or grew; otherwise the reader gets summary plus tail |
| Rebuild under a new model | Every month of every subject | Only where a level exists; cost follows the size of the evidence, never the raw |
| Forecast samples | Several model samples per forecast, every night | A model is used only for kinds where backtests showed a gain, with a cap per night |
| The agent's own reads | An agent wandering from subject to subject | Five steps down at most, each pointing at the next; search lands at the right level |

## The law to state

- Every model read is of new text, once. Nothing is multiplied by subjects times time.
- Over his whole life, the words sent to a model stay a small constant times the raw words: the evidence reads, then
  summaries that shrink at each level.
- No single read's input grows with the years: each has a fixed size.
- A night costs what its day holds. A rebuild costs what the evidence holds.

## Spending a read where it tells the most

- Coverage is his decision and stays: every two-sided exchange is read by a model at least once, at any age.
- Depth follows what the exchange holds, not who it is with.
- Each family must earn its read on the pilot: remove it, and if no answer to his questions changes, it is not run
  over the history.
- The order of the backfill follows expected value (the pilot's people first, then by depth of the tie), so a
  stop at any point leaves the most useful part done.
- The cost of each layer over the whole history is counted and shown to him before any backfill.

## Where it is decided

Section 14 of [spec.md](../spec.md), corrected by the review: the first analysis above claimed "every read is of new
text, once" and "no read grows with the years"; both were false as drafted (the story, the situation's tail,
backtests). The reviewer's count for the first draft: about 12 to 23 times the raw text a year, none of it measured.
