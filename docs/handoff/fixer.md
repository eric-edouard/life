# Fixer handoff: the server, the desk and Voice (21 Nov 2026)

Reference. This page lists what the "Life App Fixer" session left when work stopped on 21 Nov 2026. That session ran the
server, desk and Voice queue through helper agents. Start with the [master handoff](README.md).

## How to resume

1. Read this page and the [master handoff](README.md). Then run `gh pr list --state open` and compare it with the open PRs
   below.
2. Land or finish #926 ("your move" cards) first. The owner approved it as is: every card with a deadline counts in the
   badge. Then rebuild and swap Life.app (`build-and-swap.sh`, kept in the master handoff).
3. Take the queue below in order. Each item names where its brief lives.

## Open PRs

| PR | State | Verdict | What's left |
|---|---|---|---|
| [#926](https://github.com/eric-edouard/life/pull/926) "Your move" cards | open, reviewed at 0efa7194 | no debt added | The catch-up with main is pushed as WIP, head 1d6a08b1. It adds the phone's `yourMove` group and `place` need, which the landing's Swift contract test asked for. Left: add the phone fix to the verdict's mechanical fixes, catch up again if main moved, then run `land.sh` (full check with Swift) and swap Life.app. The Builder owns the card's proper phone screens (#931). |

The Builder's phone halves (#931, #930, #924) are in [builder.md](builder.md).

Both apps run current main. Life.app was swapped at 57576fca, after #915. Lifelog Host was swapped at 5f774947, after #913;
that swap ran Voice's spending migration (18 to 19 migrations). The only merge since, #929, is phone code. The previous
Host is kept as `/Applications/Lifelog Host-previous.app`.

## Branches with unmerged work

| Branch | Pushed | What it holds |
|---|---|---|
| `spoken-asks` | yes, 655be566 | "hey Life" spoken asks, PR 1 of 3, unfinished. The reshaped plan is `PLAN.md` on the branch. |
| `phone-perf-4` | yes, 5ec94355 | Performance fix 4, "read-only while Life is out of reach" (audit finding 5): one `NetworkPath`, a Kit `LifeConnection`, taps refused and buttons off while out of reach, a stale note on every read screen. It doesn't compile yet: `ConnectionSummary.swift:62` names `SyncStore.OfflineProtocol`, which isn't found. After that it needs an app build, a design review and a hard-tier verdict. It overlaps #924 and #918 in `LifeStore.swift` and `MatterPage.swift`. |
| `arrival-pass` | no: the check fails (fallow: one type and 14 circular dependencies). Committed in `~/Work/life-arrival-pass`, saved as `~/Work/life-wip/arrival-pass.bundle` | The arrival pass of 19 Nov: the night's episodes and extraction run on the day's due units. Superseded by the arrival reader; kept for reference, not to merge as is. |
| `github-prs` | no: the check fails (biome errors). Committed in `~/Work/life-github-prs`, saved as `~/Work/life-wip/github-prs.bundle` | The GitHub source copies pull requests, their comments, reviews and merges like issues (one commit, 20 Nov). Never reviewed. |
| `wip-extract-v8` | yes, ba755ff4 | The extraction prompt v8 trial (#763). The owner skipped it on 21 Nov ("less good"); kept for reference. |

To bring back a branch saved as a bundle: `git fetch ~/Work/life-wip/<branch>.bundle <branch>:<branch>`.

## Queue

1. **"Hey Life" spoken asks** (branch `spoken-asks`). Every spoken ask reaches an agent, routed by the desk (his word of 21
   Nov).
   - **The plan:** `PLAN.md` on the branch. Its second Codex review asked for 10 refinements and 2 are done.
   - **Key choices:**
     - no model step picks the matter: the desk routes by meaning, else to Personal;
     - the receipt is the `ask.spoken` event row;
     - "<agent> heard you" is pushed only once the turn has begun.
   - **Three PRs:**
     1. The desk starts Personal itself.
     2. Spoken asks.
     3. The deletes: the `agents` setting with its migration, `bun life ask`, `read_agent_asks`, and the Mac app's "Your
        agent" section. This one needs a Life.app swap.
   - **Direction's rulings of 21 Nov:**
     - the desk may start Personal (at most one);
     - delete `bun life ask`;
     - the 20 s fallback is approved;
     - "<agent> heard you" is approved.
2. **The phone's performance fixes 4 to 8** (branch `phone-perf-4`). The brief is the audit's fix plan,
   `docs/handoff/app-performance-audit.md` (copied from the notes folder).
   - **Done:** 1 (#777), 2 (#788) and 3 (#770).
   - **Left:** 4 read-only offline, 5 fewer reads, 6 cheaper reads (server, then app), 7 main thread, 8 matter page.
   - **Coordinate with the Builder:** it also edits `LifeStore.swift`.
3. **#817, Life's own next-step drafts** get a `context` at the matter-directions prompt's next version. That's a prompt
   bump, so it needs his yes.
4. **#912:** if an agent's turn ends without a wait while the owner holds its session open in the Claude app, its one
   reminder is lost.
5. **#884:** a call turn that crosses the call's edge loses its in-call words past its first 20 s. Fixing it needs
   Lifelog Host to give full word timings.

## His decisions pending

- **#874:** organization links.
- **Optional:** whether a Personal agent the desk starts skips its first-turn plan card for a spoken ask, as the
  caretaker does. Today it doesn't.

## Known bugs and flaky tests

- **Flaky:**
  - #882: `mcp-people-reads.test.ts` sees a person another test file left behind.
  - #900: `cutter.test.ts`, under load.
- **#828:** the Apple trigger misses about 15 of 73 asks. The night still reads them all.
- **#912 and #884:** above.
- **A train needs the standard lines.** `land-train.sh` skips a PR whose body lacks a `Verdict:` line right under
  `## Debt verdict`, and helpers often wrote the verdict in their own words.
- **Stacked PRs** in one train conflict once main moves. Catch each one up just before the train.

## Scripts

`heavy.sh`, `land.sh` and `land-train.sh` are in [builder.md](builder.md). `build-and-swap.sh` and
`host-build-and-swap.sh` are in the [master handoff](README.md). The Fixer's own Codex wrappers are below. Each one passes
the two flags that keep Codex from reading the login shell's secrets; never drop them.

```bash
# codex-verdict.sh <worktree> <base ref> <out.md> <mode confirm|full> <tier> <extra context>
WT="$1"; BASE="$2"; OUT="$3"; MODE="$4"; TIER="$5"; EXTRA="$6"
HEAD=$(git -C "$WT" rev-parse HEAD)
PROMPT="Never run bun run check, bun test, tsc or any build or test suite: the Mac runs one heavy job at a time; read code and run only single-function snippets. Read ~/.agents/skills/work-on-code/verdict-review.md and follow it in $MODE mode, $TIER tier. Repo worktree: $WT (you are in it). The change is \`git diff $BASE...$HEAD\` (head $HEAD); the PR body, with its Debt plan section, is the file named below. Read-only: never edit, commit, push or comment. $EXTRA"
codex exec -c allow_login_shell=false -c 'shell_environment_policy.inherit="core"' -m gpt-6.2-astra -c model_reasoning_effort=high -s read-only --skip-git-repo-check -C "$WT" -o "$OUT" "$PROMPT" </dev/null > "$OUT.log" 2>&1
```

```bash
# codex-plan-review.sh <plan.md> <out.md>
codex exec -c allow_login_shell=false -c 'shell_environment_policy.inherit="core"' -m gpt-6.2-astra -c model_reasoning_effort=high -s read-only --skip-git-repo-check -C ~/Work/life -o "$2" "Read ~/.agents/skills/work-on-code/plan-review.md and follow it. The plan to review is $1. Read AGENTS.md first. Read-only. Never run bun run check, bun test, tsc or any build." </dev/null > "$2.log" 2>&1
```

```bash
# catchup-review.sh <worktree> <remerge diff file> <out.md> <context>: a junior review of a catch-up merge
WT="$1"; DIFF="$2"; OUT="$3"; CTX="$4"
PROMPT="Never run bun run check, bun test, tsc or any build. Read-only. Junior review of a catch-up merge: $DIFF is the remerge diff of merging origin/main into the branch in $WT (HEAD $(git -C "$WT" rev-parse HEAD)). $CTX Check the resolution keeps both sides' intent and loses nothing; reply with findings (file:line) or 'clean'."
codex exec -c allow_login_shell=false -c 'shell_environment_policy.inherit="core"' -m gpt-6.2-sol -c model_reasoning_effort=high -s read-only --skip-git-repo-check -C "$WT" -o "$OUT" "$PROMPT" </dev/null > "$OUT.log" 2>&1
```

A confirming round uses `codex-verdict.sh` with `confirm` and puts the must-fix items in the extra context.

## The rules the session ran under

- At most 3 helper agents at once.
- Every test, typecheck or build goes through `heavy.sh`.
- Push once per PR.
- One verdict plus one confirming round, then stop.
- Land in trains when 2 or more PRs are ready.
- After each batch touching the server, desk or Voice, swap Life.app. Swap Lifelog Host when Voice's server changed.
- Never `env`, `printenv` or `set` in a shell an agent can read.
- Wrap `gh` and `git push` in `zsh -c 'source ~/.zshrc >/dev/null 2>&1; …'`.
