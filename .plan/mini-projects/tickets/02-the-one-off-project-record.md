---
type: grilling
blocked_by: []
---

# The one-off project record

## Question

What a one-off project adds to `Project` in `truth/` (its goal, its end, how it differs from an ongoing project), its statuses from created to done or dropped, and its glossary line. Written through `change_directory_entry` on the user's words: check that writer's rules allow it as they stand.

## Answer

Decided with the owner on 28 Nov 2026. A project is `truth/projects/<id>.md` (frontmatter and free notes), written
through `change_directory_entry` on the user's words.

- **One-off = a `goal`:** a new optional `goal` field on `Project`. A project with a goal is one-off and ends when its
  goal is reached; no `kind` field, no second kind of project.
- **The goal is the user's ask, verbatim** (the `said` of the write). Life drafts only the short `name` ("Photo library
  cleanup"); the agent's restatement of what they meant lives in its own `PLAN.md`, never in `truth/`.
- **Ending:** a new status `dropped` beside `done`. `done`: the goal was reached; `dropped`: it was not, whether the user
  dropped it or Life found it impossible, the reason written in the project's body. `parked` keeps meaning "may come
  back".
- **Area:** Life files it under the closest existing area, and creates a plain one ("Personal") when none fits; no
  question.
- Both `goal` and `dropped` land in code first (`truth/` schemas are strict), each with its `docs/glossary.md` line.
