# apps/ios

`Lifelog/` is the SwiftUI app: one `@Observable` store per feature, the long-lived ones built at launch. `Kit/` is the
Swift package with everything that doesn't need UIKit, so it builds and tests on the Mac in seconds. `Watch/` and
`Widgets/` are the glances; `Shared/` holds code and copy that the app and its extensions share. `project.yml`
generates the gitignored `.xcodeproj`.
The app is Life's three tabs, Inbox (`Inbox/`: the `CheckCard`s, paged by swipe, and its `AnswerResultView`; one ask on show is `CardView`, hosted by the Inbox and by a matter's stack (`AppRouter.matterPath`); the Inbox is a `NavigationSplitView`: the list of asks (`CheckList`: what blocks first, then "The rest can wait" over what only improves; answers held, in flight, or confirmed after the read shown was asked are left out (`LifeStore.answersNewer`, `AnsweredCards`): a read asked later says what is open; its Filter menu (`FilterMenu`, via `filterBar`: a top-leading toolbar item, or a round glass button floating at the list's bottom left in the closed Duo's side column, so the top group stays the Pendant and Settings) keeps one kind of ask (`CheckGroup`, per screen state, never stored) in the list and the pager alike: `InboxOrder.only`) beside the one ask on show, whose swipe is a paged `LazyHStack`; every answer that is not a send, a start or a goal edit held 4 s for Undo in `LifeStore.held`, in the Inbox (and his word that a step is done, an option that `ends`, on a matter's stack too, its toast over the matter; never a notification's button) (its toast is an overlay at the top of the ask, or a 44 x 88 capsule in the side column of the closed Duo: `ColumnToast`, by `reportsSideColumn`)) and Matters (`Matters/`: the list, his marked matters first and a parked project's last under "Parked", a swipe to the right marks one; a matter's page, its mark in the bar and its project a link; a matter's icon down one chain, his pick, Life's, the first area's, the folder (`MatterRow.symbol`, Kit: Life sends the first two), its grid opened from the page's meta line (`MatterIconSheet`); a project's page, `ProjectPage`, its status one control; his mark and a project's status are sent at once; they and a matter's icon are said back with Undo, the opposite change: `LifeStore.saidBack`) and People (`People/`: everyone Life knows, closest first or A to Z, all, people or organizations, `PeopleList.groups` in Kit; a person's or organization's page, which every party Life names opens, `AppRouter.open(party:)`), plus
the system's search tab (`Shell/SearchScreen.swift`). The bars are two groups of system pieces, declared and never drawn
(`Shell/TopBar.swift`): on top the Pendant's icon and the Settings gear (Settings only from Inbox and Matters; a pushed
page has Back and the Pendant; a sheet only its Close: one head row in the content, its title left and Close right (`SheetHeader`, `CloseButton`), the
bar of its `sheetStack()` hidden, and `CloseItem` in the bar only for the Pendant sheet),
at the bottom the tabs. A screen's answers stay in its content, never in a bar. A list screen's name is its `screenTitle` (`DesignSystem/ScreenTitle.swift`, decision 84): the name and one muted state word ("Matters 7 running"), never a sentence, on the system's `safeAreaBar` with its soft scroll edge, never a navigation title; on Inbox, Matters, People and Search, and on Agents, Notifications, Last night, Live logs and Spending when they are built. A page whose first line is its name (a matter, a person, an agent) and a sheet have none. Sheets are centred, the system's
default: no `presentationPlacement` (`.leading` is missing on iOS 27.0 and crashes). The old Library, Conversation, Presses and
Spending screens are cut. Nothing in the app needs an agent's session: what waits on him comes to the app, and a session's link is only ever a quiet link (his word, 20 Nov). Every screen reads through `ReadScreen` (loading, empty, stale, unreachable, failed, not paired) and every
action through `LifeStore`'s `ActionState`. Manrope is the one font (`DesignSystem/Typography.swift`). `Shared/Palette.swift` is the phone's one copy of Life's brand (`assets/brand/tokens.css`), checked by
`scripts/brand.test.ts`: no colour literal elsewhere, except the hardware drawing (`LightGuide.swift`), which paint the pendant itself. `docs/architecture.md` names every store and owner and says where a new screen or derived value goes.

