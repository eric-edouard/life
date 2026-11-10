# Rethinking the memory

Explanation: how to approach Life's memory again when a stronger model comes out. It is a guide for the agent doing
that work, not a description of today's design (that is `docs/architecture.md`).

## The goal

Every decision is judged against this, in the owner's words (9 Nov 2026):

> Life is my life-encompassing memory. It knows everything about me and tells me directly where things stand in every
> area of my life: areas and projects, practical, relationships, goals, vision, psych, even meta. It makes predictions
> about the people I interact with and about me. It knows me in some ways better than I know myself, by being the
> objective observer of my life and actions.

A layer that does not make Life better at that, measured, does not earn its place.

## What is settled

These are not reopened by a stronger model:

- Raw data is kept forever, as the sources give it (`docs/sources.md`, the archive, the owner's `imports/`). It is the only truth.
- Units are built by code, closest to the raw data: a conversation-day, a chat-day, a thread-day, a note-day. A unit
  is a unit whatever the model.
- Retrieval is text plus vector embeddings over units and their passages (`apps/server/src/memory/vectors.ts`). No graph database, no
  packaged memory product.
- The invariants in [AGENTS.md](../AGENTS.md#invariants).

## What is always in question

Everything between the units and the agents: which layers exist, what each extracts, how, how much, and for how long.
Today that is episodes, observations, pages, situations, personas and closeness (`docs/architecture.md`); the memory
rework (its map on branch `claude/memory-distillation`, in `.plan/memory-rework/`, while it lasts) adds arcs, coded
acts and forecasts. A stronger model changes the answer because it changes three things:

- How much raw text one call can read well. The longer a model reads accurately, the fewer layers are needed to carry
  the long story, and the more a question can be answered from raw at question time.
- How well it reads between the lines: tone, who yields, performed speech, what is said about someone absent. Layers
  built to compensate for a weak reader may go.
- What a read costs. Cheaper reads move work from stored layers to question time; dearer ones the other way.

Building on the current layers is the default. Starting over is right when a layer exists only to work around a
limit the new model no longer has, or when the measurements below say the current shape cannot reach the goal.

## How to do it

1. Read the goal and the test set first, nothing else. The test set is the owner's real questions with what a right
   answer contains, in the owner's data repo (`docs/memory-rework/02-questions.md` and the mined `02b-`, `02c-` files).
2. Sketch your own data model from the goal, the test set and what the new model can do. Write it down before
   reading the history below, so the past shapes do not anchor you.
3. Then read the history, to learn what failed and why, not to copy it: the architecture plans in `docs/plans/`, the memory rework
   map and its tickets, the owner's problem statement and wants (the owner's data repo, `docs/memory-rework/inputs/`), the
   reviews in the owner's data repo's `docs/reviews/`. Keep what the history proves; drop what it only assumed.
4. Measure before adopting anything. A new layer or a new prompt is tried on a pilot (a few people and periods),
   against the test set, with blind checks: the model never sees the answer it is graded on, and the owner's ratings
   are never a target to tune toward. Predictions are scored against what actually happened later (backtests). The
   practical answers (what is owed, open, when) must not get worse.
5. Count the cost before any backfill and show it to the owner. Every read of old history happens once, after its
   prompt is frozen on the pilot, and backfills run on Codex (the owner's decision of 10 Nov 2026; quota and pacing
   in [operations](operations.md), "Backfill").
6. Migrate without losing the owner's word: the owner's corrections, ratings and labels are inputs to every new build, never
   annotations that must survive an id; stored records change only as [AGENTS.md's invariants](../AGENTS.md#invariants) allow.

## Questions every redesign answers

- What is the unit of the story: a person, a project, a period of the owner's life? How is it rolled up over months and years?
- What is stored, and what is rebuilt from what is stored? What owns each piece of state?
- How does detail fade with age, and what is long-standing enough to keep at any age?
- How are the owner's words to someone (possibly a performance) told apart from what the owner says about them to others?
- What makes closeness, if not volume or time?
- What does Life predict, and how is each prediction proven before it drives anything?
- How is each layer checked: an eval case, a real reader, a production run?

## Research to start from

In the owner's data repo: `docs/memory-rework/inputs/life-psych-research/` (memory and persona systems, trait and
relationship science, coding methods, prediction; read `05-merged-findings.md` first) and `docs/research/` (the memory
pipeline and decision models). Look for newer work on long-context reading, memory for agents and personality from
text, but judge every idea against the goal and the test set, never by how new it is.
