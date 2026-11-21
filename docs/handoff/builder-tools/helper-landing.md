# Landing your own PR (from 21 Nov)

You take your PR from push to merge yourself. The builder session only reads your verdict outcomes and handles conflicts it can't resolve.

`S=$TOOLS`

0. **Batch everything (his rule, 21 Nov: "what can be batched should be").** Push once, when the PR is ready for review, never per commit: each push runs the check. A **small-tier** PR doesn't run its own verdict: report "ready for a small verdict" with the PR number and stop. The builder session reviews ready small PRs together, in one reviewer run, and sends you the result to act on.
   **No iOS app builds in a helper (his "batch to be faster", 21 Nov).** The train builds the app once for the whole batch. Before you push, run only: the Kit tests you touched (`heavy.sh swift test --filter …`, light lane) and `xcrun swift-format lint --strict` on the Swift files you changed (seconds, no lane). If the train's build fails on your PR, I drop it from the train and send it back to you.
1. **Verdict (standard and hard tiers).** Once your PR is pushed, with the full plan and its tier in the body:
   `bash $S/codex-verdict.sh <worktree> origin/main $S/verdict-<PR>.md <confirm|full> <small|standard|hard> "PR eric-edouard/life#<PR>; its body: <file with gh pr view's body>. Screen review is deferred; no builds or simulators."`
   - **confirm:** the plan passed its review.
   - **full:** there's no reviewed plan.

   It runs Codex, fresh and read-only. Never run Codex outside codex-clean.sh.
2. **Act on it.** Fix every Do-it item. Fix every Rework item in the PR when it's the change's own foundation; otherwise open an issue for it.
3. **One confirming round.** After the fixes, run Codex once more with `~/.agents/skills/work-on-code/verdict-confirm.md`, giving it:
   - the must-fix items, verbatim;
   - `git diff <sha the last round saw>..HEAD`.

   Skip this round when every fix was mechanical. There is no third round: whatever it still finds goes into the verdict as debt added (with an issue), a rework (with an issue), or kept on purpose (with a reason the owner would accept).
4. **Write the verdict file**, for example `$S/final-<PR>.md`:
   ```
   ## Debt verdict
   Reviewed: x
   Verdict: debt reduced | no debt added | debt added | rework needed
   Plan: matched | drifted: <what, plan updated?> | none (full review)
   Net lines: +a / −d
   Smaller shape: <the reviewer's, and whether taken>
   Debt reduced: …
   Debt added: <each, or none>
   Reworks: <each with its issue link, or none>
   Kept on purpose: <each with its reason, or none>
   ```
   A verdict of "rework needed" never lands. Copy these labels exactly, plain, one per line, with no bold or other wording: `land-train.sh` reads the `Verdict:` line, and "pass" is not a verdict.
5. **Hand it over to land (since 21 Nov: landings go in trains).** Put the verdict in your PR body: the body plus the verdict block, with `Reviewed:` set to your PR's head sha. Use `gh pr edit <PR> --body-file <file>`, run as its own command. Don't run land.sh: report "ready to land" and stop. The builder session lands every ready PR together with `land-train.sh`, which runs one check and one Swift build for the batch.
   - If the train skips your PR for a conflict, the builder sends it back. Merge main yourself, keeping both sides' intent. A real conflict gets a short Codex catch-up review of `git show --remerge-diff HEAD`. Then land it alone: `bash $S/land.sh <worktree> <PR> $S/final-<PR>.md`.
   - On a failed check, read `derived/check/<step>.log`. A known load flake (scribe-dispatch, #857): rerun once. Anything else: fix it.
6. **Report** in a few lines: the PR, the verdict, the reworks with their issue links, the net lines, and "ready to land" (or the merge commit, if you landed it alone).
