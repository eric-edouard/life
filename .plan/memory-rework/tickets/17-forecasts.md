---
type: grilling
blocked_by: [13, 16]
---

# Forecasts

## Question

What Life predicts: about people (from both personas when he is involved), about him (his usual move, what happens if he does nothing), about his areas and goals; in the short, medium and long term. Built-in forecasts vs an agent reasoning from the persona; the backtest gate before any forecast drives anything (research 06, 10, design 11b).

From issue #390: a decision with what he expected, read again months later against what followed.

His word (10 Nov): forecasting always improves itself from the predictions that came true and those that did not,
and that adjusts the persona. In the architecture: what happened is evidence, so the counts move; each kind is
recalibrated from its score; a run of misses reopens the subject's reading and marks a possible turning point.

## Decided by the designer (10 Nov; spec section 10)

- A forecast is a record with its check day and score; kinds, horizons, base rates first, the backtest gate, free
  questions scored apart, and the loop that closes by itself: all in the spec.
