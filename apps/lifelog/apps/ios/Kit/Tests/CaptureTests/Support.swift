import Foundation
import PendantProtocol
import Synchronization
import Testing
import Timeline

@testable import Capture
@testable import SourceStore

/// The real `SourceStore` in a temporary directory, with two seams: `holdPersists` blocks writes to hold a drain
/// mid-await, and `failPersists` makes them throw. Everything else is the store itself.
actor TestSink: PageSink {
    let store: SourceStore
    private(set) var duplicates = 0
    private(set) var waitingPersists = 0
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var failure: (any Error)?
    private var newLifeFailure: (any Error)?

    init() {
        let directory = URL.temporaryDirectory.appending(path: "capture-\(UUID())", directoryHint: .isDirectory)
        store = try! SourceStore(directory: directory, flushes: false)
    }

    func holdPersists() { held = true }

    func releasePersists() {
        held = false
        waiters.forEach { $0.resume() }
        waiters = []
    }

    /// Every write throws `error` until called again with `nil`.
    func failPersists(_ error: (any Error)?) { failure = error }

    func flashLife(deviceID: String, evidence: String?) async throws -> FlashLife {
        try await store.flashLife(deviceID: deviceID, evidence: evidence)
    }

    func startNewFlashLife(deviceID: String, reason: String) async throws -> FlashLife {
        if let newLifeFailure { throw newLifeFailure }
        return try await store.startNewFlashLife(deviceID: deviceID, reason: reason)
    }

    /// Every new flash life throws `error` until called again with `nil`.
    func failNewLives(_ error: (any Error)?) { newLifeFailure = error }

    func persist(_ page: RawPage) async throws -> PersistOutcome {
        if held {
            waitingPersists += 1
            await withCheckedContinuation { waiters.append($0) }
            waitingPersists -= 1
        }
        if let failure { throw failure }
        let outcome = try await store.persist(page)
        if outcome == .duplicate { duplicates += 1 }
        return outcome
    }

    func recordGap(_ key: PageKey, reason: GapReason, evidence: Data) async throws -> Bool {
        try await store.recordGap(key, reason: reason, evidence: evidence)
    }

    func recordHeld(_ key: PageKey, reason: HeldReason, evidence: Data) async throws -> Bool {
        try await store.recordHeld(key, reason: reason, evidence: evidence)
    }

    func ackableIndex(deviceID: String, startingAt oldest: UInt64) async throws -> UInt64? {
        try await store.ackableIndex(deviceID: deviceID, startingAt: oldest)
    }

    func savedIndex(deviceID: String, startingAt oldest: UInt64) async throws -> UInt64? {
        try await store.savedIndex(deviceID: deviceID, startingAt: oldest)
    }

    func newestIndex(deviceID: String, in life: FlashLife) async throws -> UInt64? {
        try await store.newestIndex(deviceID: deviceID, in: life)
    }

    func recordClockSync(_ sync: ClockSync, deviceID: String) async throws {
        try await store.recordClockSync(sync, deviceID: deviceID)
    }

    func recordRecordingChange(_ change: RecordingChange, deviceID: String) async throws {
        try await store.recordRecordingChange(change, deviceID: deviceID)
    }

    // MARK: Reading the store, in the Pendant's own indices

    /// Evidence of each flash life, oldest first.
    var lives: [String?] { get async { try! await store.lifeEvidence(deviceID: Harness.deviceID) } }

    /// The current flash life's store base (life << 40), so a missed conversion shows.
    var base: UInt64 { get async { FlashLife(number: Int64(await lives.count)).base } }

    /// Every stored page, in every life.
    var pages: [StoredPage] {
        get async { try! await store.pages(deviceID: Harness.deviceID, from: 0, limit: .max) }
    }

    func page(at deviceIndex: UInt64) async -> StoredPage? {
        try? await store.page(PageKey(deviceID: Harness.deviceID, index: await base + deviceIndex))
    }

    var gaps: [UInt64: GapReason] {
        get async { try! await store.gaps(deviceID: Harness.deviceID) }
    }

    /// A gap's reason, and the evidence its incident keeps.
    func gap(at deviceIndex: UInt64) async -> (reason: GapReason, evidence: Data?)? {
        let index = await base + deviceIndex
        guard let reason = await gaps[index] else { return nil }
        return (reason, await incidents(at: deviceIndex).first?.evidence)
    }

    func incidents(at deviceIndex: UInt64) async -> [Incident] {
        let index = await base + deviceIndex
        return try! await store.incidents().filter { $0.key.index == index }
    }

    /// The owner accepts a held page as a gap, as the incident card does.
    func acceptHeld(_ deviceIndex: UInt64) async throws {
        for incident in await incidents(at: deviceIndex) where incident.resolution == nil {
            try await store.resolveIncident(incident.id, keeping: .gap)
        }
    }

    /// Receipts that look current (the Pendant's own evidence) but hold other bytes, from before the test: an index
    /// restart the Pendant's identity didn't reveal. `time` is each one's device time.
    func preload(_ indices: ClosedRange<UInt64>, evidence: String?, time: (UInt64) -> Int64) async throws {
        let base = try await store.flashLife(deviceID: Harness.deviceID, evidence: evidence).base
        for index in indices {
            _ = try await store.persist(
                RawPage(
                    key: PageKey(deviceID: Harness.deviceID, index: base + index), session: 0,
                    deviceTimeMillis: time(index), payload: Data("stale \(index)".utf8), receivedAt: .distantPast))
        }
    }
}