An agent is shown by its program's mark, never a star (`RuntimeName.mark`, `DesignSystem/AgentMark.swift`): Claude's and OpenAI's own, from their makers' kits, as custom symbols in `Lifelog/Marks.xcassets`, in one colour (OpenAI's terms allow none on its mark), a terminal for any other program; the program is the asking agent's, named by the ask's `agent` (`Check.askingRuntime`); an ask that names none (his own app's, a paired agent's) shows the terminal, never a guess. The spec's components live in `Lifelog/DesignSystem/Pieces.swift` and screens draw none of their own (badge, link, busy pill, spinner (`Spinner`, never `ProgressView`), segment, paper box, row, row group, field, state mark); one radius per job (`Metrics.Radius`). `scripts/design-system.test.ts` counts what screens still draw by hand; its caps only go down. A PR that changes a screen gets a design review before its debt verdict: a fresh agent of junior rank (sonnet, not haiku: judging two pictures needs more than the cheapest) with `design-review.md`, never the builder or the designer; it captures every state and transition itself, the designed stills with `bun run design:shots`. The same file runs as a whole-app audit after a redesign lands.

The fixture's content is the design data (`apps/lifelog/fixtures/design/`, one JSON file per connector read, wire shape), the one copy of it: the designer owns what it says and writes it, strings byte for byte as the frames show them, and their frame generator reads it from the root checkout; `LifeFixture` only reads it and keeps the behaviour (answered cards drop, scenarios, outcomes). The frame map has two halves joined by frame name: the designer's (`frame-map.json` in their folder: pose, size, picture, state) and ours (`frames.json` beside the data: launch arguments and taps, or why a frame can't be reached).

## How to

- **Regenerate the project** after editing `project.yml`: `bun run ios:project`.
- **Test Kit alone**, from Life's root: `swift test --package-path apps/lifelog/apps/ios/Kit --scratch-path .build/kit`.
- **Run in the simulator.** Debug builds take `-fixtureLife <scenario>` (Life without a Mac: `Fixtures/LifeFixture.swift`, reading the design data by its path on the Mac, or `-fixtureReads <folder>`, with its
  `-fixtureCard`, `-fixtureTab matters|people|search`, `-fixtureMatter`, `-fixtureProject` (its page), `-fixturePerson <ref>`, `-fixtureSheet pendant|settings|agent|icon|pair|pairing|replacePendant|pairPendant|create`, `-fixturePair ok|slow|expired`, `-fixturePage life|server|diagnostics`, `-fixtureAnswer`, `-fixtureStart`, and `-fixturePose wide|upright`, the iPhone Duo open drawn on any simulator), `-fixtureLibrary` (a demo library with audio), `-fakePendant <scenario>`
  (see `FakeScenario.swift`) `-offline` and `-serverFlaky` (the server times out and every other request is called off); launch with `xcrun simctl launch <udid> com.ericedouard.lifelog <args>`.
  The device token goes in through `SIMCTL_CHILD_LIFELOG_DEVICE_TOKEN` with `SIMCTL_CHILD_LIFELOG_SERVER_URL`, read from the file without printing it.
- **Check Release before an install.** The gate builds Debug only and `install:phone` builds Release, so anything
  DEBUG-only that leaks out of `#if DEBUG` breaks the install:
  `xcodebuild -project apps/lifelog/apps/ios/Lifelog.xcodeproj -scheme Lifelog -configuration Release -destination 'generic/platform=iOS Simulator' build`.
- **Install on the phone** with `bun run install:phone -- --no-watch`; include the Watch only when the Watch app
  changed. If the Watch install fails with "Connection invalid", the owner restarts the Watch on its charger and you
  retry once.
- **Write SwiftUI** after reading Xcode's own `swiftui-whats-new-27` and `swiftui-specialist` skills, in
  `/Applications/Xcode.app/Contents/PlugIns/IDEIntelligenceChat.framework/Versions/A/Resources/`.

## Worth knowing

- **iPhone Duo: layout branches on `horizontalSizeClass` only**, never device, screen size or orientation: compact is one
  pane, regular two (`CardArrangement` in the Inbox, the `NavigationSplitView` in Matters and People). State a fold must keep lives
  above the branch (`AppRouter`, the screen). Inside a split view's column read `windowSizeClass` (set at the root): the
  list column is compact even on the open Duo.
  The one other input is where the system puts the bars, its `toolbarVerticalEdge` (`reportsSideColumn`), never a guess: the
  Undo toast is a capsule in that column only on a compact width (the closed Duo); the open Duo keeps the worded toast, as designed.
- Every bundle id, the app group and the background task derive from `LIFELOG_BUNDLE_ID` in `project.yml` (beside
  `DEVELOPMENT_TEAM`); code reads them from the bundle's Info.plist (`AppGroup`, `SyncStore.backgroundTaskID`, `Keychain`). The Keychain
  service is `<app's bundle id>.server`, named from `LifelogBundleID` in every target that reads it (`Keychain`), which
  for the owner's build is the name it always had, so his stored token stays readable; changing the bundle id starts
  unpaired.
- The app is Life's Inbox and Matters, read through the connector, plus the Pendant's capture and upload. No screen
  reads the library; its cache of the server's feed stays, and any screen that returns reads the cache first
  (`docs/architecture.md`, "Local first").
- A source's `sentThrough` (on the server) means everything before it was sent or decided. A new install's uploader
  starts there (`Uploader.restore`) and never reads derived files below it: `derived/` and `upload/` are kept out of
  backups, `timeline.sqlite` is not, so a migrated phone has an index of sidecars it lacks. A lost sidecar is
  unanalyzed audio, never skipped (unlabelled audio counts as possible speech); from the cursor on it is rebuilt and
  uploads wait for it (`TimelineScanner.scan`).
- The owner's edits are `OwnerIntent`s sent with `SyncStore.perform`: queued in the outbox, shown at once. A value the
  server holds is never shown as known: asking, then the value (`serverValue`, `serverVocabulary`); a change shows at
  once, then Saved, or goes back with the reason. Settings draws only `Row` and `RowGroup`.
- Pairing goes one way: a `lifelog://pair` link (Camera or pasted) is opened by `RootView`, which shows `PairSheet`: it
  confirms naming each server, and only then `SyncStore.pair` or `LifeStore.pair` stores it. A server's token is checked
  against the server before it is kept (`Pairing.pair`), so a failed pairing leaves the old one working. A link never
  repoints the app alone, and a token is never drawn.
- `SyncStore` is the one driver: uploads, the outbox, the feed and the status. Debug builds pair from
  `LIFELOG_DEVICE_TOKEN` and `LIFELOG_SERVER_URL` in the environment (`DeviceToken.importFromEnvironment`), the one
  debug path.
- The app talks to Life only through its connector, in Kit's `LifeConnector`: its OAuth (pairing by the code in the
  `life` and `code` of the pairing link), one `MCPClient`, and `LifeAPI`, the only place tool names appear. Every read
  is a `ReadState` (`LifeStore` shows its `shown`), never a bare value, and runs one at a time per kind with one more pass (`ReadFlights`), so an older read never lands last, and one begun under an earlier pairing applies nothing (`PairingGeneration`). The fixtures in `fixtures/wire/life/` are written
  by Life's server tests (`WRITE_WIRE=1 bun test apps/server/src/host/http/mcp-phone-reads.test.ts`, and the answer and
  agent tests through `wire-fixture.ts`).
