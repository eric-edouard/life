# Health that tells the truth, heals, and keeps quiet offline

Why: LINE's bridge hung on 5 Nov while saying CONNECTED; nothing alerted for a day. The owner wants Life to check its
bridges at least daily, heal what a restart heals, and never alert because the Mac was offline (travel, VPN).

## Milestone 1: code (this PR)

- [x] `isOnline()` (`models/llm.ts`): his main engine's provider answers an HTTPS HEAD (any status) in 5 s; each
      `Provider` names its `host`.
- [x] `nightly()`: probe first; an offline tick (not `--force`) logs `offline` and runs nothing, so no try is spent and
      nothing alerts. No online-since state: silence never turns a source red (`toneOf`), only an unreadable store or a
      down bridge does, so nothing stale alerts on return.
- [x] `isOfflineFailure`: a night or backfill week that fails while offline counts no try and mails nothing.
- [x] Daily bridge heal: job `bridges`, its turn by the backup's rule (`backupDue` renamed `afterNightDue`, `NightState`
      renamed `JobState`, comments and tests). `healBridges()` restarts the one job and waits until each added bridge
      reports its logins' states (seen live: just restarted, a login has none, which reads as down). Before the alert.
- [x] `keepRunning`: waits until `launchctl print` no longer finds the job after `bootout`, then `bootstrap`.
- [x] Docs: operations.md (bridges, offline), glossary ("online"), AGENTS.md (the `isOnline` row, the daily restart).
- [x] Dropped: the bridges test "leak" (no leftover process; those seen were the real job).

## Milestone 2: daily triage (scheduled task, not code)

- [ ] Rewrite `lifelog-daily-triage` as `life-daily-triage`: last 24 h of `run.error` lines and the snapshot's red and
      amber cards; skip when offline; fix through PRs that pass the golden-rule verdict; email a grouped summary.
- [ ] Run it once and check its email.

## Golden rule plan

Inventory (`rg -n "backupDue|restartBridges|bootout|keepRunning|isOnline|onlineSince|redSources\(" apps/server/src docs AGENTS.md`,
`rg -in "online|offline" apps/server/src docs/glossary.md`):
- `memory/schedule.ts:42` `backupDue`, used by `host/nightly.ts:192` and `schedule.ts:239` (`turnOf`); `Job` at :247;
  `recordState` :259; `decide` :26.
- `host/nightly.ts:126` `nightly()`, :181 source alert (`redSources`), :471 `runNight`'s `recordState`.
- `host/bridges.ts:72` `restartBridges` (callers :147, :282, :403); `sources/matrix.ts:97` `readWhoami`, :104 `readBlock`.
- `core/service.ts:17` `keepRunning`, :35 bootout/bootstrap.
- `host/status/snapshot.ts:477` `latestHealths` (the bridge check the alert reads), `host/messaging-status.ts:70` `bridgePart`.
- No online/offline helper exists (`watch.ts:30` mentions an outage only in a comment).

Shape: one judge of reachability (`isOnline`, beside the providers it probes); one tick-state file for it next to the
other tick states (`schedule.ts`); the tick is the one place that gates on it. The heal reuses `restartBridges` and the
daily-chore rule (renamed from `backupDue`, now serving backup and bridges). Health stays judged by the snapshot only.

State: `OUT/online.json` (global, written by each tick); `OUT/bridges.json` (`NightState`, per day, like `backup.json`).

Deletes: the name `backupDue` (one rule for the day's chores); the bootout race.

Net lines: expected +45 / −15.

Plan review: reshape, applied: dropped `online.json`/`onlineOf`/`isSettled` (an offline tick runs nothing, and silence
never alerts); one `isOfflineFailure` for the night and the backfill; the rename finished in comments and tests; the
AGENTS.md rows. Kept: the bridge wait in `healBridges`, not `restartBridges` (`add` and `remove` must not fail because
another bridge is down). The glossary's "tick" (the watcher's minute) vs the nightly's 30-minute tick is older than
this change and left alone.
