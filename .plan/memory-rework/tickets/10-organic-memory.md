---
type: grilling
blocked_by: [01, 02]
---

# Organic memory

## Question

Which layer exists at which age: the detail kept near the present, how it gets broader and smaller with age, what counts as long-standing and is kept whatever its age, and which layers imports older than about a year skip. Includes whether the coded acts over the whole history count as evidence rather than memory a reader browses.

## Decided (10 Nov)

He left the shape to the designer ("I really don't know. You probably know better"); he can overrule any line.

- **Time is rolled up in calendar steps, per subject** (a person, a part of his life, him): month, then year, then
  the whole story. A finished month is read once, sealed, and keeps its address forever. Named periods and turning
  points are marked on top, as a view: no id depends on where a period starts or ends.
- **A level exists only where the one below is too big to read whole.** A friend he writes twice a year gets no
  monthly summaries; an old year whose evidence fits one call is read straight into its year. This is how old
  imports skip the middle layers, with no rule about age.
- **Folding up without reading history again** (his question, 10 Nov):
  - The evidence of a day or an exchange is written once, keyed by its text.
  - The open month is rebuilt from its evidence as days land. A year is rebuilt from its months, the story from its
    years: never from the raw, and never from its own last version, so it cannot drift.
  - A night rebuilds only the subjects the new day touched.
  - Counts are computed by code from the evidence at any span; they are never summarized, so they stay exact.
  - A better prompt or model rebuilds the upper levels from the evidence layer, not from the raw.
  - Late data (an import, a late sync) reopens only the months it lands in. His correction reopens only the month it
    touches: his word is an input to the build (ticket 18).
- **Long-standing: carried to every level by rule, never left to a summarizer's memory.** Turning points (a
  beginning, an end, a move, a break, a making up); a pattern, with its count and when it was first and last seen;
  the facts of his biography (ticket 05); what he marked, told Life or corrected; his decisions and stated views;
  what was opened and never closed.
- **Near now**: the open month and "where it stands" (today's situation, widened to every subject) are the detailed
  end; the coded acts and measured facts under them cover every age, as evidence an agent reaches only by zooming in.

## Changed by the spec's second draft (after the review of 10 Nov)

Section 11 of [spec.md](../spec.md) holds this now. What moved: a month is read from its own evidence only, with no
story as context (a hidden input broke its key); a changed summary is rebuilt at the next build and its old version
stays in the data repo's history, so nothing is "sealed for ever"; a history is built when first asked for, not for
everyone every month; the story is rebuilt at a year's end or a turning point.