- Every action on Life (an answer, a start, stop, resume, model, his edit of a matter) runs in `LifeActions` and shows
  as an `ActionState` in `LifeStore.actions`: running with the steps as they stream, succeeded with proof, failed with
  its step, reason and whether a retry is allowed. Only the server ends one; past its `limitSeconds` it is late, never
  failed. An answer carries one `life/answerKey` (made at his tap, kept while the same tap repeats after a dropped
  connection, new after any result Life gave or for another answer to the same card), so Life sends nothing twice: a repeat of an answered card's same answer gets its first result under any key. Every action ends with one `life.action` event (steps with their seconds, limit, late, outcome): read it with `bun run events life.action` to see where a slow one spent its time. A
  card's buttons are its options' `label`s, and what an option `takes` (a person, a name, a note) is what the tap asks
  for (`Check.answer`; a `takes` this build doesn't know opens "Tell the agent…", on every agent card, never a dead
  button); a card's `context` is Markdown behind one link worded by the code (`Check.contextLinkTitle`; none without a context), which opens `ContextSheet` (`DesignSystem/ContextSheet.swift`: the system sheet, fit, medium and large; its blocks read in Kit by `ContextMarkdown`, the one reader of Markdown; a `life:` link's page, `fetch`, pushed inside with Back; a web link in Safari's view), and the open Duo's `ContextRegion` draws the same `ContextView` in place; a card's `needs` are drawn by `NeedsBlock` from `Check.Need.rows` (decided in Kit; a kind it doesn't know is
  its `line`; a link shows its full host and opens only on his tap), and Life's `doneSeen` is one line above the
  answers when seen or not found (`DoneSeenLine`); while Life is looking, one busy answer stands in their place; the phone decides nothing Life decides (what is open, a goal's steps): a matter's edits and Mark
  as done go by its id. A card's push is rewritten with the card's words by the notification extension (`NotificationService/`, `CardNotification`), which reads Life at the pairing's origin and no other and stamps the card with that origin (`CardNotification.read`); a draft's card takes the send category, so Send shows on the Watch too (`CardNotification.sendCategory`; not while his Face ID setting is on, `AppGroup.asksFaceIDToSend`, which only the phone can ask); expanded, it shows the draft (`DraftBlock`), the card's one-tap answers and Send (`NotificationContent/`, `CardNotification.isAnswerAllowed`), which the app answers in the background through `LifeStore.answer` (`IncidentNotifier`), on the card as the Life paired now has it (`LifeStore.notifiedCard`, `CardNotification.card`: the kept card only under the pairing it was read from, else Life's read of its `pushId`), never the kept card as it is; every answer goes to the Life it was decided for (`PairedLife`, captured at the tap, a held answer's when held): each try and retry at that origin with that Life's bearer (`MCPClient.call(at:)`), and none once another pairing began; a tapped push routes by `pushId` with the card the extension kept (`NotificationRoute.card`) and opens the Inbox on that card at once, from the cached inbox or the kept card, while one whole read checks it (`PushedCard`, the pager's spinner); with neither, the card-shaped skeleton waits for Life's read of its `pushId`, beside the whole read; a push while
  the app is in front reads the inbox again. The badge is `Inbox.badge`: the asks that block him (`urgency`).
- A server enum decodes unknown values as `unknown` (`UnknownTolerant`) and belongs in the mirror list of
  `ContractTests.swift` (lifelog's against its `openapi.json` in `mirroredEnumsMatchTheSpec`, Life's against `apps/server/src` in `lifesEnumsAreTheServers`), which also checks
  every path the client calls.
- The toolbar API is `toolbarMinimizationBehavior(_:for:)`; the WWDC docs' `toolbarMinimizeBehavior` doesn't compile.
- An Omi drains through the same `DrainCoordinator` as the Limitless Pendant, by its `DeviceCodec`. **Any work on the
  Omi starts by reading the latest Omi firmware release notes for the ring-custody fix** (`docs/research/omi.md`,
  first section). Once it ships, set `OmiFirmware.custodyFixedIn`, which turns the in-app warning into an update
  prompt, and say so to the owner in your report. Pairing another model moves `CaptureStore.deviceID` to its slot, so
  the first model's pages not uploaded yet stop uploading: Replace (`CaptureStore.replacePendant`) refuses until
  `whatIsNotOnTheMac` is empty, and a lost pendant is replaced only after the cost line and an explicit confirm.
  `.forget` clears only the phone's remembered pendant, never the pendant's own pairing or its audio.
- A widget's `configurationDisplayName` and `description` take a literal or a `String`: an interpolated literal is
  formatted text, and WidgetKit traps on it when the extension launches.
- Never write `<=` or `>=` between two `Date`s in the phone's Swift: write `!(a < b)`. macOS 27.2 beta lacks those
  two operators, so a test suite that uses one dies at launch (`Symbol not found … Date.<=`, or signal 11) and the
  gate goes red. That is this rule broken, never an OS bug to push past. Drop the rule once
  `print(Date() <= Date())` runs as a Swift program on the Mac.
