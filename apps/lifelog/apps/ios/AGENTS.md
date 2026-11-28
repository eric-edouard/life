# apps/ios

`Lifelog/` is the SwiftUI app: one `@Observable` store per feature, the long-lived ones built at launch. `Kit/` is the
Swift package with everything that doesn't need UIKit, so it builds and tests on the Mac in seconds. `Watch/` and
`Widgets/` are the glances; `Shared/` holds code and copy that the app and its extensions share. `project.yml`
generates the gitignored `.xcodeproj`.
The app is a bare shell until the thread (P2): `RootView` is a `NavigationStack` whose root is the thread (field at the bottom, riding the keyboard; the edge round the whole screen). A person's `life:` link pushes their profile (system Back and edge swipe; one level deep), any other `life:` ref and the Pendant, Settings and pairing are the one sheet at a time (`RootView.Sheet`), a tapped notification or `lifelog://open?ref=` lands back on the thread. `life-open:` links are handled once, at `RootView` (a face in a pictures block opens the same way); the field is the stack's bottom inset, so it stays on a pushed profile and asks with that screen's refs; an ask he is sent to is brought to the thread's bottom, unfolded. A phrase's full screen and a non-person, non-ask `life:` page are the only screens outside `RootView.Sheet`. `LinkAction` (Kit) decides what a link does: one pairing at a time. The old screens and the Debug fixture are cut. Sheets are centred, the system's default: no `presentationPlacement` (`.leading` is missing on iOS 27.0 and crashes). Actions go through `LifeStore`'s `ActionState`. Manrope is the one font (`DesignSystem/Typography.swift`). `Shared/Palette.swift` is the phone's one copy of Life's brand (`assets/brand/tokens.css`), checked by `scripts/brand.test.ts`: no colour literal elsewhere, except a draft's chat strip, drawn in its platform's own colours (`ChatLook` in `DesignSystem/DraftBlock.swift`). `docs/architecture.md` names every store and owner and says where a new screen or derived value goes.

Every free-text field is a `DictationField` (`DesignSystem/DictationField.swift`) but a network sign-in's `CredentialField`, never dictated: typing, two glass discs, the microphone and, with a single submit, Send. A tap on the microphone talks until the next tap, a hold talks while held, a hold slid up sends (Kit's `DictationPress`); each run is one `DictationCapture`, driven by Kit's `Dictation`; no screen draws a `TextField` of its own. The spec's components live in `Lifelog/DesignSystem/Pieces.swift` and screens draw none of their own; one radius per job (`Metrics.Radius`). `scripts/design-system.test.ts` counts what screens still draw by hand; its caps only go down.

The design data (`apps/lifelog/fixtures/design/`, one JSON file per connector read, wire shape) is test data for Kit's models, read by `DesignReplies`.

## How to

- **Regenerate the project** after editing `project.yml`: `bun run ios:project`.
- **Test Kit alone**, from Life's root: `swift test --package-path apps/lifelog/apps/ios/Kit --scratch-path .build/kit`.
- **Run in the simulator.** Debug builds take `-fixtureLibrary` (a demo library with audio), `-fakePendant <scenario>` (see `FakeScenario.swift`), `-offline` and `-serverFlaky`; launch with `xcrun simctl launch <udid> com.ericedouard.lifelog <args>`.
  The device token goes in through `SIMCTL_CHILD_LIFELOG_DEVICE_TOKEN` with `SIMCTL_CHILD_LIFELOG_SERVER_URL`, read from the file without printing it.
- **Run the end-to-end flows** with `bun run e2e:phone [TestClass …]` (failures only); `--watch O7` runs one flow on a visible simulator, slowed, and records it. The flows
  are in `LifelogE2E/`, each with its scenario in `LifelogE2E/scenarios/`; the app's fake Life is `Lifelog/E2E/` (Debug
  only). Screens are found by the ids in `Lifelog/AccessibilityIDs.swift`: keep them when a screen changes, and never put
  an id on a container (it overrides its children's).
- **A UI change reruns its parity rows** (`bun run parity <row …>`, `scripts/parity.ts`): each prototype state beside the
  app in a flow test over the prototype's made-up data, published as his board (claude.ai artifact `Sj1P6mVpviohcbWEjREvfZ`;
  his "not right" notes are its `verdicts` collection). It is done only when its rows are green.
