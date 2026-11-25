# Overhaul: code facts gathered for the plan (25 Nov 2026)

Reference: facts checked in the code at `0e2f4f4e` for the overhaul's planning session, with file and line. Input for
the plan (`docs/plans/2026-11-25-overhaul.md`); not maintained. Paths are under `apps/server/src/` unless they start
with `apps/` or `docs/`.

## The main session

- `MAIN_BRIEF` (`desk/main-session.ts:62`) fixes answers at "two short sentences at most", no preamble, no emoji, and
  tells the session to call `answer` before its final text and `show` to put a page or a cut list on screen.
- Woken only by his words: `isWokenOnlyByHisWords` (`records/registered-agent.ts:114`), checked at
  `host/desk-read.ts:237` (no wait) and `desk/desk-clock.ts:375` (`dueOf`: never by the clock).
- One ask at a time: "Life is still answering your last words." (`desk/main-session.ts:311`).
- `show`: door tool at `desk/desk-door.ts:520`; `keepShow` (`main-session.ts:126-131`), `LIST_ROWS` (`:145-158`),
  `showProblemOf` (`:161-188`, a project page must be in `truth.projects`). Wire `MainSessionShow`
  (`records/main-session-wire.ts:46`). Sizes: `main-session.ts` 478 lines, `desk-door.ts` 698, the wire 100.

## The pi runtime

- `@earendil-works/pi-coding-agent` 1.6.0 (`apps/server/package.json:9`), `--mode rpc` (`desk/runtimes/pi-runtime.ts:447`).
- A process per background turn (`session-runtime.ts:272` `send`, `:284` `start`, `pi-runtime.ts:644` `spawnFor`);
  only the main session's `talk` and `keep` stay open, `KEEP_WARM_MS` 5 min (`session-runtime.ts:24`).
- One route for every pi turn: `piRouteOf()` (`models/llm.ts:155`), `OPENROUTER_MODELS.main`, used at
  `pi-runtime.ts:155` and `:345`.
- Tools all direct: `exposure: "direct"` (`pi-extension.ts:239` desk door, `:245` reads server); pi's built-ins off:
  `-builtin:codemode`, `-builtin:tool-search` (`pi-runtime.ts:226-227`).
- The runtime contract (`desk/runtimes/contract.ts:55-101`: `block`, `continueOnMac`, `keep`, `send`, `start`,
  `state`, `stop`, `talk`) has no steer, follow-up or cancel. pi's RPC mode handles `steer`, `follow_up` and `abort`
  (`dist/modes/rpc/rpc-mode.js:345-353` in the installed package); Life sends `abort` only internally
  (`pi-runtime.ts:800`).
- No latency breakdown is recorded today (process start, MCP ready, first token, tool calls).

## Settings

- Read once per process: `core/settings.ts:221-225` (`read ??= readSettings()`); 39 non-test files call `settings()`.

## Cards, order and push

- `decisions.jsonl` lines (`memory/decision-lines.ts`, 220 lines; `memory/decisions.ts` 827): `asked` (`:19-34`, the
  whole `Ask` plus asker, assignment, draft, matter) and `answered` (`:36-50`: picked option ids, note, answer key,
  `via`). No field marks the recommended option (only "the recommended one first", `card-request.ts:83`); the order
  shown and the push level are not recorded.
- Order: `RANK` (`memory/check-urgency.ts:18`), `inboxOrderOf` (`:129`); 160 lines.
- Push: `NOTIFY_DEFAULTS` (`host/card-push.ts:42`), `levelOf` (`:86`), `pushNewCards` (`:193`); 236 lines. The send
  goes Life → lifelog (`notifyPhone`, `sources/lifelog-push.ts:29-39`, called at `card-push.ts:142`) → APNs
  (`apps/lifelog/apps/server/src/apns.ts:142`). The phone's notification service reads the card from the connector by
  its `pushId` (`apps/lifelog/apps/ios/NotificationService/NotificationService.swift:36-43`); no
  `INSendMessageIntent` anywhere.
- Other sizes: `host/inbox.ts` 177, `memory/checks.ts` 595, `memory/your-move.ts` 344.

## How fast messages reach Life

- Archive copy every 5 s (`host/archive.ts:255`); WhatsApp from the Mac app's store (`sources/whatsapp.ts:30`);
  bridged networks read from the homeserver's SQLite by event number (`sources/matrix.ts:52`,
  `sources/bridged.ts:221-241`), polling only, no `/sync`.
