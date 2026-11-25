# Fast iOS end-to-end tests on this Mac

Research of 26 Nov 2026. Read-only; no repo code changed. Front end only, server mocked.

## Target

**The P0 set (about 10 flows) in under 60 s from a warm cache**: app already built, simulators already booted,
nothing changed but Swift in the app. A cold first run (build plus first boot) may take a few minutes; that is paid
once, not per run.

The budget, per run:

| Step | Time |
|---|---|
| Incremental `build-for-testing` (one app file changed) | 15–30 s (not measured here, see below) |
| `test-without-building`, runner start | 5–10 s |
| 10 UI tests at ~5 s each over 3 simulators | ~20 s |
| Total | ~40–60 s |

Everything else (every screen state, every card layout) belongs in in-process tests that cost milliseconds each,
not in the P0 set.

## The recipe, step by step

1. **Two layers, not one.** Keep the XCUITest P0 set small: only flows that cross screens, the app launch, a
   notification tap, a pairing. Test single screens and their states in-process (step 9). Every UI test pays an app
   launch and a cross-process query on every step; an in-process test pays neither.
2. **Add one UI test target** (`LifelogUITests`) in `project.yml`, with a test plan that sets the launch
   environment for every test (step 5) and turns timeouts on (step 8).
3. **Build once, test many.** Run
   `xcodebuild build-for-testing -scheme Lifelog -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
   -derivedDataPath .build/DerivedData` once. It writes a `.xctestrun` file under `Build/Products/`. Every later
   run is `xcodebuild test-without-building -xctestrun <that file> -destination id=<sim>`, which skips the build
   graph entirely. Rebuild only when Swift changed (the gate's `isSwiftRead` test in `scripts/check.ts` already
   answers that question).
4. **Keep a warm pool of simulators.** Clone the iPhone 18 Pro once per worker (`simctl clone`, 2.4 s), boot them
   once (5 s each when warm, 34 s for a cold first boot), and leave them booted between runs. Install the app once
   per clone; `test-without-building` reinstalls only when the build changed. Grant permissions up front with
   `simctl privacy <sim> grant all <bundle id>` so no system alert ever appears.
5. **Mock the server in the app's process.** A launch environment variable (say `LIFE_E2E_FIXTURE=<scenario>`) makes
   the app, in Debug only, register a `URLProtocol` that answers from fixture files. The seam already exists:
   `Kit/Sources/LifeConnector/LifeHTTP.swift` says "`URLSession` is the only thing a test replaces (a
   `URLProtocol`)", and the server's wire fixtures and `openapi.json` already feed the Kit tests. Cost per request:
   microseconds, no port, no process, no shared state between parallel workers.
6. **Turn animations off in the app, from the same launch environment**: `UIView.setAnimationsEnabled(false)` at
   start, plus a root `.transaction { $0.disablesAnimations = true }` for SwiftUI (UIKit's switch does not reliably
   cover SwiftUI animations). Where a test must see an animation run, set the key window's `layer.speed` high
   instead.
