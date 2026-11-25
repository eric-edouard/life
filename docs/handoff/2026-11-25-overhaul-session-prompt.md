# The overhaul's planning session: its prompt

Explanation: the prompt to paste into a new Claude Code session on this repo to start the big rework, written on
25 Nov 2026 at the end of the design session. Everything it points to is on `main`.

---

You are planning Life's overhaul: the chat-first iPhone app and the agent layer behind it. Plan first; write no code
until the owner approves the plan.

**Read, in this order:**

1. `AGENTS.md`, `docs/product.md`, `docs/brand.md`.
2. Issue #1373, "App overhaul: the owner's notes and directions", body and comments. It is the brief: his directions,
   his notes, and what he asks the plan to weigh. Its "Read with it" list says `docs/handoff/current-state/`; the maps
   are in `docs/handoff/2026-11-23-current-state/` (`agents.md`, `app.md`, `pi-runtime-gap-audit.md`).
3. Issue #1376, "Agents: direct mode and smart mode for incoming messages".
4. `docs/plans/2026-11-23-chat-first-app.md`, then `docs/design/chat-first/`: the current spec
   (`2026-11-23-current-spec.md`) wins over everything else in that folder; the prototypes and their README are in
   `prototypes/` (open `prototypes/shell.html` in Playwright to try it).
5. The outside research, reviewed against the code and not to be taken at face value:
   `docs/research/2026-11-24-personalization-layer.md`, `docs/research/2026-11-24-nod-and-life-pi.md`.
6. `docs/plans/2026-11-23-prediction-layer.md`: a later plan. Lay down only what the brief says this plan should
   lay down for it.

**What to produce:** one plan, `docs/plans/2026-11-25-overhaul.md` (or a dated folder if it needs several files),
following `docs/STYLE.md`:

- Where it stands on each "to weigh" and "open question" section of #1373 (the main session gating every ask and
  "How am I doing?"; agents working together and what to borrow from OpenBot; what Nod may offer; whether projects and
  matters are too opinionated, with the life admin conflict; the personalization foundation), with a recommendation
  each, not a survey.
- Direct and smart mode (#1376) and Settings (`prototypes/README.md`, "Settings: open").
- The build: fewer, bigger PRs, in order, each with what it deletes, what it changes in `AGENTS.md`'s invariants (each
  such change is the owner's to approve, named as a question), its migrations or store steps, and the tests it owes
  (his direction: no app tests while the product moves; the server keeps its tests on sends, memory, `truth/`, the
  send guard and the desk's store).
- The server never breaks; the phone app may stay broken until the new one is built.
- Speed and cost: time to first useful answer, cost per completed task, task success rate.

**How to work with the owner:** judge every UI idea from his seat (less to think about, things done); warn him when
an idea serves a builder's view. No words on buttons except "Later". He never sees an agent's name. Ask him only what
is his to decide, grouped at the end of the plan; decide the rest and say why. Nothing personal goes into the repo:
made-up names only.
