# apps/ios

`Lifelog/` is the SwiftUI app: one `@Observable` store per feature, the long-lived ones built at launch. `Kit/` is the
Swift package with everything that doesn't need UIKit, so it builds and tests on the Mac in seconds. `Watch/` and
`Widgets/` are the glances; `Shared/` holds code and copy that the app and its extensions share. `project.yml`
generates the gitignored `.xcodeproj`.
The app is a minimal shell (the Pendant tab alone) until Life's screens land; the old Library, Conversation, People, Presses and
Spending screens are cut. `Shared/Palette.swift` is the phone's one copy of Life's brand (`assets/brand/tokens.css`), checked by
`scripts/brand.test.ts`: no colour literal elsewhere, except the hardware drawings (`HALLens.swift`, `LightGuide.swift`), which paint the pendant itself. `docs/architecture.md` names every store and owner and says where a new screen or derived value goes.

## How to

- **Regenerate the project** after editing `project.yml`: `bun run ios:project`.
- **Test Kit alone**, from Life's root: `swift test --package-path apps/lifelog/apps/ios/Kit --scratch-path .build/kit`.
- **Run in the simulator.** Debug builds take `-fixtureLibrary` (a demo library with audio), `-fakePendant <scenario>`
  (see `FakeScenario.swift`) and `-offline`; launch with `xcrun simctl launch <udid> com.ericedouard.lifelog <args>`.
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

- Every bundle id, the app group and the background task derive from `LIFELOG_BUNDLE_ID` in `project.yml` (beside
  `DEVELOPMENT_TEAM`); code reads them from the bundle's Info.plist (`AppGroup`, `SyncStore.backgroundTaskID`). The Keychain
  service is `<bundle id>.server` (`DeviceToken`), which for the owner's build is the name it always had, so his
  stored token stays readable; changing the bundle id starts unpaired.
- Screens read the library's cache of the server's feed and the outbox, never the server first (`docs/architecture.md`,
  "Local first").
- A source's `sentThrough` (on the server) means everything before it was sent or decided. A new install's uploader
  starts there (`Uploader.restore`) and never reads derived files below it: `derived/` and `upload/` are kept out of
  backups, `timeline.sqlite` is not, so a migrated phone has an index of sidecars it lacks. A lost sidecar is
  unanalyzed audio, never skipped (unlabelled audio counts as possible speech); from the cursor on it is rebuilt and
  uploads wait for it (`TimelineScanner.scan`).
- The owner's edits are `OwnerIntent`s sent with `SyncStore.perform`: queued in the outbox, shown at once as waiting.
- Pairing goes one way: a `lifelog://pair` link (Camera or pasted) is opened by `RootView`, which asks the
  owner to confirm naming each server, and only then `SyncStore.pair` or `LifeStore.pair` stores it. A link never repoints the app alone.
- `SyncStore` is the one driver: uploads, the outbox, the feed and the status. Debug builds pair from
  `LIFELOG_DEVICE_TOKEN` and `LIFELOG_SERVER_URL` in the environment (`DeviceToken.importFromEnvironment`), the one
  debug path.
- The app talks to Life only through its connector, in Kit's `LifeConnector`: its OAuth (pairing by the code in the
  `life` and `code` of the pairing link), one `MCPClient`, and `LifeAPI`, the only place tool names appear. Every read
  is a `ReadState` (`LifeStore` shows its `shown`), never a bare value. The fixtures in `fixtures/wire/life/` are written
  by Life's server tests (`WRITE_WIRE=1 bun test apps/server/src/host/http/mcp-phone-reads.test.ts`, and the answer and
  agent tests through `wire-fixture.ts`).
- Every action on Life (an answer, a start, stop, resume, model, his edit of a matter) runs in `LifeActions` and shows
  as an `ActionState` in `LifeStore.actions`: running with the steps as they stream, succeeded with proof, failed with
  its step, reason and whether a retry is allowed. Only the server ends one; past its `limitSeconds` it is late, never
  failed. An answer carries one `life/answerKey` (made at his tap, kept while the same tap repeats after a dropped
  connection, new after any result Life gave), so Life sends nothing twice. A tapped push routes by `pushId`
  (`NotificationRoute.card`) and the badge is the inbox total.
- A server enum decodes unknown values as `unknown` (`UnknownTolerant`) and belongs in the mirror list of
  `ContractTests.swift`, which also checks every path the client calls.
- The toolbar API is `toolbarMinimizationBehavior(_:for:)`; the WWDC docs' `toolbarMinimizeBehavior` doesn't compile.
- An Omi drains through the same `DrainCoordinator` as the Limitless Pendant, by its `DeviceCodec`. **Any work on the
  Omi starts by reading the latest Omi firmware release notes for the ring-custody fix** (`docs/research/omi.md`,
  first section). Once it ships, set `OmiFirmware.custodyFixedIn`, which turns the in-app warning into an update
  prompt, and say so to the owner in your report. Pairing an Omi moves `CaptureStore.deviceID` to the Omi's slot, so
  Limitless pages not uploaded yet stop uploading: pair an Omi only on a phone without a Limitless Pendant.
- A widget's `configurationDisplayName` and `description` take a literal or a `String`: an interpolated literal is
  formatted text, and WidgetKit traps on it when the extension launches.
- Never write `<=` or `>=` between two `Date`s in the phone's Swift: write `!(a < b)`. macOS 27.2 beta lacks those
  two operators, so a test suite that uses one dies at launch (`Symbol not found … Date.<=`, or signal 11) and the
  gate goes red. That is this rule broken, never an OS bug to push past. Drop the rule once
  `print(Date() <= Date())` runs as a Swift program on the Mac.
