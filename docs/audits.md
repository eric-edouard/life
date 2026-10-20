# Audits: when something didn't work

He says "hey Atlas, this didn't work: …". Atlas takes it in (`docs/atlas.md`, `## Audits`); a Claude session
investigates. An audit changes no code, memory or reminders: it writes only its audit file and its case in
`~/Life/docs` and commits them there (the nightly commits only `memory/` and `truth/`). It ends with a proposal. Fixes
go through the gates below, each with its regression case. Agreed with the owner on 20 Oct.

## Who does what

| Step | Who |
|---|---|
| Intake, the practical fix, talking to him | Atlas |
| Investigation and proposal, in a Remote Control session in normal permission mode (he answers prompts on his phone; never bypass) | Claude |
| A second, fresh-context adversarial pass on the findings, before any fix is proposed | Claude (another session) |
| The fix, once he approves its scope, in a worktree | Claude |
| Review tied to the final head commit | the `debt-review` skill |
| Merge, which is go-live | him |

## The audit file

`~/Life/docs/audits/<date>-<task id>.md`, never this repo (his material). Ids, cursors and refs; quote only what a
finding needs. Sections, in order:

1. **Complaint**: the task id, recording and turn, spoken and recorded instants.
2. **Scope**: this case and a named window of related ones.
3. **Expected vs promised**: what he expected, and what the docs promised then (the commit checked).
4. **Snapshot at intake**: the Life connector's `changes` cursor and `status` `observedAt` (not `bun life status`,
   the watcher's health), and the open reminders that bear on it (`open_reminders`, read once, ids and titles only).
5. **Timeline**: each row an utterance, a fact (with its id), an inference, or a gap; event time apart from ingestion
   time.
6. **Stages**: capture (C), hearing and routing (H), extraction (E), ownership (O), task lifecycle (T), retrieval (R),
   agent judgment on what it retrieved (J), follow-through (F), delivery and notification (N), and expectation versus
   policy (P). Each one pass, fail (proven), fail (inferred) or unknown (a gap), with evidence.
7. **Hypotheses**, and the counterexamples that killed them.
8. **Cause**: proven, or the observability that is missing. Never one dressed as the other.
9. **Coverage**: the tools used, the caps hit, what was unavailable.
10. **Adversarial pass**: what it found and how each point was settled.
11. **Proposal**: a bounded fix, its regression case, success criteria. The practical fix stays Atlas's task.

## Regression cases (enforced)

- Every proven failure leaves a case in `~/Life/docs/evals/cases/audit-<n>-<slug>.json`: `audit` (its file), `class`
  (stage letters), `evidence` (ids), `expected`, `mustNot` (what the fix must never do), `status` (`pending` until a
  fix lands, then `test` or `eval`) and `why`.
- A stage without a model call (hearing, tasks, board, delivery) gets a `bun test` with made-up data, which fails on
  the code before the fix and passes after. `bun run check` runs it on every push (the pre-push hook).
- A model stage (moments, extract, a judge) gets facts in `~/Life/docs/evals/` graded by `bun scripts/eval.ts`, after
  every prompt change. A flaky case passes 2 runs of 3; a flake is recorded, not retried away.
- Cases only accumulate. Removing one needs his OK, written in the case file.