7. **Query by accessibility identifier, wait by condition.** `app.buttons["card.send"]`, never
   `app.staticTexts["Send"]` (text changes with copy and language). The app has 31 identifiers today; each P0 flow
   needs its own. Never `sleep`; use `waitForExistence(timeout:)` with short timeouts, or a polling helper
   (Wealthfront's lesson, below).
8. **Fail fast.** `-test-timeouts-enabled YES -default-test-execution-time-allowance 60` (rounded up to a minute),
   `-collect-test-diagnostics never` locally, no `-retry-tests-on-failure` in the gate (a retry hides a flake; use
   `-test-iterations 20 -run-tests-until-failure` to hunt one instead). Set `continueAfterFailure = false` in every
   UI test.
9. **In-process screen tests.** Host each SwiftUI screen in a unit-test bundle (a hosted test target with the app as
   host, or a Kit test with a `UIHostingController`) fed by the same fixtures, and assert on its model or a snapshot.
   No app launch, no XCUITest process: milliseconds per test, and they run in `swift test` with the rest of Kit.
10. **Run 3 workers, one test per worker slot.** `-parallel-testing-enabled YES -parallel-testing-worker-count 3`.
    Xcode hands out whole test classes, so either keep one flow per class, or pass every method in an `-only-testing`
    response file (`-only-testing @p0.txt`, supported by this xcodebuild).
11. **Select by change.** Map changed files to the flows they touch (one small table, like the gate's own
    `isSwiftRead`), and pass only those to `-only-testing`. Run the whole P0 set at landing.

## Measurements on this Mac

Apple M2 Pro, 12 cores, 32 GB. Load average was **49 to 140** during these runs (the owner's live services, a
TypeScript build and another session's Swift build), so these are pessimistic.

| What | Time |
|---|---|
| `simctl boot` returns | 0.6–1.2 s |
| First boot of iPhone 18 Pro after a long idle, until `bootstatus -b` | **34.0 s** |
| Boot again (shutdown, boot) | **4.8 s** |
| `simctl clone` of a shut-down iPhone 18 Pro | **2.4 s** |
| Boot of a fresh clone | **3.0 s** |
| `simctl shutdown` | 3.3–4.0 s |
| `simctl erase` of a clone | 1.8 s |
| Disk: the original device / a fresh clone | 394 MB / 17 MB (clones share until written) |

**Not measured: the incremental Debug build-for-testing.** `.build/DerivedData` did not exist (no warm cache to
time against), and another Swift build was running at load 140. A cold build at that load would have been both
heavy and meaningless. Measure it at a quiet moment: build once, touch one view file, time the second
`build-for-testing`.

All probe simulators were deleted and the iPhone 18 Pro was shut down afterwards.

## Evidence

**Build once, test without building.** `xcodebuild -help` on this Xcode lists `build-for-testing`,
`test-without-building`, `-xctestrun`, `-testProductsPath`, `-only-testing @<file>`, `-skip-testing`,
`-enumerate-tests`, `-parallel-testing-worker-count`, `-test-iterations`, `-retry-tests-on-failure`,
`-run-tests-until-failure`, `-test-timeouts-enabled`, `-default-test-execution-time-allowance` and
`-collect-test-diagnostics never`. The split is Apple's documented CI pattern:
[TN2339](https://developer.apple.com/library/archive/technotes/TN2339/_index.html). Tuist recommends the same
for controlling parallelism: [tuist.dev](https://tuist.dev/blog/2025/03/25/tests).

**Parallel testing hands out whole classes.** Apple, WWDC20 "Get your test results faster": tests are distributed
by class, each destination takes the next class when it finishes; XCTest's own suites ran ~30% faster on two
devices ([video](https://developer.apple.com/videos/play/wwdc2020/10221/)). Xcode clones the chosen simulator and
uses it only as a template ([WWDC18 403 notes](https://wwdcnotes.com/notes/wwdc18/403)). Grab saw workers finish
at 7 and 13 minutes because one class held the long tests; dispatching one test per group cut that imbalance from
6 to 0.4 minutes ([Grab](https://engineering.grab.com/tackling-ui-test-execution-time-imbalance-for-xcode-parallel-testing)).
Forum threads report Swift Testing suites not spreading across clones and parallel runs not repeating on Xcode
26.2 ([1](https://developer.apple.com/forums/thread/838772), [2](https://developer.apple.com/forums/thread/817089)):
write the UI tests in XCTest and check the spread in the first run's log.

**How many simulators.** No documented limit. Tuist's model: 200 five-second tests on 4 simulators take ~4.1 min,
and adding machines halves it, while more simulators per machine gives diminishing returns
([tuist.dev](https://tuist.dev/blog/2025/03/25/tests)). Forum reports tie failures to memory pressure and
crashes past a few simulators ([forums](https://developer.apple.com/forums/thread/125536),
[preboot](https://developer.apple.com/forums/thread/737420)). On a 12-core, 32 GB Mac that also runs Life, 3 is
the sane number; 4 only when the load average is low. Each booted simulator plus app costs roughly 1–2 GB (an
estimate, not measured here).

**Animations.** `UIView.setAnimationsEnabled(false)` must run in the app, not the test, behind a launch argument;
Jesse Squires notes it is unproven for SwiftUI and quotes the warning that disabling animations changes callback
timing, so speeding up `layer.speed` is the safer variant
([jessesquires.com](https://www.jessesquires.com/blog/2021/03/17/xcode-ui-testing-reliability-tips/)). A forum
thread ties "Wait for app to idle" stalls to animations, fixed by turning them off
([forums](https://developer.apple.com/forums/thread/74466)). `simctl ui` here offers appearance, contrast and
content size, but no Reduce Motion: it cannot be set from outside.

**Waits.** Wealthfront found `XCTWaiter` polls once a second and cannot be changed; their own polling helper made
local runs up to ~80% faster and CI ~50% faster (backoff from 0.2 s to 2 s; 0.1 s polling overloaded four parallel
runners) ([Wealthfront](https://eng.wealthfront.com/?p=3423)).

**App launches.** Before Xcode 9 every test relaunched the app; `activate()` reuses a running one
([openradar](https://openradar.appspot.com/23115791)). Reports of launches slowing several-fold between Xcode
versions ([forums](https://developer.apple.com/forums/thread/658350)) mean launch time is worth timing once on this
Xcode, not assuming.

**Hangs.** Execution time allowance kills a hung test, takes a spindump and restarts the runner; values round to
the minute, under 60 s rounds up to 60 ([WWDC20 10221](https://developer.apple.com/videos/play/wwdc2020/10221/)).

**In-process screen tests.** swift-snapshot-testing renders a view in a unit-test target with no app launch and
no simulator driving ([classmethod](https://dev.classmethod.jp/en/articles/swift-snapshot-testing/),
[Point-Free](https://pointfree.co/episodes/ep86-swiftui-snapshot-testing)). The gain holds only for tests that set
a state and render, not for tests that click through
([cookbook](https://android-ui-testing.github.io/Cookbook/basics/ui_tests_vs_snapshot_tests)). No source gave a
clean benchmark; the order of magnitude (milliseconds against seconds) follows from skipping the launch.

**Selective testing.** Tuist hashes modules and adds `-skip-testing` for unchanged ones; its finest unit is a
target, since test-to-source links inside code cannot be detected
([docs](https://docs.tuist.dev/en/guides/develop/selective-testing/xcodebuild)). Here a hand-written table from
file paths to P0 flows is enough; no new tool.

## Trade-offs

**Server mock: three ways.**

| Way | Cost per test | Fidelity | Parallel-safe |
|---|---|---|---|
| Launch argument picks canned app state (no network at all) | ~0 | lowest: skips the HTTP and decoding code | yes |
| In-process `URLProtocol` serving fixtures, picked by launch environment | microseconds per request | real `URLSession`, real decoding, real errors | yes, per process |
| Local HTTP mock server (Bun) | ~1 ms per request, a process to start and stop | also covers ATS, the network stack, the URL | needs a port per worker or per-test scenario keys |

The `URLProtocol` way wins: it already exists in Kit's tests, uses the server's own fixtures, and nothing is shared
between workers. A local server only adds coverage of the transport, which the P0 set does not need.

**Resetting state.** Fastest to slowest: the app wipes its own container at launch when told by the launch
environment (milliseconds); `simctl install_app_data` of a prepared `.xcappdata` (seconds); uninstall and reinstall
(seconds, plus permission grants lost); `simctl erase` (1.8 s here, then a cold-ish boot). Use the first, and erase
a clone only when it misbehaves.

**Disabling animations** hides bugs in animation callbacks. Keep one P0 flow with animations on, or use a high
`layer.speed` instead.

**More workers** cost RAM and load on a Mac that runs Life; past 3 the gain shrinks and crashes grow.

**`activate()` instead of `launch()`** saves a launch per test but leaks state between tests. Use it only within a
class whose tests run in order on purpose.

## What makes these suites flaky, and the guard

| Cause | Guard |
|---|---|
| Fixed `sleep`s, or waits too short under load | condition waits; timeouts sized for a loaded Mac |
| Animations and "wait for idle" | animations off from the launch environment |
| System alerts (notifications, location, microphone) | `simctl privacy grant` before the run |
| Text queries that break on copy changes | accessibility identifiers |
| Order dependence (state left by an earlier test) | each test resets its container; random order in the test plan |
| Real network, real clock | `URLProtocol` fixtures; a fixed date passed by launch environment |
| Classes split unevenly over clones | one flow per class, or `-only-testing` per method |
| Too many simulators on a busy Mac | 3 workers; check `uptime` first |
| Hangs | execution time allowance, 60 s |
