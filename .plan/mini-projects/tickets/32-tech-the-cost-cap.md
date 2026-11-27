---
type: research
blocked_by: [10]
---

# Technical: the cost cap

## Question

How a project's cap is set and held.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026.
- "Build it" records the cap as a `budget` instruction scoped `project:<id>` (`recordInstruction`).
- `spendingStopNow` (`desk/desk-clock.ts:663`) reads `instructionsFor({project})` when the agent has a project and no matter (today it reads only by `matter_id`, so a project gets the 2% default), summing the project's assignments.
- The caps of running projects add up against the monthly amount (`monthBudgetOf`); a project with no room left waits and says so. pi's in-turn stop (`/spending`) is unchanged.
