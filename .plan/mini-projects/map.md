# Mini projects within Life

## Destination

Life takes any one-off project, from the user's ask ("organize and clean up my photo library") to done: built, shipped,
and seen working live, first on the owner's own Photos library, then on a second user's.

## Notes

- General, never photo-shaped: the photo library is the running test case, not the design. Every rule must hold for any
  user and any kind of one-off project (`AGENTS.md`, "General, not tailored").
- This map carries execution: it ends when the feature runs live, not when the spec is written.
- Read Life's `AGENTS.md`, `docs/glossary.md`, `docs/tasks.md`, `docs/product.md` and `SECURITY.md` before any ticket.
  Apply the `domain-modeling` skill; Life's glossary is `docs/glossary.md`. Code tickets follow `work-on-code`.
- Anything the user sees is designed in the designer session (app v4 prototype), never invented in a ticket.
- Settled while charting (27 Nov 2026, the owner's answers):
  - It is a **project**: Life's existing `Project`, made able to be one-off, with a goal and an end. No new concept.
  - It lives in `truth/`, written on the user's own words: their ask is the `said` of `change_directory_entry`.
  - Life decides an ask is a project by what it finds (it can't finish it now), never by asking "make this a project?".
  - The main session never works on a project: at "let me look into it" it creates the project and hands it to the
    project's agent; the first look is already the agent's.
  - Life never asks what it could find out or do itself; it asks only what only the user can do or decide.
  - Before any real work, the user sees a cheap preview of the result (a clickable fake, a sample done for real, an
    outline), and approving it is approving the plan.
  - Life's artifact system (pages Life makes and hosts) is assumed: it is planned elsewhere.
  - Git is assumed present; bundling it in Life.app is life#1515.
  - How agents build is the owner's engineering method, never the model's choice: Life's variant of `work-on-code`,
    one fixed stack (Bun and TypeScript), quality judged on the output (looks, works, bugs surfaced), and independent
    reviews on the agent's own model.
  - The final test: the owner's own Photos library on his Life first, then a second user's, on their own Mac.

## Decisions so far

- [The engineering playbook](./tickets/18-the-engineering-playbook.md) — Life's slim `work-on-code`: local git per step, `PLAN.md`, Bun + TS (React + Tailwind for screens), a tools allowlist, proof by running it, two same-model reviews, a skill shipped in Life.app.
- [The threshold](./tickets/01-the-threshold.md) — a project is a result to shape (made, reshaped, or many things changed); errands stay handed work; unsure goes as handed work, and the agent promotes it from the user's original words, never asking.
- [The one-off project record](./tickets/02-the-one-off-project-record.md) — an optional `goal` (the user's ask, verbatim) makes a project one-off; a new `dropped` status beside `done`, reason in its body; Life picks or makes its area.
- [The handover](./tickets/03-the-handover.md) — the main session only writes the one-off project; Life's code registers its agent and hands it the ask with the conversation; promoted work moves to a new agent through `hand_over`.
- [What an agent can reach on the Mac](./tickets/04-what-an-agent-can-reach.md) — every grant lands on Life.app and covers every script; only the user answers first prompts; Photos changes and deletes need the user's per-batch OK; undo needs a restore log.
- [The first look](./tickets/05-the-first-look.md) — read-only (allowlisted tools may install), goes as far as it can then one bundled access ask, a second round for data-grounded questions only if access was missing, at most one hour.
- [Asking for access](./tickets/06-asking-for-access.md) — one phone card of self-ticking plain steps; "I'm at my Mac" fires the prompt or opens Settings there; refused: go on, another way or drop; ignored: stays asked.

## Not yet specified

- **A second kind of project.** Once the preview is settled, prove the design on a project that makes something new (a
  mini web app) rather than tidying something that exists. <clears-with: 09>
- **Many projects at once.** How spending caps, the agents' places on the desk and the user's attention hold when
  several one-off projects run together. <clears-with: 10>

## Out of scope

- Projects shared between two people (two people on one library): a later map.
- Building the artifact system itself: planned elsewhere, assumed here.
- Stronger or mixed models for reviews or hard steps: a later iteration (the owner, 27 Nov 2026: cost and setup).
