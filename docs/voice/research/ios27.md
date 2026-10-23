# iOS 27 / Xcode 27 / Swift 6.4 conventions for Life

Researched 2026-10-07 on Xcode 27.0 (27A266a), Swift 6.4 (swiftlang-6.4.0.34.1), iPhoneOS27.0.sdk, macOS 27.2.

Legend:
- **[V-local]**: verified on this machine, either by typechecking against the iOS 27 SDK, by running a probe, or by reading SDK headers.
- **[V](link)**: verified against the linked source.
- **[U]**: unverified.

Every SwiftUI, concurrency, background, ASK, Speech, FoundationModels, CoreLocation and MediaPlayer snippet below typechecks together against the iOS 27 SDK, using `-swift-version 6 -default-isolation MainActor -enable-upcoming-feature NonisolatedNonsendingByDefault` **[V-local]**.

## 0. Xcode 27 built-in agent skills (on disk)

The skills ship as `.idechatprompttemplate` files (frontmatter plus a body), with `*-ref-*.md.packaged` reference files beside them. All of them live in:
`/Applications/Xcode.app/Contents/PlugIns/IDEIntelligenceChat.framework/Versions/A/Resources/`

| Skill | What it covers |
|---|---|
| `swiftui-whats-new-27` | 7 refs: `state-macro`, `content-builder`, `reorderable`, `swipe-actions`, `toolbar`, `item-binding`, `async-image` |
| `swiftui-specialist` | 9 refs: `dataflow`, `environment`, `foreach`, `structure`, `modifiers`, `animations`, `localization`, `soft-deprecation`, `soft-deprecated-apis` |
| Others | `app-intents-whats-new-27`, `app-intents-specialist`, `uikit-app-modernization`, `audit-xcode-security-settings`, `adopt-c-bounds-safety`, `building-document-based-swiftui-applications` |
| `AdditionalDocumentation/*.md` | Older Xcode 26 era docs: Liquid Glass, FoundationModels, Swift-Concurrency-Updates, Styled Text Editing, AttributedString updates |

A separate `.../IDEXCStringsSupport.framework/.../Skills/translation{,-coordinator}/SKILL.md.packaged` exists. Nothing relevant turned up under `~/Library/Developer`.

## 1. SwiftUI / Observation (iOS 27)

