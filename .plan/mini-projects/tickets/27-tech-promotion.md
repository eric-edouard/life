---
type: research
blocked_by: [01, 03]
---

# Technical: promotion

## Question

How an agent's "this is a project" becomes a project and its agent.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026. Owner, 28 Nov 2026: a fresh start, and the truth/ rule amended.
- A door tool `promote` for agents (`desk/desk-door.ts`, `desk/agent-actions.ts`), naming the handed work's thread entry and the agent's notes on that ask.
- Code writes the project through `changeDirectoryEntry` with `said` = that entry's words (`handed_work.entry_id` → `thread_entry.words`), never the agent's text; the agent's word only triggers it. `AGENTS.md`'s "Only the owner writes truth/" gains this door (strict path).
- Then `openOneOffProjects` registers the project's agent; its first wake also carries the old agent's notes on that ask. No `moveAssignment`: the Personal agent's shared assignment stays whole; it drops that ask.
