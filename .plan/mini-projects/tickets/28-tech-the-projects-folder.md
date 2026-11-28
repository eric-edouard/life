---
type: research
blocked_by: [14]
---

# Technical: the project's folder

## Question

Where the project's work lives with its own git.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026. Owner, 28 Nov 2026: outside the agents repo.
- The work folder is `<LIFE_STATE_DIR>/projects/<id>/` with its own git (one commit per checked step, the playbook); the agent's home in the agents repo (`agentHomeOf`, `host/desk-read.ts:254`, committed by `commitAgentFiles`, `desk/agent-actions.ts:444`) keeps only its notes, so no nested repo is swallowed as a gitlink.
- `register` sets the agent's working folder to it; kept after the end (Progress and the end).

Built: https://github.com/eric-edouard/life/pull/1588
