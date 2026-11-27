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

- [The engineering playbook](./tickets/18-the-engineering-playbook.md) — Life's slim `work-on-code`: local git per step, `PLAN.md`, Bun + TS (React + Tailwind for screens), a tools allowlist, proof by running it, one lean review before done, wow UI and UX at low token cost, a skill shipped in Life.app.
- [The threshold](./tickets/01-the-threshold.md) — a project is a result to shape (made, reshaped, or many things changed); errands stay handed work; unsure goes as handed work, and the agent promotes it from the user's original words, never asking.
- [The one-off project record](./tickets/02-the-one-off-project-record.md) — an optional `goal` (the user's ask, verbatim) makes a project one-off; a new `dropped` status beside `done`, reason in its body; Life picks or makes its area.
- [The handover](./tickets/03-the-handover.md) — the main session only writes the one-off project; Life's code registers its agent and hands it the ask with the conversation; promoted work moves to a new agent through `hand_over`.
- [What an agent can reach on the Mac](./tickets/04-what-an-agent-can-reach.md) — every grant lands on Life.app and covers every script; only the user answers first prompts; Photos changes and deletes need the user's per-batch OK; undo needs a restore log.
- [The first look](./tickets/05-the-first-look.md) — read-only (allowlisted tools may install), goes as far as it can then one bundled access ask, a second round for data-grounded questions only if access was missing, at most one hour.
- [Asking for access](./tickets/06-asking-for-access.md) — one phone card of self-ticking plain steps; "I'm at my Mac" fires the prompt or opens Settings there; refused: go on, another way or drop; ignored: stays asked.
- [The questions about what they want](./tickets/08-the-questions.md) — one card, at most five data-built choices with Life's pick first and real examples; no answer in a day: the preview goes on Life's picks.
- [The preview](./tickets/09-the-preview.md) — the cheapest thing showing the result (fake, draft, simulated end state), never their real things; rounds on one page, then "Build it".
- [The plan](./tickets/10-the-plan.md) — approved with the preview: plain steps, time, and cost with a cap; over the cap or a change is asked again.
- [Doing the work safely](./tickets/11-doing-the-work-safely.md) — a small real part first, then batches; deletes and overwrites need a yes; a restore point always; enforced by playbook and review, a stated limit.
- [Answering later](./tickets/07-answering-later.md) — one quiet line (doing now, time left); a push only when it needs them or is done.
- [Progress and the end](./tickets/12-progress-and-the-end.md) — a short done page with undo and cost; dropped with its reason; the agent ends, its folder stays.
- [Privacy](./tickets/13-privacy.md) — one plain line on what is read and where it goes; the narrowest grant, never Full Disk Access when less will do.
- [The agent's workspace](./tickets/14-the-agents-workspace.md) — work hidden in Life's agents repo, the result where the user would look, kept after the end.
- [Results that live on](./tickets/20-results-that-live-on.md) — hosted with its data on the artifact system; active until its end date, its agent woken by its events; then done with a report.
- [Sending for a project](./tickets/21-sending-for-a-project.md) — one batch card, every exact text shown, "Send all"; a change to the send rules, built as a strict path.
- [Other people's data in a project](./tickets/22-other-peoples-data.md) — kept with the project; the public page shows only what the preview approved.
- [Life suggests](./tickets/23-life-suggests.md) — ideas as pre-ticked choices in the questions and the preview; follow-ups as one card on the done page.
- [Build order](./tickets/15-build-order.md) — record and handover, playbook skill, access card, artifact previews and live results, batch send, screens, security and docs; then the trial and live runs.

## Not yet specified

## Out of scope

- Projects shared between two people (two people on one library): a later map.
- Building the artifact system itself: planned elsewhere, assumed here.
- Stronger or mixed models for reviews or hard steps: a later iteration (the owner, 27 Nov 2026: cost and setup).
