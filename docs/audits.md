# Audits: when something didn't work

He says "hey Atlas, this didn't work: …". Atlas takes it in (`docs/atlas.md`, `## Audits`); a Claude session
investigates. An audit changes no code, memory or reminders: it writes only its audit file and its case in
`~/Life/docs` and commits them there by path (`git commit -- <files>`), never while `~/Life/.nightly.lock` exists: the
nightly stages `memory/` and `truth/` in the same repo, and a bare commit would take them. It ends with a proposal. Agreed with the owner on 20 Oct; the plan and its phases: `~/Life/docs/audits-plan.md`.

## Who does what

| Step | Who |
|---|---|
| Intake and the practical fix | Atlas |
| Investigation and proposal | Claude, started by Atlas (`docs/atlas.md`) |
| A second, fresh-context adversarial pass on the findings, before any fix is proposed | Claude (another session) |
| The fix, once he approves its scope | the normal path: a worktree, a PR, `debt-review` |
| Go-live: merge, then pull in `~/Work/life` (the services restart on its `src/` or `prompts/`, `tasks` reads the playbook there) | him |

## The audit file

`~/Life/docs/audits/<date>-<task id>.md`, never this repo (his material). Ids, cursors and refs; quote only what a
finding needs. Sections, in order:

1. **Complaint**: the task id, recording and turn, spoken and recorded instants.
2. **Scope**: this case and a named window of related ones.
3. **Expected vs promised**: what he expected, and what the docs promised then (the commit checked).
4. **Snapshot at intake**: the Life connector's `status` `observedAt` (not `bun life status`, the watcher's health)
   and its `changes` cursor (page `changes` with `since` the intake instant until `remaining` is 0, keep the last), and the open reminders that bear on it (`open_reminders`, read once, ids and titles only).
5. **Timeline**: each row an utterance, a fact (with its id), an inference, or a gap; event time apart from ingestion
   time.
6. **Stages**: capture (C), hearing and routing (H), extraction (E), ownership (O), task lifecycle (T), retrieval (R),
   agent judgment on what it retrieved (J), follow-through (F), delivery and notification (N), and expectation versus
   policy (P). Each one pass, fail (proven), fail (inferred) or unknown (a gap), with evidence.
7. **Hypotheses**, and the counterexamples that killed them.
8. **Cause**: proven, or the observability that is missing. Never one dressed as the other.
9. **Coverage**: the tools used, the caps hit, what was unavailable.
10. **Adversarial pass**: what it found and how each point was settled.
11. **Proposal**: a bounded fix, its regression case, success criteria.

## Regression cases

Enforced by the review: the rule is in `AGENTS.md`, and `debt-review` treats a broken `AGENTS.md` rule as a Do it
(agent-config#7).

- Every proven failure leaves a case in `~/Life/docs/evals/cases/audit-<n>-<slug>.json`: `audit` (its file), `class`
  (stage letters), `evidence` (ids), `expected`, `mustNot` (what the fix must never do), `status` (`pending` until a
  fix lands, then `test`, `facts` or `scenario`, the three kinds below), `check` (the test, facts file or scenario
  that holds it) and `why`.
- Code stages (H, T, N and the code side of O): a `bun test` with made-up data that fails before the fix and passes
  after; `bun run check` runs it on every push.
- Model stages (E, and R when a model reads): facts graded by `bun scripts/eval.ts`, rerun when a prompt changes. A
  flaky case passes 2 runs of 3; a flake is recorded, not retried away.
- Atlas's stages (J, F, P), held by the playbook: a scenario in the case, re-read against `docs/atlas.md` whenever it
  changes, until code can check it.
- Cases only accumulate. Removing one needs his OK, written in the case file.