- The desk polls messages every 30 s (`TICK_MS` 5 s × `POLL_EVERY` 6, `desk/desk-helper.ts:40-41`).
- Units and the arrival reader every 5 min (`TODAY_EVERY`, `host/watch.ts:321`, `:361`).
- New decisions reach the phone within 3 s (`DECISIONS_EVERY`, `host/watch.ts:323`).

## When Life can't be reached

- Nothing tells the phone the Mac or Life is down: the phone infers it from failed reads (`LifeConnection.swift`).
  The Mac flags a silent phone after 12 h (`host/status/snapshot.ts:351-361`), on the Mac only.

## Projects and who acts

- `agentForOf` (`memory/held-matters.ts:59`): the oldest standing agent of the matter's project, else Personal.
  `agentForMatterOf` (`memory/read-matters.ts:453`) over `projectOf` (`:365`), called from `desk/hand-out-tick.ts:82`,
  `desk/agent-changes.ts:295`, `desk/card-home.ts:69`, `desk/matter-net.ts:192`, `host/registered-agents.ts:623`.
  The fold: `foldAssignments` (`desk/matter-net.ts:464`). Personal routing: `desk/arrival-route.ts:172,187`,
  `desk/spoken-ask-intake.ts:188`.

## The connector's tools (36) and who uses them

- Used only by the iPhone app: `read_log_lines`, `read_registered_agents`, `ask_main_session`, `read_person_pictures`,
  `read_project`, `read_projects`, `read_spending`, `read_agent_session`, `answer_check`.
- Used by neither the app nor the desk (outside clients: claude.ai, Claude Code): `read_day`, `read_resource_samples`,
  `read_places_visited`, `read_life_status`, `read_processing_runs`, `read_observation`, `read_payments`,
  `read_new_events`.

## The iPhone app

- `Lifelog/` is 22,767 lines. Pure old-navigation UI that can go outright, about 7,500 lines: `Inbox/` 3,341,
  `Matters/` 2,326, `People/` 1,129, `AskLife/` 199, `Profile/` 87, `Shell/` `NavShell`, `TopBar`, `HomeList` 437;
  with them `Fixtures/` 1,393, most of `Settings/` (spending, live logs, apps, vocabulary, light guide), `AppRouter`
  372 and `ReadScreen` 186, and about 1,500 lines of `DesignSystem/` pieces only those screens use.
- Keep: the pendant pipeline (`CaptureStore`, `Sync/`, `Dictation`, `Playback`, Kit capture packages, widgets, Watch),
  `IncidentNotifier`, the notification extensions, pairing (`PairSheet`, `ConnectionPage`), `LifeStore` and the
  connector client, `DraftBlock`, `DictationField`, the tokens.
- Wire models only old screens use: `RegisteredAgent`, `AgentSession`, `AgentMove`, `YourMoves`, `Project`,
  `MatterThread`, `ModelSpending`, `WakeLine`/`WakeWords`; `Check` still references `People` and `RegisteredAgent`.
- Ask Life on the phone has no cancel (`Kit/Sources/LifeConnector/AskLife.swift`); `show` is applied by switching
  screens (`AppRouter.open(shown:)`).
- No app test target. Kit tests decode the server's own JSON from `apps/lifelog/fixtures/wire/`, written by the
  server's tests (`host/http/wire-fixture.ts`, `WRITE_WIRE=1`).
- `scripts/design-system.test.ts` pins exact counts of hand-drawn styling per file (`CAPS`): deleting a screen means
  deleting its entry.

## Tests

- The "7 failing tests" are not named anywhere in the repo or issues. Open flaky-test issues that may be among them:
  #766, #846, #1150, #1243. Only a run of the suite will say.

## OpenBot, read for ideas (its README and architecture docs)

- Request and reply between agents: a `send_message` tool; delegated work needs an explicit reply; a child task keeps
  its parent's owner; bounds by counts (open tasks per agent, assignments per request), no general timeout stated.
- One owner per task in a shared channel, picked by code first (explicit recipient, the task a reply attaches to, a
  sole open task), else by the lead's model in a session with no work tools; transfer and reassign explicit.
- Per agent, a busy message either steers the running turn or queues after it; mailbox state survives restarts.
- Duplicates avoided by stable ids for commands, assignments and results; no exactly-once side effects; no file locks.
- Licence: PolyForm Noncommercial 1.0.0 (Apache 2.0 up to 0.1.11).