extension SourceStore {
    fileprivate func lifeEvidence(deviceID: String) throws -> [String?] {
        try db.query("SELECT evidence FROM flash_lives WHERE device_id = ?1 ORDER BY life", [.text(deviceID)]) {
            $0.isNull(0) ? nil : $0.text(0)
        }
    }
}

/// A coordinator wired to a fake Pendant and a real source store, with fast timeouts.
struct Harness {
    static let deviceID = "pendant-test"

    let fake: FakePendantTransport
    let sink = TestSink()
    let coordinator: DrainCoordinator
    let clock = TestClock()

    init(
        _ policy: AckPolicy, ackBatchSize: Int = 25, replyTimeout: Duration = .seconds(2),
        handshakeTimeout: Duration = .seconds(4), confirmationPollInterval: Duration = .milliseconds(100),
        pageIdleTimeout: Duration = .seconds(5), recordingChangeDelay: Duration = .zero,
        pageInterval: Duration = .zero, hasBatteryService: Bool = true, pushesSealedPages: Bool = true,
        stallTimeout: Duration = .seconds(3600)
    ) {
        fake = FakePendantTransport(
            recordingChangeDelay: recordingChangeDelay, pageInterval: pageInterval,
            hasBatteryService: hasBatteryService, pushesSealedPages: pushesSealedPages)
        let clock = clock
        coordinator = DrainCoordinator(
            transport: fake, sink: sink, deviceID: { _ in Self.deviceID },
            configuration: CaptureConfiguration(
                ackPolicy: policy, ackBatchSize: ackBatchSize, replyTimeout: replyTimeout,
                handshakeTimeout: handshakeTimeout, confirmationPollInterval: confirmationPollInterval,
                pageIdleTimeout: pageIdleTimeout, resyncInterval: .seconds(3600), stallTimeout: stallTimeout),
            now: { clock.date }, clock: clock)
    }

    /// Moves the coordinator's clock forward, as if that much time passed. Returns once its timers that came due woke.
    func advanceClock(by duration: Duration) async { await clock.advance(by: duration) }

    /// Runs the coordinator for the duration of `body`.
    func run(knownDevice: UUID? = nil, _ body: () async throws -> Void) async rethrows {
        let coordinator = coordinator
        let runner = Task { await coordinator.run(knownDevice: knownDevice) }
        defer { runner.cancel() }
        // Launch never scans; without a known Pendant the test plays the owner tapping "Set up".
        if knownDevice == nil { await coordinator.reconnect() }
        try await body()
    }

    /// Returns once the coordinator has handled every Pendant event sent so far and saved every page, including what
    /// that work set off. Events are handled in order, so a battery reading sent last is a barrier: once it shows,
    /// everything before it is done.
    func quiesce() async {
        for _ in 0..<3 {
            let before = await status().batteryPercent?.at
            await fake.readBattery()
            _ = await eventually { await status().batteryPercent?.at != before }
            await coordinator.waitForPersistence()
        }
    }

    var acks: [UInt64] {
        get async {
            await fake.commands.compactMap {
                if case .acknowledge(let index) = $0 { index } else { nil }
            }
        }
    }

    func status() async -> CaptureStatus { await coordinator.status }
}

/// Real time plus whatever a test added, for both the coordinator's `Date`s and its timers. A timer wakes once
/// either passes its deadline.
final class TestClock: Clock, Sendable {
    private let state = Mutex<(skew: Duration, sleepers: [UUID: ContinuousClock.Instant])>((.zero, [:]))

    var now: ContinuousClock.Instant { .now + state.withLock { $0.skew } }
    var minimumResolution: Duration { .milliseconds(1) }
    var date: Date {
        let (seconds, attoseconds) = state.withLock { $0.skew }.components
        return Date() + Double(seconds) + Double(attoseconds) / 1e18
    }

    func sleep(until deadline: ContinuousClock.Instant, tolerance: Duration?) async throws {
        let id = UUID()
        state.withLock { $0.sleepers[id] = deadline }
        defer { state.withLock { _ = $0.sleepers.removeValue(forKey: id) } }
        // ponytail: polls so an advance wakes it within 5 ms; a sleeper queue if tests ever need exact steps.
        while now < deadline {
            try await Task.sleep(for: min(deadline - now, .milliseconds(5)))
        }
    }

    /// Moves time on, then waits until every timer that came due has woken.
    func advance(by duration: Duration) async {
        state.withLock { $0.skew += duration }
        while state.withLock({ state in state.sleepers.values.contains { $0 <= .now + state.skew } }) {
            try? await Task.sleep(for: .milliseconds(1))
        }
    }
}

/// Polls `condition` until it holds or `timeout` passes.
func eventually(_ timeout: Duration = .seconds(5), _ condition: () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
}

extension DrainPhase {
    var isCaughtUp: Bool {
        if case .caughtUp = self { true } else { false }
    }
}

extension RecordingState {
    var isPaused: Bool {
        if case .paused = self { true } else { false }
    }

    var isRecording: Bool {
        if case .recording = self { true } else { false }
    }
}
