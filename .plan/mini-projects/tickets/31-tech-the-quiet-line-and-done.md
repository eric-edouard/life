---
type: research
blocked_by: [07, 12]
---

# Technical: the quiet line and done

## Question

How the project's line and its done push are carried.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026.
- `set_wait` and `write_notes` (`desk/desk-door.ts:212`) take optional `doing` and `eta`, shown in `AgentNow` (`host/agents-now.ts:76`) and the app's under-way item (`host/life-thread.ts:113`).
- The done push is the done page's card through `pushNewCards` (`host/card-push.ts`); no second push path.
