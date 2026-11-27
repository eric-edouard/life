# App parity: where it stands and how to continue

Hand-over of 27 Nov 2026, for any session that picks up the work of bringing the iPhone app to the approved prototype.

## The goal

The Life v4.1 chat app on his iPhone matches the approved prototype, app v4
(`docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`, read with its rulebook
`2026-11-26-original-components.md`). That prototype is the only approved spec: lab picks and proposals are not targets
(`docs/design/README.md` says which is which). He chose turn by turn as the next direction on 27 Nov; that work has its
own hand-over, `2026-11-27-turn-by-turn.md`, and is design only so far.

## How "done" is measured: the parity board

- The plan is `docs/plans/2026-11-26-app-matches-prototype.md`.
- The board shows each prototype state beside the app's screen of it, at https://claude.ai/artifact/Sj1P6mVpviohcbWEjREvfZ. It is pinned, and its source is in the repo.
- The board is built by `scripts/parity.ts`: it shoots the prototype, runs the app's E2E flows (`apps/lifelog`, `scripts/e2e-phone.ts`), scores each row, and republishes the page.
- A row is green only when all of these pass:
  - a fresh reviewer scores it 8/10 or more;
  - its flow passes;
  - it takes no more taps than the prototype;
  - it has no clipped text;
  - he has not said "not right" about it.
- **His rule (27 Nov):** contrast and text size never block a row. Only clipped text, or an issue the prototype doesn't share, does.
- The scheduled task "parity-board-evening" runs every day at 19:00 and emails him only when rows change.

## What landed (26–27 Nov)

- **App:**
  - [eric-edouard/life#1473](https://github.com/eric-edouard/life/pull/1473): greeting, badge, faces and icons, two-line titles, top bar, voice flow.
  - [eric-edouard/life#1474](https://github.com/eric-edouard/life/pull/1474): 15 phone flows fixed.
  - [eric-edouard/life#1481](https://github.com/eric-edouard/life/pull/1481), [eric-edouard/life#1484](https://github.com/eric-edouard/life/pull/1484), [eric-edouard/life#1485](https://github.com/eric-edouard/life/pull/1485), [eric-edouard/life#1486](https://github.com/eric-edouard/life/pull/1486): thread, rows, people picker, open ask and draft.
  - [eric-edouard/life#1494](https://github.com/eric-edouard/life/pull/1494): clipped text down from 35 to 3; taps to the prototype's counts (draft 1, iMessage 1, Undo 2); chat times; voice card.
  - [eric-edouard/life#1500](https://github.com/eric-edouard/life/pull/1500): opening screen, offline notice, Messages mark, no extra "Wait", sign-in card, rating labels.
  - [eric-edouard/life#1499](https://github.com/eric-edouard/life/pull/1499): "Waiting on you: N · urgent", his temporary variant.
- **Board:**
  - [eric-edouard/life#1490](https://github.com/eric-edouard/life/pull/1490): his accessibility rule, plus the prototype's data for 5 rows.
  - #1500 also fixed the prototype shoot timing out on fonts, and the Focus prompt covering shots.
- **Server, found through parity:**
  - [eric-edouard/life#1495](https://github.com/eric-edouard/life/pull/1495): the recipient is inferred from context; the which-person card only when unsure.
  - [eric-edouard/life#1501](https://github.com/eric-edouard/life/pull/1501), [eric-edouard/life#1502](https://github.com/eric-edouard/life/pull/1502): no open to-do of his is hidden, and every one has a row.
  - [eric-edouard/life#1508](https://github.com/eric-edouard/life/pull/1508) (landing on 27 Nov): "hey Life" goes to the main session and always gets a reply.
- **Designs:** [eric-edouard/life#1503](https://github.com/eric-edouard/life/pull/1503): every design is dated, plain HTML on shared CSS, indexed in `docs/design/README.md`.

## Where it stopped

- **The board:** 0 green at the last full run. That run predates #1494 and #1500, and its reviewer pass has not run since. The rerun and republish were held while the Mac was on battery.
- **Known red, app side:**
  - the rating emojis are clipped, and rating takes 3 taps against the prototype's 1;
  - the which-person flow failed once: possibly flaky, see #1505.
- **Known red, server side or no design yet:**
  - "Sent to Sam" (the recipient on an ask that was already settled, #1493);
  - the sign-in card's server text;
  - no Appearance setting;
  - outdated-draft chips and icons;
  - house photos and matters inside an answer: the app draws only faces as pictures, and only asks as items.
- **Phones:** only the newer iPhone gets installs now (his word, 27 Nov). The iPhone 17 is skipped.
- **Debt issues to read first:** #1505, #1496, #1493, #1492, #1487, #1483, #1480, #1479, #1477, #1475, #1472.

## How to continue

1. Check `pmset -g batt`: on battery, start no simulators, board runs or app builds.
2. Rerun the board from main with the reviewer pass, republish it at the same URL, and read which rows are red.
3. Fix the app-side red rows in one ultrafast PR, through the `work-on-code` skill. Builds go through `tools/heavy.sh`, and landing through `land.ts`. Server strict paths (`desk/`, `host/http/`, the send paths, `prompts/`) keep the full workflow.
4. After a landing, install on the newer iPhone (`LIFELOG_PHONE_UDID=00008160-000A7D080E00000A bun run install:phone -- --no-watch` from `apps/lifelog`). Swap Life.app (`tools/build-and-swap.sh`) when server code changed.
5. Fix a bug where it is decided, never per case. His rule of 27 Nov: a similar case that has nothing to do with this one must be fixed by the same change.
6. Design work goes to the "Designer: app v4 prototype" session, never a fresh agent. Build only the approved design.