- **Check Release before an install.** The gate builds Debug only and `install:phone` builds Release, so anything
  DEBUG-only that leaks out of `#if DEBUG` breaks the install:
  `xcodebuild -project apps/lifelog/apps/ios/Lifelog.xcodeproj -scheme Lifelog -configuration Release -destination 'generic/platform=iOS Simulator' build`.
- **Install on the phone** with `bun run install:phone -- --no-watch`; include the Watch only when the Watch app
  changed. If the Watch install fails with "Connection invalid", the owner restarts the Watch on its charger and you
  retry once.
- **Write SwiftUI** after reading Xcode's own `swiftui-whats-new-27` and `swiftui-specialist` skills, in
  `/Applications/Xcode.app/Contents/PlugIns/IDEIntelligenceChat.framework/Versions/A/Resources/`.

## Worth knowing

- Every bundle id, the app group and the background task derive from `LIFELOG_BUNDLE_ID` in `project.yml` (beside
  `DEVELOPMENT_TEAM`); code reads them from the bundle's Info.plist (`AppGroup`, `SyncStore.backgroundTaskID`, `Keychain`). The Keychain
  service is `<app's bundle id>.server`, named from `LifelogBundleID` in every target that reads it (`Keychain`), which
  for the owner's build is the name it always had, so his stored token stays readable; changing the bundle id starts
  unpaired.
- The app is the Pendant's capture and upload, and Life's connector client. No screen
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
- The phone reaches its Mac over iroh: `IrohLib` in the app target only, requests reach the Mac through `MacRoute` and no
  other way, and a refused proof fails pairing with no fallback. The how is `MacLink.swift`'s header.
- `SyncStore` is the one driver: uploads, the outbox, the feed and the status. Debug builds pair from
  `LIFELOG_DEVICE_TOKEN` and `LIFELOG_SERVER_URL` in the environment (`DeviceToken.importFromEnvironment`), the one
  debug path.
- The app talks to Life only through its connector, in Kit's `LifeConnector`: its OAuth (pairing by the code in the
  `life` and `code` of the pairing link), one `MCPClient`, and `LifeAPI`, the only place tool names appear. Every read
  is a `ReadState` (`LifeStore` shows its `shown`), never a bare value, and runs one at a time per kind within a pairing with one more pass (`ReadFlights`), so an older read never lands last; a pass queued under an earlier pairing never begins, and one begun under it applies nothing (`PairingGeneration`). Out of reach (no network path, or the newest read found no way to Life: `LifeConnection`, `LifeStore.whyOutOfReach`) the app is read-only: the screen says why above what it shows, every action control is off (`offWhileOutOfReach`), and `LifeStore` refuses a screen's tap before it holds or shows anything; a notification's answer, or one held before, is still tried. The one `NWPathMonitor` is `NetworkPath`, which the pendant's sync reads too; back on the network, every read screen reads again. What a page shows stands against the Mac as one mark, the toast at the top of its content column (Kit's `SyncMark`, the design `sync-status-2026-11-22.md`): no internet, Mac not answering, reconnecting, Life's reason, out of date (10 minutes), updating (after a second), and on home only the agents' trouble from `read_registered_agents` (`RegisteredAgents.trouble`). In front, the main reads are read again every minute (`SyncMark.readEvery`). The fixtures in `fixtures/wire/life/` are written
  by Life's server tests (`WRITE_WIRE=1 bun test apps/server/src/host/http/mcp-phone-reads.test.ts`, and the answer and
  agent tests through `wire-fixture.ts`).
