import XCTest

/// One flow: the app launched in the simulator against the fake Life inside it (`Lifelog/E2E`), a scenario file for its
/// script, and `calls.jsonl` for what Life was asked. One class per flow, so Xcode spreads the flows over the simulators.
@MainActor
class FlowTest: XCTestCase {
    var app: XCUIApplication!
    private var dir = URL(filePath: "/")
    private static let ios = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    static let ask = "dec_000000000001"
    /// The pairing links of the scenarios' two Lifes.
    static func link(_ origin: String, code: String) -> String {
        "lifelog://pair?life=https%3A%2F%2Flife-\(origin).e2e.test&code=\(code)"
    }

    /// `bun run e2e:phone --watch <flow>`: animations on, a pause after each step, for a person watching.
    private static let isWatched = ProcessInfo.processInfo.environment["E2E_WATCH"] != nil
    private func watchPause() { if Self.isWatched { Thread.sleep(forTimeInterval: 1.5) } }

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        executionTimeAllowance = 60
        dir = URL(filePath: "/tmp/lifelog-e2e/\(type(of: self))")
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws { app.terminate() }

    /// Starts the app on `scenario` (a file of `scenarios/`). `paired`: the fake Life it starts paired to. `reset: false`
    /// is a relaunch: what the app kept stays.
    func launch(_ scenario: String, paired: String? = "a", reset: Bool = true, open: String? = nil) {
        let fixtures = Self.ios.deletingLastPathComponent().deletingLastPathComponent().appending(path: "fixtures")
        var arguments = [
            "-e2eScenario", Self.ios.appending(path: "LifelogE2E/scenarios/\(scenario).json").path,
            "-e2eFixtures", fixtures.path, "-e2eDir", dir.path, "-e2eClock", "2026-11-18T10:00:00Z",
        ]
        if let paired { arguments += ["-e2ePaired", paired] }
        if reset { arguments += ["-e2eReset", "YES"] }
        if let open { arguments += ["-e2eOpenURL", open] }
        if Self.isWatched { arguments += ["-e2eKeepAnimations", "YES"] }
        app.launchArguments = arguments
        app.launch()
    }

    /// Moves the scenario to its step `n` (Life's state changes, the app reads again).
    func step(_ n: Int) { try? String(n).write(to: dir.appending(path: "step"), atomically: true, encoding: .utf8) }

    func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    /// Waits for `element` by polling every tenth of a second, never a fixed sleep.
    func appears(_ element: XCUIElement, _ what: String, within seconds: Double = 20) {
        poll(what, within: seconds) { element.exists }
    }

    func vanishes(_ element: XCUIElement, _ what: String, within seconds: Double = 20) {
        poll(what, within: seconds) { !element.exists }
    }

    func poll(_ what: String, within seconds: Double = 20, _ isTrue: () -> Bool) {
        let end = Date.now.addingTimeInterval(seconds)
        while !isTrue() {
            if Date.now > end {
                return XCTFail(
                    "Waited \(seconds) s for: \(what)\n\(app.debugDescription.split(separator: "\n").filter { $0.contains("identifier") || $0.contains("Button") || $0.contains("StaticText") }.joined(separator: "\n"))"
                )
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        watchPause()
    }

    /// His round button's ask, then the ask it brings back unfolded.
    func openTheAsk() {
        let button = app.buttons["What's waiting on me"]
        appears(button, "the thread")
        button.tap()
        let row = element(AID.askRow(Self.ask))
        appears(row, "the ask in the thread")
        row.tap()
    }

    func tap(_ id: String) {
        let target = element(id)
        appears(target, id)
        target.tap()
        watchPause()
    }

    /// Every call the app made to a fake Life, in order.
    func calls() -> [[String: Any]] {
        let text = (try? String(contentsOf: dir.appending(path: "calls.jsonl"), encoding: .utf8)) ?? ""
        return text.split(separator: "\n").compactMap {
            (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
        }
    }

    func answers() -> [[String: Any]] { calls().filter { $0["tool"] as? String == "answer_check" } }
    func undos() -> [[String: Any]] { answers().filter { $0["undo"] as? Bool == true } }

    /// The answers Life took as new (never a repeat of one it had, never one it refused): the sends.
    func sends() -> [[String: Any]] { answers().filter { ["answered", "dropped"].contains($0["outcome"] as? String) } }
}
