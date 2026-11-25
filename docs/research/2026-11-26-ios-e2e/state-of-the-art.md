# Fast front-end E2E tests for the iPhone app (state of the art, 26 Nov 2026)

## Recommendation

Mock Life inside the app, not beside it, and test in two layers. First, add one Debug-only seam: a launch argument
(say `-wireFixtures <scenario>`) that builds `MCPClient` with a `URLSession` whose `protocolClasses` holds a
fixture `URLProtocol`. It answers each tool call from `apps/lifelog/fixtures/wire/life/` (the server's own tests write
those files, so the mock can't drift from the contract), plus a fake paired token. `MCPClient` already takes a
`urlSession`, and Kit's tests already have a `Stub: URLProtocol`, so this is small. It runs the real decoding, `ReadState`,
`LifeStore` and SwiftUI. No server, port or process to start, and nothing to make flaky.
Layer 1 is most of the coverage: Swift Testing tests that run hosted in the app and drive `LifeStore` and the
screens' stores against the same fixtures. Each takes milliseconds and they run in parallel by default. Add
swift-snapshot-testing (or Prefire over the `#Preview`s) for the look of cards and the thread.
Layer 2 is a handful of XCUITest journeys (pair, read the thread, answer a card, open a profile, push a card). They use
the same launch argument with animations off. Use a short custom polling wait instead of `XCTWaiter`'s 1-second
poll, build once with `build-for-testing`, then run `test-without-building` on 2 to 4 parallel clones.
Keep `agent-device` (accessibility tree, `.ad` replays) for exploratory and agent-driven checks, not as the gate.
Rule out Appium, Maestro, KIF and EarlGrey 2 (reasons below). Expected speed: layer 1 in seconds for the whole suite.
Layer 2 should take about 5 to 15 s per journey (the launch is most of it), but that's an estimate, not a measurement:
time one journey before you commit to it.

## Comparison

| Tool | Speed | Flakiness | Effort for us | Mock fit |
|---|---|---|---|---|
| In-app `URLProtocol` fixture seam (the mock itself) | No network: replies in microseconds | None from the network | Small: `MCPClient(urlSession:)` exists, Kit's `Stub` exists | Best: replays the server-written wire fixtures through the real client |
| Swift Testing, app-hosted, store-level | ms per test, parallel by default | Very low | Small: Kit's test style already | Same fixtures, or a fake `LifeAPI` (`LifeStore(api:)` takes one) |
| ViewInspector 0.10.x | ms per test | Low, but breaks on SwiftUI internals each OS | Medium: coverage of newest SwiftUI APIs lags | Same fixtures |
| swift-snapshot-testing 1.19 / Prefire 6.6 | Fast-ish: ~0.1 to 1 s per image, reports of slow cases | Medium: pixels shift with OS, fonts, glass | Small to start, ongoing re-records | Feeds views fixture models |
| XCUITest (Xcode 27) | Slowest Apple option: app launch plus out-of-process queries; 1 s default poll | Medium; low with mocked network, animations off, ids | Medium: new UI test target in `project.yml` | Launch args and env select the fixture scenario |
| agent-device (callstack) | XCTest-backed, CLI round trips per step | Medium | Already installed; `.ad` replays | Same launch args through `simctl launch` |
| Maestro / maestro-runner | Drives XCUITest underneath, so slower than XCUITest; no iOS numbers published | Medium; open timeout and simulator bugs | Medium: YAML, JVM CLI | Launch args only |
| EarlGrey 2 | In-process sync was fastest (2020 numbers) | Low when it works | High: last release 2022, ObjC, poor SwiftUI story | Launch args |
| KIF 4.1 | In-process, fast | Medium on SwiftUI (UIKit accessibility walk) | Medium | Same seam |
| Appium (XCUITest driver) | Adds WebDriverAgent hops over XCUITest | Medium to high | High; nothing gained for one native app | Launch args |
| Local mock HTTP server (WireMock, Swifter, FlyingFox) | ms per call, plus a process and port | Port and process lifetime | Medium; Swifter unmaintained since 2024 | Good, but the in-app `URLProtocol` does the same with nothing to run |

## Evidence

### Apple: XCUITest and Swift Testing

- WWDC26 "Migrate to Swift Testing" (session 267) says UI automation and performance testing APIs exist only in XCTest.
  It also says every Swift Testing test, parameterized cases included, runs in parallel by default. So UI journeys stay
  on XCTest, and everything below them can be Swift Testing.
  https://developer.apple.com/videos/play/wwdc2026/267/
- WWDC25 "Record, replay, and review: UI automation with Xcode" (session 344) covers recording taps into code, replaying
  across locales and devices through test plan configurations, and reviewing videos in the report. It also covers
  accessibility identifiers as the stable query. That helps with writing tests, not with run speed.
  https://developer.apple.com/videos/play/wwdc2025/344/
- Known clone bugs: Xcode 26.2 tried to reuse a deleted clone from an earlier run ("No matching device"), and on Xcode
  27 betas clones were missing from the Device Hub. A Swift Testing suite ran on one simulator despite
  `-parallel-testing-worker-count 2`. So pin the worker count, and erase clones if a run fails this way.
  https://developer.apple.com/forums/thread/817089 ·
  https://developer.apple.com/forums/thread/844485 ·
  https://developer.apple.com/forums/thread/838772
- Prefer `-maximum-parallel-testing-workers` to a fixed count. Parallel runs expose shared state (Keychain, ports,
  fixtures), so give each test its own scenario.
  https://www.simplified.guide/xcuitest/parallel-test-run
- Build once with `build-for-testing`, then run `test-without-building`, as in CircleCI's guide.
  https://circleci.com/blog/xcuitest-parallel-execution/

### XCUITest speed tricks with numbers

- Wealthfront: `XCTWaiter` polls on a fixed 1-second interval. A 40-line replacement (polls from 0.2 s, times 1.5 each
  round, capped at 2 s) made E2E about 80% faster locally and 50% faster on CI. A flat 0.1 s poll overloaded parallel CI.
  https://eng.wealthfront.com/?p=3423
- Expedia: about 14.7 s per UI test on average, 55% faster than before, before any parallelism. Their main problem was
  mock data, because a UI test can't pass objects into the app.
  https://medium.com/expedia-group-tech/improving-ios-ui-testing-ad55470825b4
- Grab: a mock browser inside the UI tests, in place of real Safari, cut CI time 20% and made tests steadier.
  https://engineering.grab.com/iOS-CI-infrastructure-with-observability-tools
- Disable animations through a launch argument the app reads before its first view
  (`UIView.setAnimationsEnabled(false)`). Jesse Squires suggests speeding up the window's `layer.speed` instead,
  because turning animations off can change callback timing. Whether either reaches SwiftUI's own transitions is
  unclear: check on our screens.
  https://www.simplified.guide/xcuitest/animations-disable ·
  https://www.jessesquires.com/blog/2021/03/17/xcode-ui-testing-reliability-tips/
- Devexperts (2020, iOS 12, so old) measured element search. EarlGrey, in-process, was fastest; XCTest was about 10x
  slower, Appium about 100x and Katalon about 1,000x. Taps were about equal across tools. The point that still holds:
  out-of-process queries are what cost time, so query little and by identifier.
  https://devexperts.com/blog/ios-ui-testing-frameworks-performance-comparison/

### Maestro, Appium, EarlGrey, KIF

- Maestro: on iOS it translates commands into XCUITest actions, so it can't be faster than XCUITest. It's quick to
  write (interpreted YAML), but there's no published iOS speed number. Its benchmark is against Appium, on Android.
  https://maestro.dev/blog/maestro-vs-appium-the-benchmark
- Known Maestro iOS issues: `waitForAnimationToEnd` ignores its timeout (#2843, waits 6+ s against 2 s), and deep links on
  the simulator are flaky on CI (#2610).
  https://devicelab.dev/blog/maestro-github-issues-flakiness ·
  https://docs.maestro.dev/api-reference/commands/waitforanimationtoend
- maestro-runner claims about 5x faster than the Maestro CLI, but only on Android (9 flows in 1 min 12 s, against
  4 min 22 s for Maestro). On iOS it uses a prebuilt XCUITest agent.
  https://github.com/devicelab-dev/maestro-runner
- Appium's XCUITest driver puts WebDriverAgent on top of XCUITest. It has its own pages on WDA slowness and
  parallel-run conflicts. It's only worth it across many apps or a device cloud. Ruled out.
  https://appium.github.io/appium-xcuitest-driver/11.2/troubleshooting/wda-slowness/
- EarlGrey (google/EarlGrey): the repo still gets commits, but the last release is 2.2.2 from June 2022. Built for UIKit.
  Ruled out.
  https://github.com/google/EarlGrey
- KIF (kif-framework/KIF): v4.1.0 from October 2026, runs in-process in a unit-test target and walks the accessibility
  tree. It's fast, but its SwiftUI story is thin and it gives us nothing the store-level tests plus XCUITest don't.
  https://github.com/kif-framework/KIF

### In-process SwiftUI tests

- ViewInspector (0.10.5, September 2026; repo active): reflection over the view tree. It finds views, taps buttons, runs
  `onAppear`, and handles `@State`, `@Binding` and the environment. Coverage of new SwiftUI APIs is listed in its
  `readiness.md` and lags each release. Use it for a few view-logic checks, not for flows.
  https://github.com/nalexn/ViewInspector
- swift-snapshot-testing (1.19.7, October 2026) is the base. Prefire (6.6.2, November 2026) generates a snapshot test for
  every `#Preview` at build time. DoorDash's PreviewSnapshots shares configurations between previews and snapshots.
  Sentry's SnapshotPreviews does the same from the command line. One old report (1.11) saw up to 200 s per snapshot
  test, so measure ours.
  https://github.com/pointfreeco/swift-snapshot-testing ·
  https://github.com/BarredEwe/Prefire ·
  https://github.com/doordash-oss/swiftui-preview-snapshots ·
  https://github.com/getsentry/SnapshotPreviews ·
  https://discuss.bitrise.io/t/snapshot-unit-testing-bad-performance-up-to-200-seconds-per-test/23110
- AccessibilitySnapshot (Cash App, active) snapshots the VoiceOver reading of a view. It's a cheap check that what the
  agents and XCUITest query stays stable.
  https://github.com/cashapp/AccessibilitySnapshot

### Agent-driven E2E on the accessibility tree

- agent-device (callstack, active): CLI and MCP. It reads iOS simulator accessibility snapshots through a local bridge
  and acts through XCTest. Flows explored once save as `.ad` replays, or export to Maestro YAML, for CI. It publishes no
  speed numbers. Every step is a CLI round trip, so it's slower than one XCUITest process.
  https://github.com/callstack/agent-device
- Other servers (XcodeBuildMCP, mobile-mcp, xc-mcp) do the same through idb or XCTest. One warns that on Xcode 27, old
  idb companions read the tree but the simulator drops their taps silently.
  https://github.com/getsentry/XcodeBuildMCP ·
  https://github.com/mobile-next/mobile-mcp ·
  https://cdn.jsdelivr.net/npm/xc-mcp@4.0.1/README.md

### Mocking the server

- The usual pattern: the UI test sets a launch argument or an environment value. The app, in Debug only, reads it at
  start and swaps its network layer: either a `URLProtocol` stub or a client pointed at a local mock server. Use
  arguments for flags and environment values for fixture names, and never put tokens in either.
  https://www.simplified.guide/xcuitest/network-mock-use ·
  https://developer.apple.com/forums/thread/760155 ·
  https://jhandguy.github.io/posts/mocking-the-network-ios
- Local mock servers: WireMock (Kodeco's tutorial, Java process, active), Swifter (unmaintained since March 2024),
  FlyingFox (async Swift, active), LocalServer. They're useful when the app can't be changed, or when the test must read
  the requests. Neither applies here.
  https://www.kodeco.com/3462646-local-api-call-tutorial-with-wiremock-and-ui-tests-in-xcode ·
  https://github.com/swhitty/FlyingFox ·
  https://github.com/httpswift/swifter ·
  https://github.com/db-in/LocalServer
- In-process stubs: OHHTTPStubs (last pushed May 2024) and Mocker (December 2024) are `URLProtocol` wrappers. Kit's own
  `Stub: URLProtocol` (`Kit/Tests/LifeConnectorTests/Support.swift`) already does this, keyed by host, so add no
  dependency.
  https://github.com/AliSoftware/OHHTTPStubs ·
  https://github.com/WeTransfer/Mocker

### What this means in our code (read, not changed)

- `MCPClient(session:urlSession:)` already takes a `URLSession` (`Kit/Sources/LifeConnector/MCPClient.swift`).
  `LifeStore` already takes an `api` (`Lifelog/Life/LifeStore.swift`). That gives two seams: the `URLProtocol` one tests
  the real client against the wire fixtures, and the `LifeAPI` one is faster but skips decoding.
- The app already reads Debug launch arguments (`-fixtureLibrary`, `-fakePendant`, `-offline`, `-serverFlaky`) and
  environment values (`LIFE_ORIGIN`, `LIFE_PAIRING_CODE`). A fixture scenario argument fits that pattern. Keep it behind
  `#if DEBUG` and check it with the Release build in AGENTS.md.
- The answer and send flows stream SSE. A `URLProtocol` can stream by calling `didLoad` once per event. A step's
  timing can be replayed with short delays, enough to test the running, late and failed states.
- Gaps: no published iOS numbers compare Maestro, agent-device and XCUITest on SwiftUI. Before choosing the size of
  layer 2, time one XCUITest journey and one agent-device replay of the same flow on the iOS 27.2 simulator.
