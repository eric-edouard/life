Explanation: the iPhone app as it stands on 2026-11-23 (repo HEAD date), for planning. Not maintained; check the code before relying on a detail.

Paths are relative to `apps/lifelog/apps/ios/` ("ios/") unless they start with `docs/`. Line counts are `wc -l` of `.swift` files.

## 0. What the app is

One iOS app (target `Lifelog`, `project.yml`) with three jobs: (a) the pendant pipeline (Bluetooth capture, local library, upload to the lifelog server, backup), (b) a client of Life's connector (inbox cards, matters, people, agents, Ask Life, spending, logs), (c) the iPhone's own recording controls (widgets, Shortcuts, Watch). Extensions in `project.yml`: `LifelogWidgets` (`Widgets/`), `LifelogWatch` + `LifelogWatchWidgets` (`Watch/`), `LifelogNotificationService`, `LifelogNotificationContent`. Shared code: Swift package `Kit/` (`LifelogKit`, 15 libraries) and `Shared/` (palette, metrics, app-group keys, copy used by app, widgets and Watch). Debug-only fixtures drive launch arguments (`-fixtureTab`, `-fixtureCard`, ... in `Lifelog/Fixtures/LifeFixture.swift`, `RootView.showFixtureScreen`).

## 1. App structure

- Entry: `Lifelog/LifelogApp.swift` (218 lines). `@main LifelogApp` shows `RootView`; `AppDelegate` owns and creates the stores before any view: `CaptureStore` (pendant), `LibraryStore?` (local recordings, `Kit/Library`), `SyncStore` (upload driver), `NetworkPath`, `AppleHealthReader`, `LifeStore` (Life reads/actions), `PlaybackStore`. It starts capture on launch (iOS may relaunch the app for Bluetooth), registers the `BGProcessingTask`, remote notifications, and wires notification callbacks (`capture.notifier.answer`, `.card`, `.removeAppointment`) into `LifeStore`.
- Root: `Lifelog/RootView.swift` (199). `NavShell` + overlays + sheets. Environment holds `AppRouter`, `LifeStore`, `CaptureStore`, `SyncStore`. Foreground loop: `life.refreshOnForeground()`, retry of first reads, then `life.refresh()` every `SyncMark.readEvery` (about a minute). A card push while foregrounded calls `life.refreshInbox()`. Appearance (auto/light/dark) is an `@AppStorage`.
- Shell (`Lifelog/Shell/`, 1,128 lines): `AppRouter.swift` (372; the one navigation state), `NavShell.swift` (121), `HomeList.swift` (134), `TopBar.swift` (182, the toolbar modifier `ShellBar`), `ReadScreen.swift` (186, the loading/stale/empty/failed wrapper every read screen uses), `AppointmentSheet.swift` (133).
- "Tabs": `AppRouter.Tab` is `inbox, projects, people, profile`, but there is no tab bar (NavShell comment: "navigation v3, no tabs"). `NavShell.page` switches on `router.tab`. The list `HomeList` is the Inbox page's root on a phone: rows Projects, People, Profile (Profile is a floating button in the Duo's column), then the cards, then matters that do not wait on him (order Priority or Latest, `@AppStorage("drawerOrder")`). Back on Projects/People/Profile returns to the list (`ShellBar.isBackToList`).
- Poses (`AppRouter.pose`): stacked (phone, closed Duo), upright (open Duo, list is a panel over the page), sideways (list is a 380pt sidebar). Fold/Duo handling is a large part of the shell (`isBarsInColumn`, `reportsSideColumn`, `DuoPose` fixture).
- Sheets: `AppRouter.sheet` (only `.pendant`), `appointment` (event sheet), `matterSheet` (agent, start agent, icon grid), `projectAsk` (a project's ask), `confirming: PairOffer?` (pairing link, `Settings/PairSheet.swift`), plus per-card sheets hosted in `Inbox/CardView.swift` (`AskSheetsHost`: same-as, create, Wrong..., context, voice run). `askLife: AskLifeForm` (`away`, `strip`, `full`) is a seventh surface, not a sheet.
- Navigation stacks: `inboxPath` (`.ask` pushed on the list), `matterPath` (`MatterRoute`: card, agent, matter, session), `personPath` (`PersonRoute`: part, latest, writing, party), `profilePath` (`ProfilePage`: settings, vocabulary, apps, backup, connection). Detail column state: `detail` (`.matter`, `.project`, `.agents`, `.spending`).
- Deep links and routing in: `onOpenURL` handles only `lifelog://pair?life=...&code=...` (`PairOffer(link:)`, shown as a confirm sheet over anything). Notification taps arrive as `capture.routeToOpen: NotificationRoute` (`Kit/Sources/Incidents/NotificationRoute.swift`: `.card(pushId, card, life)`, `.appointment(pushId)`, `.inbox`, `.removed`) and `RootView.open(_:)`. Internal jumps: `router.open(matter:)`, `open(party:)`, `open(agent:)`, `open(project:)`, `open(ask:)`, `open(shown:)`, `showProfile/openSettings/showProjects/showPeople/showHome`. A `life:<ref>` link inside card context opens a sheet (`LifeLinkTarget`, `DesignSystem/ContextSheet.swift`).
- What Ask Life sees of the screen: `AppRouter.mainSessionScreen` sends `MainSessionScreen(tab, open)` with refs only.

## 2. Screens

Reads go through `LifeStore` (section 5) over connector tools. "Reached from" is the router entry.

| Screen | Files | Shows | Calls | Reached from |
|---|---|---|---|---|
| Home list (Life) | `Shell/HomeList.swift`, `Inbox/CheckList.swift`, `MovesList.swift` | Projects/People/Profile rows; open cards by urgency (blocks, then can wait); Filter "Your moves"; matters not waiting on him; Ask Life's cut list | `read_inbox`, `read_matters`, `read_projects`, `read_people_and_organizations` | Root; Back from pages |
| Inbox / ask on show | `Inbox/InboxScreen.swift` (209), `CardView.swift` (434), `CheckCard.swift` (221), `CheckBodies.swift`, `CheckActions.swift` (455), `BulkCard.swift`, `AnswerResultView.swift` | One card at a time with a pager (`AskPlace`, dots in the bottom bar); the answer's result | `read_inbox`, `answer_check`, `read_inbox(pushId)` (open from push) | Row in list; notification tap; Ask Life `card` answer |
| Card sheets | `Inbox/SameAsSheet.swift`, `CreateSheet.swift`, `NameVoices.swift`, `GuessRows.swift` | Same-as picker, create person/organization, voice naming, guessed names | `answer_check`, `read_people_and_organizations` | From a card's answer |
| Projects list | `Matters/ProjectsScreen.swift` (350), `ProjectsList.swift` (115), `ProjectHead.swift`, `ProjectDetails.swift` | Projects underway, areas as chips, parked/done; chip filters the matters; swipe marks important; project Details (status) | `read_projects`, `read_project`, `read_matters` (project/area), `read_matters`, `correct_memory` (important), `change_directory_entry` (status) | List row; `router.open(project:)` |
| Matter page (thread) | `Matters/MatterThreadPage.swift` (547), `ThreadLines.swift`, `MatterIconSheet.swift` | Name, icon, goal and next step (edit in place), people chips, the day-by-day thread, waiting asks with answers, Mark done | `read_matter`, `fetch` (`<id>/thread`), `correct_memory` (direction, icon, important, done), `answer_check` | List row; chip on a card; person page; `open(matter:)` |
| Agent page, session | `Matters/AgentPage.swift` (296), `AgentSessionPage.swift`, `AgentSheet.swift`, `StartAgentSheet.swift` | An agent's state, wakes, moves; read-only session (pi); start an agent on a matter | `read_registered_agents`, `read_agent_session`, `change_registered_agent` (start, stop, resume, change_model, hand_over, continue_on_mac) | Matter page; Settings "Your agents" (detail `.agents`) |
| People list | `People/PeopleScreen.swift` (242) | People and organizations in Life's order, search, Ask Life's cut | `read_people_and_organizations`, `read_person_pictures` | List row |
| Person page | `People/PersonPage.swift` (488), `PersonParts.swift`, `PicturesSheet.swift` | Who, reach tiles (per app), open matters, lately, details, what Life knows, latest exchanges, how each writes | `read_people_and_organizations` (one), `read_matters` (person), `fetch` (parts, latest, reach), `read_chats`-style reads via `fetch`, `change_directory_entry` (picture) | People row; chip; `open(party:)` |
| Organization page | `People/OrgPage.swift` | An organization and its people | as person | People row |
| Profile | `Profile/ProfileScreen.swift` (87) | Spending row, devices (Mac, Pendant, Pendant server), Vocabulary, Apps, Your data, Settings | none itself | List row; Duo column button |
| Settings | `Settings/SettingsView.swift` (512), `Light guide`, `AppsPage`, `VocabularyView` | Needs-you rows, permissions, agents count, sending (Face ID), dictation, pendant options, Ask Life look, appearance, help | `read_log_lines` (problems line), server settings via ServerAPI | Profile |
| Connection pages | `Settings/ConnectionPage.swift`, `PairSheet.swift`, `Connection/*` | Address, pair/unpair Life or the lifelog server, queue waiting, refused edits, connection check | OAuth pairing to Life, `LifePairing`; lifelog server `ServerAPI` | Settings; pairing link |
| Spending | `Settings/SpendingPage.swift` | Model spending | `read_spending` | Profile row (`router.show(.spending)`) |
| Live logs | `Settings/LiveLogsPage.swift` (267) | Life's log lines | `read_log_lines` | Settings |
| Diagnostics | `DiagnosticsView.swift` (256) | Agent/desk health, inbox read state | `read_registered_agents`, `read_inbox` | Settings |
| Backup | `Export/BackupView.swift`, `BackupStore.swift` | Back up and restore the local library | none (local) | Profile "Your data" |
| Pendant sheet | `Pendant/PendantView.swift` (340), `PendantTiles`, `PendantFacts`, `IncidentCards`, `PairPendantSheet`, `ReplaceSheet`, `OmiCustodyCard`, `Permissions.swift` | Pendant state, what to do, battery/storage facts, what is not on the Mac yet, pair or replace | none to Life; lifelog server status through `SyncStore` | Pendant button in every page's top bar (`router.sheet = .pendant`); Duo column |
| Appointment sheet | `Shell/AppointmentSheet.swift` | An appointment Life added to his calendar; Remove/Undo | `read_appointments`, `change_appointment` | Appointment push; row |
| Ask Life | `AskLife/AskLifeStage.swift`, `AskLifeAnswerView.swift`, `AskLifeSettings.swift`, `DesignSystem/AskLifeControl.swift`, `AskLifePieces.swift` | Round button, strip card, full-screen stage with the answer | `ask_main_session` (streamed) | Button on every screen; card "Wrong..." |
| Dictation | `Dictation/DictationCapture.swift`, `DesignSystem/DictationField.swift` | Mic/hold/slide-to-send in every text field | none (audio queued to lifelog server; words come back from it) | Any text field |

Not in the app target: tests (none; only Kit tests). The Watch app (`Watch/`, 618 lines) is a recording remote; widgets (`Widgets/`, 310 lines) show recording state and a control.

## 3. Main flows

### 3.1 Answering a card
1. `read_inbox` fills `LifeStore.inbox` (`Inbox` model, `Kit/.../Models/Inbox.swift`, `Check.swift`). Order: `Inbox.ordered` (blocks first, `Urgency`); `AskPlace` in `AppRouter` holds current card, kept-for-later, filter kind.
2. `CheckCard` draws the card from what it holds, never from a kind: matter chip, question, a "thing" tile, then the answers in a bottom bar (`CheckActions`). The tile content (`CheckCard.content`): context Markdown with `life:` links (`ContextView`, `ContextMarkdown` package), `PlanBlock` (plan steps), `DraftBlock` (the exact message, `DesignSystem/DraftBlock.swift`, also used by the notification extension), `NeedsBlock` (+ `PayCodeBlock`) for account/amount/link/app/event/place/text/qr needs (`Kit/.../Models/Need.swift`), then per group.
3. Card groups (`CheckGroup`, `Check.swift`): `decision` (agent question, may carry a draft), `ending` (`EndingBlock`, is it done), `name` (`NameBlock`), `voice` (`VoiceBlock`, `NameVoices`), `contacts card`, `guessed person` (`PersonIdentityBlock`, `GuessRows`), `new matter` (`NewMatterBlock`: Start/Dismiss, edit goal), `same person` (`SameAsSheet`), `at organization`, `your move` (`MovesList`). Cards Life pre-ticks fold into `BulkCard`.
4. Buttons come from the card's `options` (id, label, icon, `takes` person/name/words, `outgoing` for a send, `ends`, `adds`, `runs`). Layout rule in `CheckActions`: deadline line, at most two rows; one full-width first answer, the rest in a row; his own words ("Tell the agent...", `DictationField`) always last; "Wrong..." on Life's own cards (`check.misread`) opens Ask Life with the card as context; "Looking" for a payment check (`doneSeen`); bank trip for pay cards (`BankTrip`).
5. A tap builds `AnswerRequest(ref, options, note, person, name)` and calls `LifeStore.answer` -> `answer_check` over MCP with an idempotency key (`ActionBook`, `ActionState`, `PendingTaps`). A draft's Send is the option with `outgoing == true`; Life sends only the stored draft. States: working, then Life's proof (`AnswerResult`, `AnswerResultView`: what was written, send outcome, whether the asker was told); failures show in a `flag` line; `not sent` re-opens the card. `refreshAfterAnswer` re-reads inbox and the card's matter. Out of reach (`LifeConnection.lost`) disables answers (`offWhileOutOfReach`).
6. The same answer from a notification action goes through `capture.notifier.answer` into `LifeStore.answer` (3.5).

### 3.2 Ask Life
1. Open: round button (`AskLifeControl`, 52pt bottom-right; 48 in the Duo column) -> strip (glass card above the bar, dictating immediately) -> full screen (`AskLifeStage`, drag grabber). `AppRouter.askLife` is the form.
2. Send: `AskLife.send(text, screen:)` (`Kit/.../AskLife.swift`, 271 lines, `@Observable`, lives in `life.askLife`) calls `ask_main_session(words, screen)` with an answer key; the same words reuse the key (safe retry). Offline: stage `offline`, "goes as soon as it's back".
3. Streaming: progress lines `thinking`, `working` (strands with title/state), `words`. Stages: ready, thinking, working, offline.
4. Final answer `AskLifeAnswer`: `reply(words, why, sources)`, `question(question, answers)`, `error`, `done(words, matter)`, `agent(words, agent, told)`, `card(words, card)`, `fix(words)`, `unknown`. Shown as one line in the strip, or in the stage with chips (e.g. open the card/matter).
5. `shown`: the result may carry one `show` (`AskLifeShow`): a page (matter, person, project, agent) or a list (matters, checks, people; refs and a label). Applied by `AppRouter.open(shown:)`: a page opens at once (`RootView.onChange(of: askLife.shown)`) and Ask Life goes away; a list waits behind a nudge in the strip/stage (`pendingList`) until tapped, then switches to that list's page, sets `router.cut` and filters the rows to the refs (`ShownList.cut`), strip stays. Nothing is drawn inside the conversation; `show` arrives only with the final result. Source of truth for the server side: `docs/plans/2026-11-23-chat-first-app.md`.
6. Undo: cancel folds the card and offers "Nothing sent . Undo" for 4 seconds (`AskLifeControl`).

### 3.3 Opening a matter, person, project
- Matter: list row or chip -> `router.open(matter:)` (tab becomes Projects, `matterPath` reset, `cameFrom` remembers where Back goes) -> `LifeStore.refreshMatter` (`read_matter`) + `refreshThread` (`fetch <id>/thread`, `PageChain` paging by whole days) -> `MatterThreadPage`.
- Person/organization: `router.open(party:)` -> People tab -> `refreshPerson`, `refreshReach`, `refreshLatest`, `refreshOpenWith`, `refreshProse`.
- Project: `router.open(project:)` sets the Projects `chip`; Details via `openDetails(of:)`.
- Cached state shows first (stale marker) when Life is not reachable (section 5).

### 3.4 The pendant
- Pairing: `Pendant/PairPendantSheet.swift` (looks nearby, takes the first pendant found, checks: found, paired, first sync). Replace: `ReplaceSheet`. Bluetooth transport and state machine are in `Kit/Capture` (`CoreBluetoothTransport`, `ConnectionMachine`, `DrainCoordinator`); `CaptureStore` (488) is the app-side owner.
- Recording state: `CaptureStatus` -> `PendantReading` (`Kit/Incidents`) -> `PendantScreen` states ("Recording", "Paused at ...", no pendant, disconnected...). The top-bar `PendantItem` shows a glance on every page.
- Pause/resume: `CaptureStore.pause()/resume()` -> `DrainCoordinator.requestPause()`; outcome pending then confirmed/failed in `status.recording`. Same request from Shortcuts (`Lifelog/Intents/PendantIntents.swift`), Control/widget (`Widgets/`, `Shared/WidgetIntents.swift`), Watch (`WatchRelay.swift`, `Watch/App/PhoneLink.swift`, `Watch/Shared/FaceIntents.swift`). The pendant's own button also pauses.
- After capture: audio saved -> `SyncStore.run(audio:)` (`Kit/Upload`) -> lifelog server; background via `BGProcessingTask`, silent push, 15 s poll while active. Dictation (`DictationCapture`) records the phone mic into the same library and queue.

### 3.5 Notifications (`Lifelog/IncidentNotifier.swift`, 256; `NotificationService/`, `NotificationContent/`)
- Local, capture incidents (`IncidentReducer`, `Kit/Incidents`): recording stopped, control failed, storage write failed, integrity, pendant storage low, phone storage low, no contact, battery low, paused/resumed on pendant, disconnected/reconnected (with pages catching up). Pendant changes (`PendantChangeReducer`). Tap opens the app as it was.
- Life pushes (APNs, sent by the Mac): new open card (payload `pushId`, kind per his settings), cards that left the inbox (`removed`, background, removes their notifications), appointment added (`calendar.added`). `NotificationService` rewrites the text from the card kept in the payload (`CardNotification`: title/subtitle/body limits 40/40/110; whole draft as text for sendable cards). `NotificationContent` draws the `DraftBlock` in the expanded view.
- Actions: category `life.card` has "Reply..." (text input, sends the words as the answer); `life.card.send` has "Send" and "Reply..."; the expanded view adds the card's own one-tap options; all `.authenticationRequired` (unlocked phone/Watch, Face ID optional by setting). `life.calendar`: Remove, Open in Calendar. Answers run through `LifeStore.answer`/`notifiedCard` (re-reads the card first), then the notification is replaced by the result.
- Watch: shows the same notifications and actions (category actions); the Watch app itself is recording control only (`RemoteView`, complication `RecordingComplication`).

### 3.6 Incidents
`CaptureStore.openIncidents` feeds `IncidentNotifier.update` (notifications) and `Pendant/IncidentCards.swift` (cards inside the Pendant sheet, with recovery buttons) and Settings "Needs you". Also `HealthReporter.swift` (heartbeat/diagnostics to the server) and `SnapshotPublisher.swift` (state for widgets/Watch via app group).

## 4. Shared components and design system

- Lifelog/DesignSystem/ (26 files, 4,855 lines, about 82 `View` structs): tokens `Typography.swift`, `Glass.swift`, `Motion.swift`, `Fonts/`; components `Components.swift`, `Pieces.swift` (badge, link, quiet chip, add row, busy pill, spinner, segment, paper box, row, row group, field, state mark), `PartyPieces`, `PersonPieces`, `MatterIconPieces`, `AgentMark`, `NetworkMark`, `LogPieces`, `WakePieces`, `SessionLineView`, `DraftBlock`, `ContextSheet`, `DictationField`, `AskLifeControl`/`AskLifePieces`, `QRTile`, `RowSwipe`, `ScreenTitle`, `TickRow`, `FilterChip`, `SpokenWords`, `WholeWords`, `DesignSystemPreviews`.
- Shared tokens outside the app: `Shared/Palette.swift` (52), `Shared/Metrics.swift` (59; spacing, radius, gutter, list row 60), also used by widgets and Watch. Brand source: `assets/brand/tokens.css`, rules `docs/brand.md`. Rules enforced by `scripts/design-system.test.ts` (counts hand-drawn pieces; caps only go down) and reviewed with `design-review.md`.
- Brand rules that shape the UI (`docs/brand.md`): agents shown by their program's mark, never named roles; every free-text field is a `DictationField`; lists are grouped inset cards (rows at least 60 high); nothing pressable is bare text (`QuietChip`, `TextLink`, `AddRow`); one radius per job.
- Kit packages hold no screens except pure-logic types the screens use. Models for Life's wire are in `Kit/Sources/LifeConnector/Models` (25 files, 4,282 lines).

## 5. Data layer

- `LifeStore` (`Lifelog/Life/LifeStore.swift`, 1,049; `+Agents` 173; `ActionTrace`, `Keychain`, `LifeToken`): `@MainActor @Observable`, one per app. Holds a `ReadState<T>` per read: `inbox`, `matters`, `projects`, `agents`, `spending`, `people`, and keyed dictionaries `matter[id]`, `projectHead[id]`, `scopedMatters[chip]`, `agentSession[id]`, `person[ref]`, `latest`, `prose`, `thread`, `reach`, `openWith`; plus `parties: PartyBook` (names/pictures, `PictureCache`), `actions: ActionBook<ActionKey>` (in-flight and finished writes), `saidBack` (the "Done . Undo" line), `askLife`, `openedCard`, `pushed`, answered-card memory (`AnsweredCards`), move receipts. Pairing: `pair(_:)`, OAuth against the Mac (`Kit/.../OAuth.swift`, `LifePairing.swift`, `Credentials.swift`; token in Keychain).
- Reads: `LifeAPI` protocol (`Kit/.../LifeAPI.swift`, 345) over `MCPClient` (JSON-RPC over HTTP with SSE progress, `MCPClient.swift`, `SSE.swift`, `LifeHTTP.swift`). Tools used: `read_inbox`, `read_matters` (all, by project, area, person), `read_matter`, `read_projects`, `read_project`, `read_registered_agents`, `read_agent_session`, `read_spending`, `read_people_and_organizations`, `read_person_pictures`, `read_log_lines`, `read_appointments`, `fetch` (refs: thread, parts, latest, reach, `life:` links), and writes `answer_check`, `change_registered_agent`, `correct_memory`, `change_directory_entry`, `change_appointment`, `ask_main_session`.
- Versioned reads: `Versioned(ifNot:)` sends the last version stamp; an unchanged read costs one small answer (`SyncMark`, `readEvery`).
- Cache: `ReadCache` (`Kit/.../ReadCache.swift`) keeps the last good JSON text per read key on disk (excluded from backup); a cold start restores it and shows it as stale. `ReadState.Shown`: loading, loaded, empty, stale(since, why), unreachable, failed, notPaired. `ReadScreen` draws these for every screen. `LifeConnection` decides "out of reach" (network path plus last settled read); out of reach the app is read-only.
- Writes: `perform` with `ActionKey` (answer, start, agent, move, edit, project, appointment, picture, continueOnMac); optimistic holds (`PendingTaps`) until a read confirms; Undo via `SaidBack`.
- Wire types (`Kit/Sources/LifeConnector/Models/`, 4,282 of LifeConnector's 6,994 lines): `Check`, `Inbox`, `Need`, `CardNotification`, `AnswerResult`, `Matter`, `MatterThread`, `Project`, `People`, `Party`, `RegisteredAgent`, `AgentSession`, `AgentMove`, `YourMoves`, `Appointment`, `Payment`, `ChatStrip`, `LogLines`, `ModelSpending`, `LifeLinkRead`, `WakeLine/WakeWords`, `DeadlineWords`, `SaidWords`, `Channel`. Decoders tolerate unknown values (`UnknownTolerant`).
- Pendant side: `CaptureStore` (pendant state, incidents), `SyncStore` (upload driver, outbox, feed from the lifelog server, status), `PlaybackStore` (clips), `BackupStore`, `Kit/Library` (`LibraryStore`: local conversations/audio), `Kit/SourceStore`, `Kit/ServerAPI` (lifelog REST), `Kit/Upload`. Settings: `Kit/OwnerSettings` `Settings.shared`, `AppGroup` defaults, `@AppStorage` for display choices.
- The phone is one client of the connector, paired by code; the lifelog server pairing is separate (`DeviceToken`).

## 6. Size (Swift lines)

Lifelog/ app target, by folder:

| Folder | Lines | Files | Kind |
|---|---|---|---|
| DesignSystem | 4,855 | 26 | UI |
| Inbox | 3,341 | 15 | UI |
| Matters | 2,326 | 11 | UI |
| Settings | 1,650 | 8 | UI |
| Pendant | 1,631 | 12 | UI (pendant screens; reads capture state) |
| Fixtures | 1,393 | 5 | debug UI fixtures |
| Life | 1,346 | 5 | data (LifeStore) |
| People | 1,129 | 5 | UI |
| Shell | 1,128 | 6 | UI (navigation) |
| Sync | 493 | 1 | pendant pipeline (SyncStore) |
| Connection | 214 | 3 | connection checks (UI + path) |
| Export | 207 | 2 | backup (store + view) |
| AskLife | 199 | 3 | UI |
| Dictation | 175 | 1 | recording (phone mic) |
| Playback | 244 | 2 | audio playback |
| Intents | 102 | 1 | Shortcuts for the pendant |
| Profile | 87 | 1 | UI |
| Top-level files | 2,247 | 14 | `CaptureStore` 488, `HealthReporter` 349, `DiagnosticsView` 256, `IncidentNotifier` 256, `LifelogApp` 218, `RootView` 199, `LocationRecorder` 116, `FakeScenario` 104, `AppleHealthReader` 92, `WatchRelay` 73, `SnapshotPublisher` 41, `DeviceToken` 42, `Awake` 13 |

The whole `Lifelog/` target is 22,767 lines (folders above 20,520, top-level files 2,247).

Other targets: `Shared/` 988, `Watch/` 618, `Widgets/` 310, `NotificationService/` 91, `NotificationContent/` 70. The app target has no test target.

Kit packages (source / tests):

| Package | Source | Tests | Kind |
|---|---|---|---|
| LifeConnector | 6,994 (56 files) | 5,444 | Life client (UI-facing data) |
| Capture | 3,187 | 2,285 | capture (Bluetooth, drain) |
| Upload | 1,993 | 2,799 | upload |
| ServerAPI | 1,666 | none | lifelog REST |
| AudioPipeline | 1,540 | 575 | audio |
| SourceStore | 1,288 | 372 | capture storage |
| Library | 1,141 | 329 | local library |
| PendantProtocol | 1,119 | 518 | capture protocol |
| Incidents | 991 | 938 | capture incidents + notification routes |
| Health | 777 | 327 | heartbeat reports |
| Timeline | 560 | 309 | capture timeline |
| Export | 457 | 153 | backup export |
| ContextMarkdown | 249 | 121 | Markdown for card context (UI) |
| Glance | 154 | none | widget glance |
| OwnerSettings | 51 | 45 | settings |

Kit source totals 22,167 lines; Kit tests 14,215.

UI versus capture: UI is `Shell`, `Inbox`, `Matters`, `People`, `Profile`, `Settings`, `AskLife`, `DesignSystem`, `Pendant` (screens), `Fixtures`, parts of `Connection` and `Export`, and Kit `LifeConnector` (the data side of the UI), `ContextMarkdown`. The pendant pipeline (capture, recording, upload) is `CaptureStore`, `Sync/SyncStore`, `Dictation`, `Playback`, `LocationRecorder`, `HealthReporter`, `AppleHealthReader`, `IncidentNotifier` (capture alerts, though it also routes Life's card pushes), `Intents`, `WatchRelay`, `SnapshotPublisher`, `Awake`, and Kit `Capture`, `PendantProtocol`, `SourceStore`, `Library`, `AudioPipeline`, `Upload`, `ServerAPI`, `Health`, `Incidents`, `Timeline`, `Export`, `Glance`. The two meet in `RootView`/`LifelogApp` (store wiring), the Pendant sheet and the top-bar pendant item, and `IncidentNotifier` (one class handles both capture alerts and card notification actions).
