---
type: research
blocked_by: [02]
---

# Technical: the project record

## Question

How `goal` and `dropped` land in code.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026.
- `records/truth.ts:141`: `goal: z.string().optional()` and `"dropped"` in `status`. `isUnderway` already counts it as not under way, so the server's readers (`memory/read-matters.ts:368,372`, `memory/pages.ts:128`, `memory/project-situations.ts:87`, `memory/model-context.ts:51`, `host/desk-health.ts:130`) need no change.
- `host/change-directory-entry.ts:75` reuses `Project.shape.status` instead of its own copy (one source); `projectWrite` (`:243`) writes `goal`.
- `projectHeaderOf` (`memory/read-truth.ts:57`) shows the goal in an agent's packet.
- iPhone: `ProjectStatus` gains `dropped` (`apps/lifelog/apps/ios/Kit/Sources/LifeConnector/Models/Matter.swift:12`), else a dropped project's matters read as not parked.
- `docs/glossary.md` ("area, project", and `dropped` kept apart from a matter's Drop) and `docs/SCHEMA.md:462`.

Built: https://github.com/eric-edouard/life/pull/1560