- Every action on Life (an answer, a start, stop, resume, model, his edit of a matter) runs in `LifeActions` and shows
  as an `ActionState` in `LifeStore.actions` (`ActionBook`, one pairing's: a new pairing empties it, and a late event of
  an earlier one's action applies nothing; an answer's repeats go only while its pairing holds): running with the steps
  as they stream, succeeded with proof, failed with its step, reason and whether a retry is allowed. Only the server ends one; past its `limitSeconds` it is late, never
  failed. An answer carries one `life/answerKey` (made at his tap, kept while the same tap repeats after a dropped
  connection, new after any result Life gave or for another answer to the same card), so Life sends nothing twice: a repeat of an answered card's same answer gets its first result under any key. Every action ends with one `life.action` event (steps with their seconds, limit, late, outcome): read it with `bun run events life.action` to see where a slow one spent its time. A
  card's buttons are its options' `label`s, and what an option `takes` (a person, a name, a note) is what the tap asks
  for (`Check.answer`; a `takes` this build doesn't know opens "Tell the agent…", on every agent card, never a dead
  button); a card's `context` is Markdown behind one link worded by the code (`Check.contextLinkTitle`; none without a context), which opens `ContextSheet` (`DesignSystem/ContextSheet.swift`: the system sheet, fit, medium and large; its blocks read in Kit by `ContextMarkdown`, the one reader of Markdown; a `life:` link's page, `fetch`, pushed inside with Back; a web link in Safari's view); a card's `needs` are drawn by `NeedsBlock` from `Check.shownNeedRows` (decided in Kit; a kind it doesn't know is
  its `line`; a link shows its full host and opens only on his tap), a QR with its text as the card's hero (`PayCodeBlock`, `Check.payCode`, drawn by Core Image), and a transfer's account `scheme` makes the filled answer his bank app (`Check.transfers`, `BankApp`: his pick per kind on Settings > Apps, kept on the phone; a QR is saved to Photos first, add-only), every option quiet beside it, and Life's `doneSeen` is one line above the
  answers when seen or not found (`DoneSeenLine`); while Life is looking, one busy answer stands in their place; the phone decides nothing Life decides (what is open, a goal's steps): a matter's edits and Mark
  as done go by its id. A card's push is rewritten with the card's words by the notification extension (`NotificationService/`, `CardNotification`), which reads Life at the pairing's origin and no other and stamps the card with that origin (`CardNotification.read`); a draft's card takes the send category, so Send shows on the Watch too (`CardNotification.sendCategory`; not while his Face ID setting is on, `AppGroup.asksFaceIDToSend`, which only the phone can ask); expanded, it shows the draft as its chat strip (`DraftBlock`), the card's one-tap answers and Send (`NotificationContent/`, `CardNotification.isAnswerAllowed`), which the app answers in the background through `LifeStore.answer` (`IncidentNotifier`), on the card as the Life paired now has it (`LifeStore.notifiedCard`, `CardNotification.card`: the kept card only under the pairing it was read from, else Life's read of its `pushId`), never the kept card as it is; every answer goes to the Life it was decided for (`PairedLife`, captured at the tap, a row's when its answer was sent): each try and retry at that origin with that Life's bearer (`MCPClient.call(at:)`), and none once another pairing began; a tapped push routes by `pushId` with the card the extension kept (`NotificationRoute.card`) and opens that card at once, from the cached inbox or the kept card, while one whole read checks it (`PushedCard`, the pager's spinner); with neither, the card-shaped skeleton waits for Life's read of its `pushId`, beside the whole read; a push while
  the app is in front reads the thread's asks again (`LifeStore.refreshItems`). The asks are one read, `read_thread` (`ThreadRead`, only its `ask` items; entries are `LifeThread`'s): Life gives each ask its state, the phone adds only `queued`, an answer taken while Life is out of reach (`QueuedAnswers`, kept in the read cache, sent in order with its own tap key once Life answers again, never Undo). A fix card's sign-in option (`signsIn`) is never an answer: `LifeStore.answer` opens `NetworkSignInSheet` (Kit's `NetworkSignIn` drives `sign_in_to_network` step by step; its web step keeps no stored data). Later is `answer_check` with `options:["later"]`, Undo `undo:true`; items and pictures blocks draw live rows from `Lifelog/Items/`, a `life:` link opens a profile (`Lifelog/Profile/`, one level deep) or unfolds its ask. The heartbeat carries `focus` and `onCall`, beside `phone` (Focus asks one permission).
- A server enum decodes unknown values as `unknown` (`UnknownTolerant`) and belongs in the mirror list of
  `ContractTests.swift` (lifelog's against its `openapi.json` in `mirroredEnumsMatchTheSpec`, Life's against `apps/server/src` in `lifesEnumsAreTheServers`), which also checks
  every path the client calls.
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
