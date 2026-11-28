---
type: research
blocked_by: [03]
---

# Technical: registering the project's agent

## Question

Where Life's code registers a one-off project's agent and gives its first wake.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026.
- A tick rule `openOneOffProjects` beside `openIntentions` (`desk/hand-out-tick.ts:71`, run at `desk/desk-clock.ts:787`): a project with a `goal`, under way, and no agent ever on it gets one through `register` (`desk/agent-actions.ts:214`), which learns to pass `said` (= the goal), with its work folder set (Technical: the project's folder) instead of `insertAgent`'s default (`:185`).
- The main session's `change_directory_entry` door (`desk/desk-door.ts:454`) also records `handed_work` for the ask's thread entry with a new `HANDED_KINDS` value `project` (`host/desk-turn-reads.ts:73`), so the app shows it under way.
- First wake: `firstTurnOf` (`desk/first-turns.ts:22`) gains a one-off project branch: the ask verbatim, the project, the thread entry ref, the playbook skill, the first look.
- `fetch` learns `thread:<id>`: a ref kind in `parseRef` (`memory/refs.ts:59`) and its reader in `find-refs`.
- `AGENTS.md` ("creates an agent only on his word: a project's") and the glossary's "registered agent" name this path (strict: the desk).

Built: https://github.com/eric-edouard/life/pull/1560
