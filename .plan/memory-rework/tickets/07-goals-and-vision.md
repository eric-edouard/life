---
type: grilling
blocked_by: [02]
---

# Goals and vision

## Question

How Life tracks each goal in `truth/me.md` (evidence of progress, time and money actually spent on it, what moved it), and how it sets his long-term vision against where the years are actually heading. Includes what Life counts by code and what a model reads.

From issue #390: hours per project, area and person per week, counted by code from commits, Screen Time, episodes and voice minutes; drift from his goal order flagged.

From the architecture (10 Nov): his vision, goals in order and the plan for each are the declared side of Life's
list, seeded by an onboarding and kept current by what Life hears and by questions asked in conversation; the
observer measures his actions against it.

## Decided so far (10 Nov)

- His declared goals and their order move only when he tells Life (his answer). A remark heard in passing, in a
  recording or to a friend, is kept as "heard, not confirmed" and becomes a question an agent asks him; said for
  effect or to please, it never reorders his goals by itself. His actions are measured against the declared order,
  and the gap is written (ticket 08).

## Decided by the designer (10 Nov; spec sections 7, 9)

- A goal is a subject. Counted by code: hours and money per project, area and person per week, set against his
  declared order. Read by a model: what moved it, and the meaning of the gap.
- His vision is declared in the interview and kept current like the goals; the year level of his own history shows
  where the years are heading against it.
- A new Life starts with an interview: goals and objectives, and how he plans to get there (his word, 10 Nov).
