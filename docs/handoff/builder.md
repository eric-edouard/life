# Builder handoff (phone app), 21 Nov 2026

The phone app session ("Life App Builder") paused here, on the owner's word. Nothing of it is running. Every branch is
pushed, and Life.app was swapped to the latest main as the last step.

## How it worked

Helpers (subagents, 3 at most) build one PR each. Each helper:

1. pushes once, when the PR is ready for review;
2. runs its Codex verdict and acts on it;
3. runs one confirming round;
4. writes the verdict block into the PR body;
5. reports "ready to land" and stops.

Small-tier PRs skip their own verdict: the builder reviews them together. The builder lands every ready PR together with
`land-train.sh`: one check and one iPhone build for the batch. Then it swaps Life.app when the batch touched the server
or the desk, and asks the owner before any phone install. Helpers never build the app; the train does. The full brief
is `builder-tools/helper-landing.md`.

## Open PRs

| PR | What | State | What's left |
|---|---|---|---|
| [#924](https://github.com/eric-edouard/life/pull/924) | Spending page in Settings, and an agent's and a matter's spending line | Ready to land. Verdict: debt added, each item tracked ([#927](https://github.com/eric-edouard/life/issues/927), [#925](https://github.com/eric-edouard/life/issues/925)). Main merged, design data and six frames in | Land it with `land-train.sh 924` |
| [#930](https://github.com/eric-edouard/life/pull/930) | Projects tab (decision 95, drawn to decision 98) | Built and pushed; Kit tests pass (238) | Its verdict was stopped mid-run. Run the verdict (standard), act on it, one confirming round, write the verdict block, then train it. Plan in the PR body and `builder-tools/projects-tab-plan.md` |
| [#931](https://github.com/eric-edouard/life/pull/931) | "Your move" cards on the phone: the `place` need (Maps links, Bolt only when given), Not now, Hand to an agent | Pushed; needs a small verdict | Lands after the Fixer's server PR [#926](https://github.com/eric-edouard/life/pull/926), which waits on the owner's call about the badge (about 231 cards, 55 dated). `ContractTests.lifesEnumsAreTheServers` fails until #926 lands. The server's phone fixtures have no your-move card yet: the Fixer adds one to `mcp-phone-reads.test.ts`, then the skip in `everyKindOfCardAnswersAsLifeTakesIt` goes. Behavior change: a new matter's Start now also sends the card's goal as `note` |

## Branches with unmerged work (no PR)

- **`matter-handoff-phone`** (9a5318f0, WIP): the phone side of agent hand-off ([#915](https://github.com/eric-edouard/life/pull/915), the Fixer's, merged). Done so far:
  - The debt plan, at standard tier: `PLAN.md` on the branch and `builder-tools/handoff-phone-plan.md`.
  - Its first review asked for one reshape, which was made: the phone keeps the move id Life answers with. That review is in `builder-tools/handoff-phone-plan-review.md`.
  - A first draft of `Kit/.../Models/AgentMove.swift`, never compiled.

  Left:
  - the second plan review;
  - Kit decoding, the `hand_over` request and tests;
  - the matter page's move menu and the agent sheet's program row;
  - the PR and the verdict.

  Frames, on the designer's canvas:
  - Matter page: DuoFoldMoveMenu, DuoFoldMoveAsk, DuoFoldMoveNotes, DuoFoldMoveStarting, DuoFoldMoved, DuoFoldMoveFailed, DuoFoldMoveBackMenu; phone MoveMenu, MoveNotes, Moved.
  - Around it: DuoFoldMovedCard, DuoFoldAgentsListMoved.
  - Agent sheet: DuoFoldAgentProgramMenu, DuoFoldAgentSwitchAsk, DuoFoldAgentSwitching, DuoFoldAgentSwitched, DuoFoldAgentSwitchFailed; phone AgentProgramMenu.

  None is in `frame-map.json` yet. A blocked move (`moveBlocked`) has no frame: hide the option.
- **`calendar-adds-phone`** (24e01f3c, WIP): the calendar adds on the phone: Kit models, wire fixtures, the `calendar.added` notification, the event sheet. Left:
  - Kit tests;
  - the PR and the verdict.

  The matter row is blocked until `read_matter` carries the matter's appointments: ask the Fixer. The designer has no frames for it yet.
- **`wip-97-cards`** (72d276af): an earlier take on decision 97 for the cards. #905 did it instead, so this is reference only. Delete it once no one needs it.
- **`people-e-before-redo`** (bcfbbd33): a backup taken before People E was redone. People E is merged, so delete it.

Other sessions' branches are theirs to hand off: `your-move`, `arrival-pass`, `github-prs`, `spoken-asks`, `desk-dsh-runtime`, `desk-step5-goals`, `note-option`, `calendar-adds-full`, `id-not-phone`, `fold-card-matters`, `kept-promise-link` and `claude/*`.

## Queued, not started

The briefs are in `builder-tools/helper-resume.md` (the queue as it stood) unless named here.

- **Decision 98's remaining batches.** The spec is `redesign-rules-2026-11-21.md` on the designer's side, canvas v156.
  - Drafts: filled bubbles with a shadow and no dashed outline; the head says "N people".
  - The matter page: people as chips; the reach row adapting to the count. It also shows the next step's new `context` (Markdown with `life:` links, from [#890](https://github.com/eric-edouard/life/pull/890)), so Kit's `NextStep` and `NextStepRequest` gain an optional `context`.
  - The payment card: one card; the amount large with a small currency; "I've paid" with the green check.
  - The calendar appointment as a tile with Remove, and pencils as 32-point tinted buttons.

  Cards and lists are done (#905, #914).
- **The Spending agent and matter lines in design data.** The designer's `read_registered_agents.json` and `read_matter.json` need `spending` added, for the frames DuoFoldAgentSpend and DuoFoldMatterSpend to be shot.
- **[#907](https://github.com/eric-edouard/life/issues/907):** a row of short but wide answer labels stacks too tall in the bottom bar on a short screen. It needs a screen review.
- **The Wrong sheet's field** is still capped at 8 lines, a leftover from #914.
- **Transitions, second batch.**
- **The Life plugin v1.**
- **A follow-up issue for the payment card's server side:** reminders on an event card, a need naming an app, a place need, the QR's source ref, the done-seen amount.
- **An audit that every tap shows its result:** loading, then a green result or a clear failure.
- **The final design-fidelity pass**, the first screen review of everything built since 18 Nov. Its first screen checks:
  - a one-line grouped row's tap area;
  - the plan card;
  - the answer bar;
  - Spending;
  - the agent sheet opening from Spending.
- **Tell Life**, built last.
- **Cleanup:** the merged worktrees under `~/Work/life-*` and `.claude/worktrees/`.

## Waiting on the owner

- **A phone install.** His phone runs the build from train #910. Since then, main gained:
  - the Live logs crash fix ([#921](https://github.com/eric-edouard/life/pull/921));
  - dictation 4b;
  - the grouped lists;
  - card extras;
  - "Open in" opening the agent's current session.

  The install command is `bun run install:phone -- --no-watch` from the live checkout, in the release lane, with his phone unlocked. His phone is the iPhone19,4 listed "available (paired)" in `xcrun devicectl list devices`. The other listed iPhone is not his.
- **The badge call on "your move" cards** (server #926), which the Fixer asks him.
- **Checks on a real phone:**
  - a draft card's notification falling back to Life's own view of the chat;
  - the mic closing at once when a call interrupts dictation;
  - dictation's audio session and timings;
  - the bank apps' links on the payment card.
- **Quit and reopen the ChatGPT app (⌘Q)** so Codex loads the key-rotation setting, as the key-rotation session reported.

## Known bugs and flaky tests

- **Under load (above about 60):** `scribe-dispatch.test.ts` ([#857](https://github.com/eric-edouard/life/issues/857)), `voice-notes.test.ts`, and the check's "a clean tree that passed is known to every worktree" (5 s) time out. Rerun once. `foundation-model.test.ts` was fixed by #892.
- **The Live logs crash** ("No Observable object of type AppRouter") is fixed in #921, but not yet on his phone.
- **Debugging a crash on the phone:** `xcrun devicectl device copy from --device <his UDID> --domain-type systemCrashLogs --source / --destination <dir>` while the phone is unlocked. For the message itself, use `xcrun devicectl device process launch --device <UDID> --console --terminate-existing com.ericedouard.lifelog`.

## Tools

The scripts are code blocks in [`builder-tools.md`](builder-tools.md), and the plans and briefs are in [`builder-tools/`](builder-tools/). The scratchpad path is written as `$TOOLS` and the Mac user's home as `$HOME`.

- **`heavy.sh <cmd>`** runs every test, tsc, swift or xcodebuild job, one slot at a time, starting under load 60.
  - Lanes: `HEAVY_LANE=land` for a landing check, `light` for a job under a minute, `release` for the Life.app and phone builds.
  - Pushes outside the land lane skip Swift (`LIFE_CHECK_SWIFT=at-landing`).
  - It points Xcode at a shared content-keyed compile cache (`compile-cache.xcconfig`). `HEAVY_NO_CACHE=1` skips the cache.
- **`land.sh <worktree> <PR> <verdict file>`** lands one PR:
  1. takes the area lock;
  2. merges main;
  3. runs the full check in the land lane;
  4. pushes;
  5. writes the verdict with the real head;
  6. merges.
- **`land-train.sh <PR>…`** lands every ready PR together. It merges each onto one branch off main, skipping any that conflicts or has no `Verdict:` line, runs one check, and opens and merges one train PR. Verdict labels must be plain, exactly as in `helper-landing.md`.
- **The area locks** are `~/.agents/skills/work-on-code/land-lock.sh`, which lives outside the scratchpad, so it's kept. Areas: phone, desk, voice, server.
- **`codex-clean.sh`** runs Codex without his secrets: no login shell, core environment only. **`codex-verdict.sh <worktree> origin/main <out> <confirm|full> <tier> "<context>"`** runs a fresh read-only verdict through it.
- **`build-and-swap.sh`** (Direction's): it builds Life.app from main in the release lane, waits for no open agent turn, then swaps with `swap-life.sh`. The swap rolls back if the helpers don't start or crash-loop within 90 s. It needs `LIFE_SIGN_IDENTITY` set to his signing identity's hash (`security find-identity -v -p codesigning`).

## How to resume

1. Copy each script out of `docs/handoff/builder-tools.md` into the new session's scratchpad, replace `$TOOLS` with that folder's path, and `chmod +x` them.
2. Land #924 (`land-train.sh 924`), then run #930's verdict and train it. Then ask the owner to install on his phone: the build carries the Live logs crash fix.
3. Resume `matter-handoff-phone` from its `PLAN.md`, then the decision-98 batches in the order above, keeping at most 3 helpers and landing in trains.
