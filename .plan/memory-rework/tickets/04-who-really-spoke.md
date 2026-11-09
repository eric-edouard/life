---
type: research
blocked_by: []
assets: [.plan/memory-rework/assets/04-who-spoke.md]
---

# Who really spoke in a recording

## Question

Recordings sometimes name the wrong speaker, and a quote about someone gets taken as their own words. lifelog holds a speaker score and lead, but its REST contract doesn't expose them to Life. Find what lifelog knows per turn, what its contract should expose, and the rule that decides when a recorded turn counts as a person's own evidence.

## Answer

Detail in [04-who-spoke.md](../assets/04-who-spoke.md), checked against lifelog's code (`config.ts` `RECOGNITION`, the
contract's `SpeakerAssignment`).

- lifelog knows how each recorded turn got its name: assigned by the owner, matched by voice (score and lead over the
  runner-up, bar 0.1 lead; its own replay still names about 5% wrong), or inferred from a nearby recording. None of this
  crosses its contract today; Life only sees a name.
- The contract gains one additive field per turn, `speaker.basis`: `method` (`assigned`, `matched`, `inferred`, `none`),
  `score` and `margin` (nullable). lifelog keeps its thresholds; Life branches on `method` only.
- The rule: `assigned` and `matched` turns are the person's own evidence; `inferred` turns are context only and never
  feed a meter or a pattern; `none` counts for nothing. His own short uncertain turns don't disqualify an exchange.
- About 6% of named turns by others are `inferred` and would be set aside; nearly half of others' turns are unnamed.
- Open, carried to the ticket The exchange: whether an inferred name shows as "probably", whether a just-over-the-bar
  match keeps the 0.6 cap on claims about others, and his approval of the field's name.
