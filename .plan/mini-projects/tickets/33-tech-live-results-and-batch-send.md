---
type: research
blocked_by: [20, 21]
---

# Technical: live results and batch send

## Question

How a live result wakes its agent, and how a card sends many drafts.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026.
- Live results: a new `EventChannel` `artifact_activity` in `EVENT_CHANNELS` (`host/event-channels.ts:306`), polled only for waits naming it (`pollChannels`, `desk/event-queue.ts:186`); fed by the artifact system (a separate effort, owner 28 Nov 2026).
- Batch send: `Decision` holds `drafts: StoredDraft[]` (`memory/card-request.ts:82`); the send (`actOfOption` `send`, `memory/decisions.ts:116`, `sendStepsOf`), `wroteSince` and the contest (`heldChatOf`, `memory/draft-contest.ts:89`) loop per chat. `AGENTS.md`'s send invariant ("the one chat named") is amended; strict path, its own PR.