**`@State` is now a macro and initializes lazily** **[V](https://developer.apple.com/videos/play/wwdc2026/269/)** **[V](https://nilcoalescing.com/blog/InitializingObservableClassesWithTheStateMacroInXcode27)**
- `@State private var model = Model()` runs `Model.init` once per view identity, not once per parent re-render.
- The behavior back-deploys to iOS 17 when you build with Xcode 27.
- Gotchas from the skill's `state-macro` ref:
  - Do not give an initial value and then also assign the property in `init`. Drop the initial value and assign only in `init`.
  - Composing other property wrappers with `@State` gives "invalid redeclaration".
  - Memberwise `init` is no longer synthesized when every member is private.

**`@ViewBuilder` became `@ContentBuilder`** **[V]** (skill `content-builder` ref)
- Use the closure form `.overlay { Color.x.opacity(…) }`, because the argument form is now ambiguous.
- Don't spell out `TupleView` in generic constraints.

**Models** **[V]** (skill `dataflow` ref)
- Use `@Observable` and never `ObservableObject`.
- Add `@MainActor` only if the project doesn't default to MainActor isolation.
- Make stored property types `Equatable`, so that setting a property to the same value doesn't invalidate views.
- Mark `@State` as `private`.

**Navigation, tabs, toolbars, Liquid Glass, scrolling and text** **[V-local]**

```swift
@main struct LifeApp: App {
  @State private var library = Library()                    // @Observable final class
  var body: some Scene { WindowGroup { RootView().environment(library) } }
}
// Read with: @Environment(Library.self) private var library; then `@Bindable var library = library` in body
TabView(selection: $library.selectedTab) {
  Tab("Timeline", systemImage: "waveform", value: AppTab.timeline) { TimelineView() }
  Tab(value: AppTab.search, role: .search) { NavigationStack { SearchView().searchable(text: $q) } }
  Tab("Record", systemImage: "mic", value: AppTab.record, role: .prominent) { … }  // NEW 27: trailing, separated
}
.tabBarMinimizeBehavior(.onScrollDown)
.tabViewBottomAccessory { SyncStatusView() }               // good slot for "Syncing pendant…"

NavigationStack(path: $path) {                             // path: [Route], Route: Hashable enum
  ScrollView { LazyVStack { ForEach(items) { r in
      NavigationLink(value: Route.recording(r.id)) { Row(r) }
        .matchedTransitionSource(id: r.id, in: ns)
        .swipeActions { Button("Delete", systemImage: "trash", role: .destructive) { … } } } } }
  .swipeActionsContainer()                                 // NEW 27: swipeActions outside List
  .toolbar {
    ToolbarItem(placement: .topBarPinnedTrailing) { … }    // NEW 27: never overflows
    ToolbarOverflowMenu { Button("Export") { … } }         // NEW 27
  }
  .toolbarMinimizationBehavior(.onScrollDown, for: .navigationBar)  // NEW 27, see note below
  .navigationDestination(for: Route.self) { route in
    TranscriptView().navigationTransition(.zoom(sourceID: id, in: ns)) }  // NEW 27: also .crossFade
}
// Liquid Glass
GlassEffectContainer(spacing: 12) { HStack {
  Button("Play", systemImage: "play.fill") { }.buttonStyle(.glassProminent)
  Button("Skip", systemImage: "goforward.15") { }.buttonStyle(.glass)
  Image(systemName: "waveform").padding().glassEffect(.regular.interactive(), in: .capsule) } }
// Transcript reader
@State private var position = ScrollPosition(idType: Segment.ID.self)
ScrollView { LazyVStack { ForEach(segments) { Text($0.text) } }.scrollTargetLayout() }
  .scrollPosition($position).defaultScrollAnchor(.bottom).textSelection(.enabled)
  .onScrollPhaseChange { old, new in … }
position.scrollTo(id: segmentID)                           // jump to the playing segment
TextEditor(text: $attributed, selection: $sel)             // AttributedString + AttributedTextSelection
```

- **Toolbar minimize API was renamed in the shipping SDK.** The skill's `toolbar` ref and the WWDC26 session both say `toolbarMinimizeBehavior(_:for:)`, but that name **fails to compile**. iPhoneOS27.0.sdk ships `toolbarMinimizationBehavior(_:for:)` (with `.automatic`, `.onScrollDown` and `.onScrollUp`), plus `toolbarMinimizationSafeAreaAdjustment` and `toolbarMinimizationRestoration` **[V-local]**.
- **Other new iOS 27 APIs** **[V]** (skills):
  - `.alert(_:item:)` and `.confirmationDialog(_:item:)` take an optional binding.
  - `.reorderable()` and `.reorderContainer(for:)` add drag-to-reorder to any container.
  - `.visibilityPriority(.high)` sets toolbar overflow priority.
  - `.toolbarVisibility(.hidden, for: .statusBar)` replaces `statusBarHidden`.
  - `AsyncImage(request:)` now uses HTTP caching.
- **Soft-deprecated** **[V]** (skill `soft-deprecated-apis`, generated from iOS 27):
  - `NavigationView` and `NavigationLink(destination:)`
  - `.tabItem`; use `Tab` instead
  - `foregroundColor`; use `foregroundStyle`
  - `cornerRadius`; use `clipShape`
  - `navigationBarTitle`
  - the old `onChange` overload
  - `statusBarHidden`
  - `Alert`/`ActionSheet` types
  - `.navigationBarLeading`/`.navigationBarTrailing`; use `topBarLeading`/`topBarTrailing`
- **Liquid Glass changes in iOS 27** are mostly automatic, such as glass tint adoption, and need no code **[V](https://swiftwithmajid.com/2026/06/08/what-is-new-in-swiftui-after-wwdc26/)**.

## 2. Swift 6.4 concurrency

The Xcode 27 iOS App template sets the following **[V-local]** (`Templates/.../Base/*.xctemplate`):
- `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`
- `SWIFT_APPROACHABLE_CONCURRENCY = YES`
- `SWIFT_UPCOMING_FEATURE_MEMBER_IMPORT_VISIBILITY = YES`
- `SWIFT_VERSION = 5.0`. The template still uses 5.0, so set it to 6 yourself.

`SWIFT_APPROACHABLE_CONCURRENCY` turns on these five features **[V-local]** (Swift.xcspec):
- `NonisolatedNonsendingByDefault`
- `InferIsolatedConformances`
- `InferSendableFromCaptures`
- `GlobalActorIsolatedTypesUsability`
- `DisableOutwardActorInference`

Donny Wals recommends MainActor-by-default for app targets. For packages it depends on the package: networking and decoding packages should stay nonisolated **[V](https://www.donnywals.com/should-you-opt-in-to-swift-6-2s-main-actor-isolation/)**.

```yaml
# XcodeGen project.yml (settings.base)
SWIFT_VERSION: "6"                       # Swift 6 mode implies strict concurrency = complete
SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor
SWIFT_APPROACHABLE_CONCURRENCY: YES
SWIFT_UPCOMING_FEATURE_MEMBER_IMPORT_VISIBILITY: YES
SWIFT_TREAT_WARNINGS_AS_ERRORS: YES
```

```swift
// swift-tools-version: 6.4          // needed for .iOS(.v27)/.macOS(.v27); 6.2 is enough for the settings
let settings: [SwiftSetting] = [
  .defaultIsolation(MainActor.self),               // omit for nonisolated packages (BLE protocol, codec)
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
  .enableUpcomingFeature("InferIsolatedConformances"),
  .treatAllWarnings(as: .error),
]
// Package(..., platforms: [.iOS(.v27)], targets: [.target(name:, swiftSettings: settings)], swiftLanguageModes: [.v6])
```
The package above builds and passes `swift test` **[V-local]**.

Code shapes **[V-local]**:
- `@concurrent func decode(_:) async` moves work off the caller's actor.
- `nonisolated(nonsending) func f() async` runs on the caller's actor.
- `extension M: @MainActor P` declares an isolated conformance.

New in Swift 6.4 **[V](https://developer.apple.com/videos/play/wwdc2026/262/)**:
- `@available(anyAppleOS 27, *)`
- `withTaskCancellationShield {}`
- warnings when a task silently drops an error
- `async` in `defer`
- `@diagnose(...)` attribute
- module selectors (`Mod::Type`)
- Foundation `ProgressManager`

## 3. CoreBluetooth in the background (the most important section for this app)

**Setup**
- Add `UIBackgroundModes: [bluetooth-central]`.
- Create the central with `CBCentralManager(delegate:queue:options: [CBCentralManagerOptionRestoreIdentifierKey: "pendant"])`.
- In `centralManager(_:willRestoreState:)`, read `CBCentralManagerRestoredStatePeripheralsKey` and set the delegates again.
- All of this is **[V-local]**.

**Pending connects**
- `connect(_:)` attempts **never time out** **[V-local]** (CBCentralManager.h). Keep one pending connect open at all times. That is how you get relaunched when the pendant comes back into range.
- `CBConnectPeripheralOptionEnableAutoReconnect` (iOS 17+) makes the system reconnect after a link drop **[V-local]**.
- In the background, scans coalesce duplicate advertisements, so connect directly instead of relying on scanning **[V](https://origin-devforums.apple.com/forums/thread/840468)**.

**When iOS relaunches the app** (TN3115, rev. 2025-09-15) **[V](https://developer.apple.com/documentation/technotes/tn3115-bluetooth-state-restoration-app-relaunch-rules)**

| Event | Relaunched? |
|---|---|
| App removed from memory or crashed | Yes |
| Bluetooth toggled in Settings | No |
| Reboot | Yes, but only after the **first unlock** |
| Force-quit by the user; Control Center BT toggle; Airplane Mode | **"Starting in iOS 26 … only apps that use AccessorySetupKit to set up Bluetooth accessories will be relaunched."** |

- An Apple DTS engineer reads TN3115 note 5 to mean that **ASK apps are relaunched even after a force-quit**, and says engineering confirmed this is intended **[V](https://origin-devforums.apple.com/forums/thread/840468)**. Without ASK, a force-quit app is not relaunched.
- The app is relaunched only if it was waiting on a Bluetooth event: a pending connect, a notify subscription, or a scan.

**AccessorySetupKit.** Strongly recommended, and effectively required for reliable relaunch on iOS 26 and later.
- Info.plist needs `NSAccessorySetupKitSupports: [Bluetooth]` and `NSAccessorySetupBluetoothServices: [<service UUID>]`.
- After setup, use `ASAccessory.bluetoothIdentifier` with `retrievePeripherals(withIdentifiers:)`.
- iOS 27 adds only Channel Sounding to CoreBluetooth **[V-local]**.
- Whether ASK works for a third-party app pairing a Limitless pendant (it matches only on advertised service UUID, name or manufacturer data) has to be tested on a device **[U]**. The same goes for whether it can coexist with the official Limitless app.

```swift
let d = ASDiscoveryDescriptor(); d.bluetoothServiceUUID = CBUUID(string: "<pendant svc>")
session.activate(on: .main) { e in if e.eventType == .accessoryAdded { save(e.accessory?.bluetoothIdentifier) } }
session.showPicker(for: [ASPickerDisplayItem(name: "Pendant", productImage: img, descriptor: d)]) { _ in }
```

**Locked device and data protection**
- After a reboot the app wakes only after the first unlock **[V]** (TN3115 note 4).
- Write audio and DB files with `.completeUntilFirstUserAuthentication`, the default class. Never use `.complete`, because background writes fail while the device is locked **[U: Apple Platform Security guide]**.

## 4. Background work

**`BGContinuedProcessingTask`** (iOS 26) **[V-local]** (headers)
- For **user-initiated** work only. The system shows a Live-Activity-style progress UI.
- You must report progress through `task.progress`. A task that looks stalled is expired, and the user can cancel it.
- Identifier must use the wildcard form `<bundleID>.<ctx>.*`.
- `strategy` is `.queue` by default or `.fail`. Queued requests are dropped if the user swipes the app away.
- `requiredResources = .gpu` needs an entitlement.
- iOS 27 adds `try await BGTaskScheduler.shared.submitTaskRequest(req)`, an async form that replaces the deprecated synchronous `submit`.
- There is no fixed time cap; it runs as long as progress keeps moving **[U]**.

```swift
BGTaskScheduler.shared.register(forTaskWithIdentifier: "com.x.Life.transcribe.*", using: nil) { t in
  guard let t = t as? BGContinuedProcessingTask else { return }
  t.expirationHandler = { cancel() }; t.progress.totalUnitCount = n
  t.updateTitle("Transcribing", subtitle: "3 of 10"); …; t.setTaskCompleted(success: true) }
let r = BGContinuedProcessingTaskRequest(identifier: "com.x.Life.transcribe.\(id)", title: "Transcribing", subtitle: "Starting")
try await BGTaskScheduler.shared.submitTaskRequest(r)
```

**`BGProcessingTaskRequest`**
- Supports `requiresExternalPower` and `requiresNetworkConnectivity`, and runs at the system's discretion **[V-local]**.
- Setting `requiresExternalPower` turns off the CPU monitor, so this is the right place for overnight batch transcription and summarization.
- Runtime is typically minutes **[U]**.
- **Uploads:** use `URLSessionConfiguration.background(withIdentifier:)` with `uploadTask(with:fromFile:)` (from a file only), and handle `application(_:handleEventsForBackgroundURLSession:)` or SwiftUI `.backgroundTask(.urlSession(id))` **[U: unchanged API, not re-checked]**.

## 5. SpeechAnalyzer / SpeechTranscriber

The locale lists below come from a probe on macOS 27.2 **[V-local]**. iOS should match **[U]**.

| Question | Result |
|---|---|
| `SpeechTranscriber.supportedLocales` | 45 locales: en, fr (FR, CA, BE, CH), de, es, it, ja, ko, pt, zh/yue, and many Indian languages |
| Thai with `SpeechTranscriber` | **Not supported** |
| Thai with `DictationTranscriber` | Supported: 54 locales including `th_TH`. This is the older dictation model, with presets `.longDictation` and `.timeIndexedLongDictation` |
| Code-switching | Only `mul_IN` (Indian multilingual). Every other transcriber takes one locale. Thai and English mixed speech would need language ID plus a re-run **[U]** |

Assets: `AssetInventory.assetInstallationRequest(supporting: [transcriber])?.downloadAndInstall()`, plus `AssetInventory.reserve(locale:)` up to `maximumReservedLocales` **[V-local]**.

New in iOS 27 **[V-local]**:
- `AssetInputSequenceProvider.provider(from: AVAsset, compatibleWith:)`
- `AnalyzerInputConverter`
- `SpeechAnalyzer.Options(priority:modelRetention:ignoresResourceLimits:)`, useful for background batch runs

Shape: `SpeechTranscriber(locale:, preset: .timeIndexedTranscriptionWithAlternatives)`, then `SpeechAnalyzer(modules:)`, then `analyzeSequence(from: AVAudioFile)`, then `finalizeAndFinish(through:)`, while you iterate `transcriber.results`.

## 6. Foundation Models (iOS 27)

| Model | Context window | Languages | Notes |
|---|---|---|---|
| On-device `SystemLanguageModel` | **8,192 tokens** (`contextSize`) **[V-local]** **[V](https://developer.apple.com/videos/play/wwdc2026/241/)** | 24 locales: **French yes, Thai no** **[V-local]** | Has `tokenCount(for:)` |
| `PrivateCloudComputeLanguageModel()` (new in 27) | **32,768** **[V-local]** | Same list, **no Thai** **[V-local]** | Reasoning levels; free under 2M first-time downloads; has a quota **[V]** (session 241) |

Other new APIs in iOS 27 **[V]** (session 241):
- image `Attachment`
- `LanguageModel` protocol for third-party and MLX models
- `DynamicProfile`
- OCR, Spotlight and barcode system tools
- the `fm` CLI

Guided generation **[V-local]**:
```swift
@Generable struct Summary { @Guide(description: "3 bullets", .count(3)) var bullets: [String] }
try await LanguageModelSession(instructions: "…").respond(to: text, generating: Summary.self).content
```

**Suitability for this app:**
- **On-device** is fine for map-reduce summaries of chunks of about 5k tokens or less, in French or English.
- **PCC** can take hour-long chunks.
- **Neither handles Thai.** Send Thai or mixed transcripts to a cloud LLM. The existing `docs/voice/research/*` covers the ASR side.

## 7. Swift Testing and swift-format

Swift Testing **[V-local]** (tested with the package in section 2):
- `@Suite`, `@Test(arguments:)` and `#expect(await …)` all work.
- `Issue.record(_:severity: .warning)` and `Test.cancel` are new **[V]** (session 262).
- `swift test --repeat-until-success` is new **[V]** (session 262).
- XCTest and Swift Testing assertions can now be used in each other's tests **[V]** (session 262).

swift-format **[V-local]**:
- It is bundled: `xcrun --find swift-format` resolves to `XcodeDefault.xctoolchain/usr/bin/swift-format`.
- `swift format --version` prints `main`.
- `swift format lint --strict -r -p Sources Tests` works, and `--strict` makes every finding an error.

## 8. App icon (Icon Composer)

- `Icon Composer.app` ships inside Xcode 27 **[V-local]**. A single `AppIcon.icon` folder holds the light, dark, clear and tinted variants.
- Reference it by setting the App Icon name to the file name without the extension. Alternate icons are not supported **[V](https://useyourloaf.com/blog/adding-icon-composer-icons-to-xcode/)**.
- **XcodeGen supports `.icon` only from 2.45.1 on. The installed version is 2.44.1, so run `brew upgrade xcodegen` to get 2.46.0** **[V](https://github.com/yonaskolb/XcodeGen/blob/master/CHANGELOG.md)**.
- To wire it up, put `AppIcon.icon` under `sources` and set `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`.

## 9. AVFoundation playback

**Containers** **[V-local]** (probe on macOS 27.2; iOS needs a device test **[U]**):
- **Ogg/Opus** and **MP4/Opus** load and play through both `AVURLAsset` and `AVAudioFile`.
- CAF/Opus could not be produced with ffmpeg, so it is untested.
- Plan: wrap the pendant's raw Opus frames in Ogg, or transcode to AAC in `.m4a`.

**Memory-bounded playback**
- `AVPlayer`/`AVPlayerItem` streams from the file and doesn't load it whole.
- For hour-long files, one `AVPlayerItem` per file and `seek(to:)` is enough. Avoid `AVAudioPlayer` with `Data` **[U]**.

**Now Playing and remote commands** **[V-local]**
- Set `MPNowPlayingInfoCenter.default().nowPlayingInfo` with title, duration, elapsed time and rate.
- Register commands such as `MPRemoteCommandCenter.shared().playCommand.addTarget { _ in .success }`, and set `skipForwardCommand.preferredIntervals = [15]`.
- Requires the `audio` background mode and the `.playback` audio session category.

**New in iOS 27** **[V-local]**:
- `MPNowPlayingInfoPropertyAppEntityIdentifiers`, for App Intents
- `AVPlayer.setDisconnectedFromSystemAudio(_:)`
- No new codec APIs.

## 10. CoreLocation

The modern API **[V-local]**:
- `CLServiceSession(authorization: .whenInUse)` (hold a reference to it)
- `for try await u in CLLocationUpdate.liveUpdates(.default)`; each update has `u.location`, `u.stationary` and `u.insufficientlyInUse`
- `CLBackgroundActivitySession()` to keep receiving updates in the background
- `CLMonitor` for geofence conditions
- iOS 27 adds only `.maritime` and `headingBody`.

**Low-power correlation with capture times**
- Bluetooth wakes the app to sync anyway, so take one `liveUpdates` sample per sync. Also keep `CLLocationManager.startMonitoringSignificantLocationChanges()` running; it is about 500 m granularity, relaunches the app, and needs Always authorization.
- Store `(timestamp, coordinate)` pairs and join them to recording time ranges.
- `CLLocationUpdate` has no significant-change equivalent **[U]**.
