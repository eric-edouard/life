# apps/ios

`Life/` is the SwiftUI app: one `@Observable` store per feature, the long-lived ones built at launch. `Kit/` is the
Swift package with everything that doesn't need UIKit, so it builds and tests on the Mac in seconds. `Watch/` and
`Widgets/` are the glances; `Shared/` holds code and copy that the app and its extensions share. `project.yml`
generates the gitignored `.xcodeproj`. `docs/voice/architecture.md` names every store and owner and says where a new screen or derived value goes.

## Invariants

- **ACK deletes pages from the Pendant's flash.** Only ACK the contiguous prefix of pages that are durable (fsync'd
  pack plus committed receipt) or recorded as gaps; `PageSink.ackableIndex` is the only authority (on Android, the
  Omi's ADVANCE goes to `DrainedRun.advanceTo`, past what `OmiDrain` fsync'd). A page ACKed before it is safe is gone
  for good.
- Never send the Pendant's factory-reset, unpair or encryption-key commands. The server's invariants
  (`apps/voice/AGENTS.md`) hold here too.

## How to

- **Regenerate the project** after editing `project.yml`: `bun run ios:project`.
- **Test Kit alone**, from the repo root: `swift test --package-path apps/ios/Kit --scratch-path .build/kit`.
- **Run in the simulator.** Debug builds take `-fixtureLibrary` (a demo library with audio), `-fakePendant <scenario>`
  (see `FakeScenario.swift`) and `-offline`; launch with `xcrun simctl launch <udid> com.ericedouard.lifelog <args>`.
  The device token goes in through `SIMCTL_CHILD_LIFELOG_DEVICE_TOKEN` with `SIMCTL_CHILD_LIFELOG_SERVER_URL`, read from the file without printing it.
- **Check Release before an install.** The gate builds Debug only and `install:phone` builds Release, so anything
  DEBUG-only that leaks out of `#if DEBUG` breaks the install:
  `xcodebuild -project Life.xcodeproj -scheme Life -configuration Release -destination 'generic/platform=iOS Simulator' build`.
- **Install on the phone** with `bun run install:phone -- --no-watch`; include the Watch only when the Watch app
  changed. If the Watch install fails with "Connection invalid", the owner restarts the Watch on its charger and you
  retry once.
- **Write SwiftUI** after reading Xcode's own `swiftui-whats-new-27` and `swiftui-specialist` skills, in
  `/Applications/Xcode.app/Contents/PlugIns/IDEIntelligenceChat.framework/Versions/A/Resources/`.

## Worth knowing

- Every bundle id, the app group and the background task derive from `LIFE_BUNDLE_ID` in `project.yml` (beside
  `DEVELOPMENT_TEAM`); code reads them from the bundle's Info.plist (`AppGroup`, `SyncStore.backgroundTaskID`). The Keychain
  service is `<bundle id>.server` (`DeviceToken`), which for the owner's build is the name it always had, so his
  stored token stays readable; changing the bundle id starts unpaired.
- Screens read the library's cache of the server's feed and the outbox, never the server first (`docs/voice/architecture.md`,
  "Local first"). `bun run check:offline` checks it.
- The owner's edits are `OwnerIntent`s sent with `SyncStore.perform`: queued in the outbox, shown at once as waiting.
- Pairing goes one way: a `lifelog://pair` link (Camera or pasted) sets `SyncStore.offeredPairing`, `RootView` asks the
  owner to confirm naming the server, and only then `SyncStore.pair` stores it. A link never repoints the app alone.
- `SyncStore` is the one driver: uploads, the outbox, the feed and the status. Debug builds pair from
  `LIFELOG_DEVICE_TOKEN` and `LIFELOG_SERVER_URL` in the environment (`DeviceToken.importFromEnvironment`), the one
  debug path.
- A server enum decodes unknown values as `unknown` (`UnknownTolerant`) and belongs in the mirror list of
  `ContractTests.swift`, which also checks every path the client calls.
- The toolbar API is `toolbarMinimizationBehavior(_:for:)`; the WWDC docs' `toolbarMinimizeBehavior` doesn't compile.
- An Omi drains through the same `DrainCoordinator` as the Limitless Pendant, by its `DeviceCodec`. **Any work on the
  Omi starts by reading the latest Omi firmware release notes for the ring-custody fix** (`docs/voice/research/omi.md`,
  first section). Once it ships, set `OmiFirmware.custodyFixedIn`, which turns the in-app warning into an update
  prompt, and say so to the owner in your report. Pairing an Omi moves `CaptureStore.deviceID` to the Omi's slot, so
  Limitless pages not uploaded yet stop uploading: pair an Omi only on a phone without a Limitless Pendant.
- A widget's `configurationDisplayName` and `description` take a literal or a `String`: an interpolated literal is
  formatted text, and WidgetKit traps on it when the extension launches.
