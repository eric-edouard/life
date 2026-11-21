# Builder tools

Reference: the scripts that landed and swapped PRs on 21 Nov 2026, kept in [`tools/`](../../tools/). Run them from there; each finds its siblings by its own folder, and none is run by tests or CI.

```sh
tools/heavy.sh bun run check        # any heavy job, one at a time
tools/sweep.sh                      # one screen of what is in flight
while :; do tools/conveyor.sh; sleep 120; done
```

Their locks, logs and build folders live in `/private/tmp/life-tools`, one place for every worktree's copy (`LIFE_TOOLS_STATE` moves it). The landing lock itself is `~/.agents/skills/work-on-code/land-lock.sh`, not kept here.

| File | What it does |
| --- | --- |
| `heavy.sh <cmd>` | Runs a heavy job (check, tests, tsc, xcodebuild) first come, first served: one slot under load 60, a second under load 30. Lanes `land`, `light` and `release` (`HEAVY_LANE`) skip the queue. Sets Xcode's compile cache and `LIFE_CHECK_SWIFT=at-landing` outside the `land` lane. |
| `compile-cache.xcconfig` | The shared Xcode compile cache that `heavy.sh` points to. |
| `conveyor.sh` | One pass of the landing loop: lists open PRs with a passing `Verdict:` line, merges main into a conflicting one when that is clean, lands the rest in one train, then swaps Life.app (and Lifelog Host for Voice changes). |
| `land-train.sh <pr>…` | Merges the PRs onto one branch off main, rewrites the wire fixtures, runs the full check once, merges it as one PR carrying each verdict. A failing check blocks the PRs it names until their head changes. |
| `sweep.sh` | Read only: load, heavy locks, the conveyor's last lines, each open PR's verdict and whether it is held. |
| `build-and-swap.sh` | Pulls main, builds and signs Life.app, waits for no open agent turn, swaps it through `swap-life.sh`. |
| `swap-life.sh <app>` | Replaces `/Applications/Life.app`, rolls back if the helpers do not start or crash-loop in 90 s. |
| `host-build-and-swap.sh` | The same for Lifelog Host, with a health check and a migration count check. |
| `claude-verdict.sh` | Runs a debt verdict reviewer through `claude -p` (see `helper-rules.md` for when it is out of quota). |
| `helper-rules.md` | The rules every helper agent follows. |

Next: [builder.md](builder.md) for how the tools were used.
