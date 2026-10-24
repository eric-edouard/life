import Capture
import Foundation
import PendantProtocol
import Testing

@testable import Health

private let build = BuildInfo(appVersion: "1.0", appBuild: "7", os: "iOS 27.0 (24A100)", device: "iPhone17,1")
private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let pendantID = UUID()

private func json(_ value: some Encodable) throws -> String {
    String(decoding: try HealthOutbox.encode(value), as: UTF8.self)
}

private func keys(_ value: some Encodable) throws -> Set<String> {
    let object = try JSONSerialization.jsonObject(with: try HealthOutbox.encode(value)) as? [String: Any]
    return Set(object?.keys.map { $0 } ?? [])
}

@Test func heartbeatCarriesStatesAndCountsButNoIdentifiersOrErrorText() throws {
    var status = CaptureStatus()
    status.connection = .disconnected(pendantID, .linkLost("Peer at Clara's flat removed pairing"))
    status.recording = .failed(.rejected(.pause, "rejected near 21.0367 105.8342"), at: now)
    status.lastKnownRecording = Observed(.recording, at: now)
    status.sync = .failed(.storage("/var/mobile/secret-path: disk full"))
    status.incidents = [.storageWriteFailed("/var/mobile/secret-path"), .integrityConflict(index: 42)]
    status.batteryPercent = Observed(81, at: now)
    status.storage = Observed(
        StorageState(oldestPage: 1, newestPage: 9, session: 3, freePages: 900, totalPages: 1000), at: now)
    status.backlog = Observed(Backlog(pages: 120, estimatedDuration: .seconds(90)), at: now)
    var wakes = WakeLog()
    var dayAgo = SavedPages()
    dayAgo.pulled = 50
    var saved = dayAgo
    saved.pulled += 30
    saved.bytes = 6000
    wakes.record(saved: dayAgo, previous: SavedPages(), at: now.addingTimeInterval(-90_000))
    wakes.record(saved: saved, previous: dayAgo, at: now.addingTimeInterval(-3600))

    let heartbeat = Heartbeat(
        reason: .writeFailure, at: now, build: build, status: status, connectionSince: now, lastContact: nil,
        phone: .init(batteryLevel: 0.5, charging: false, freeBytes: 1 << 33, lowPowerMode: false), wakeLog: wakes)
    let text = try json(heartbeat)

    for secret in [pendantID.uuidString, "Clara", "21.0367", "secret-path", "disk full", "rejected near"] {
        #expect(!text.contains(secret))
    }
    #expect(
        try keys(heartbeat) == [
            "id", "reason", "observedAt", "build", "connection", "recording", "sync", "backlog", "pendant", "phone",
            "incidents", "wakes", "droppedMessages", "timeZone",
        ])
    #expect(heartbeat.connection.state == "disconnected")
    #expect(heartbeat.connection.disconnectReason == "link_lost")
    #expect(heartbeat.recording.state == "failed")
    #expect(heartbeat.recording.lastKnown == "recording")
    #expect(heartbeat.sync == "failed")
    #expect(heartbeat.incidents == ["integrity_conflict", "storage_write_failed"])
    #expect(heartbeat.backlog?.estimatedSeconds == 90)
    #expect(heartbeat.pendant.freePages == 900)
    // The wake a day ago is outside the window.
    #expect(heartbeat.wakes.last24h == 1)
    #expect(heartbeat.wakes.pagesSaved24h == 30)
}

private struct TestFrame: StackFrame {
    var binaryUUID: UUID?
    var address: UInt64?
    var offsetIntoBinaryTextSegment: UInt64?
    var sampleCount: Int?
    var subFrames: [TestFrame] = []

    init(_ binary: UUID, _ offset: UInt64, _ subFrames: [TestFrame] = []) {
        binaryUUID = binary
        offsetIntoBinaryTextSegment = offset
        address = 0x1_0000_0000 + offset
        self.subFrames = subFrames
    }
}

private let app = UUID()
private let kernel = UUID()

private func crash(threads: [RawDiagnostic<TestFrame>.Thread]) -> RawDiagnostic<TestFrame> {
    let exception = RawDiagnostic<TestFrame>.ObjCException(
        name: "NSRangeException", type: "NSException", className: "NSArray",
        formatString: "*** index %lu beyond bounds", composedMessage: "Lunch with Clara at Home, index 3",
        arguments: ["Clara"])
    return RawDiagnostic(
        detail: .crash(
            .init(
                exceptionType: 1, exceptionCode: 0, signal: 6, terminationReason: "Namespace SIGNAL, Code 6",
                terminationCategory: "abnormal", virtualMemoryRegionInfo: "region near secret-mapping",
                objcException: exception)),
        build: build, begin: now, end: now, threads: threads, binaryNames: [app: "lifelog", kernel: "libsystem_kernel"])
}

@Test func diagnosticKeepsCallStacksAndDropsPrivateText() throws {
    let tree = TestFrame(kernel, 0x10, [TestFrame(app, 0x20, [TestFrame(app, 0x30)]), TestFrame(app, 0x40)])
    let upload = DiagnosticUpload(
        crash(threads: [
            .init(attributed: false, rootFrames: [TestFrame(app, 0x99)]), .init(attributed: true, rootFrames: [tree]),
        ]))
    let text = try json(upload)

    for secret in ["Clara", "Home", "secret-mapping"] { #expect(!text.contains(secret)) }
    #expect(text.contains("beyond bounds"))
    #expect(upload.kind == .crash)
    #expect(upload.crash?.signal == 6)
    #expect(!upload.truncated)
    // The attributed thread first, flattened depth-first with binary names.
    let attributed = try #require(upload.callStacks.first)
    #expect(attributed.threadAttributed)
    #expect(attributed.frames.map(\.depth) == [0, 1, 2, 1])
    #expect(attributed.frames.map(\.offsetIntoBinaryTextSegment) == [0x10, 0x20, 0x30, 0x40])
    #expect(attributed.frames.map(\.binaryName) == ["libsystem_kernel", "lifelog", "lifelog", "lifelog"])
    #expect(attributed.frames.first?.binaryUUID == kernel.uuidString)
    #expect(Set(upload.binaries.map(\.uuid)) == [app.uuidString, kernel.uuidString])
}

@Test func framesPastTheBudgetAreDroppedAndFlagged() {
    let wide = (0...UInt64(DiagnosticUpload.frameBudget)).map { TestFrame(app, $0) }
    let upload = DiagnosticUpload(
        crash(threads: [.init(attributed: true, rootFrames: wide), .init(attributed: false, rootFrames: wide)]))
    #expect(upload.truncated)
    #expect(upload.callStacks.map(\.frames.count) == [DiagnosticUpload.frameBudget])
}

@Test func heartbeatsAreDueEverySixHoursOncePerEventOnEachPendantChangeAndOnANewTimeZone() {
    var schedule = HeartbeatSchedule()
    var status = CaptureStatus()
    status.connection = .ready(pendantID)
    status.recording = .recording(confirmedAt: now)
    status.lastKnownRecording = Observed(.recording, at: now)
    let hour: TimeInterval = 3600
    var zone = TimeZone(identifier: "Asia/Jakarta")!
    func due(_ at: TimeInterval, free: Int64? = 1 << 34) -> Heartbeat.Reason? {
        schedule.due(status, phoneFreeBytes: free, now: now.addingTimeInterval(at), timeZone: zone)
    }

    #expect(due(0) == .periodic)
    #expect(due(hour) == nil)
    #expect(due(6 * hour) == .periodic)

    status.incidents = [.storageWriteFailed("x")]
    #expect(due(6 * hour + 1) == .writeFailure)
    #expect(due(6 * hour + 2) == nil)
    status.incidents = []
    #expect(due(6 * hour + 3, free: 1 << 20) == .storageIncident)
    #expect(due(6 * hour + 4, free: 1 << 20) == nil)

    // Out of reach and back: each sent at once; the steps between connected and not are neither.
    status.connection = .disconnected(pendantID, .linkLost(nil))
    #expect(due(7 * hour) == .disconnect)
    #expect(due(7 * hour + 10) == nil)
    status.connection = .connecting(pendantID)
    #expect(due(7 * hour + 20) == nil)
    // Back, with recording unknown until the Pendant says (a lost link resets it): the last known stands, so its
    // first word, the same, is not sent again.
    status.connection = .ready(pendantID)
    status.recording = .unknown
    #expect(due(7 * hour + 30) == .disconnect)
    status.recording = .recording(confirmedAt: now)
    status.lastKnownRecording = Observed(.recording, at: now.addingTimeInterval(7 * hour + 35))
    #expect(due(7 * hour + 40) == nil)

    // Paused, then on again: each sent once confirmed; the request alone and newer telemetry saying the same are not.
    status.recording = .pauseRequested(pendingSince: now)
    #expect(due(8 * hour) == nil)
    status.recording = .paused(confirmedAt: now)
    status.lastKnownRecording = Observed(.paused, at: now.addingTimeInterval(8 * hour))
    #expect(due(8 * hour + 10) == .recording)
    status.lastKnownRecording = Observed(.paused, at: now.addingTimeInterval(8 * hour + 15))
    #expect(due(8 * hour + 20) == nil)
    status.recording = .recording(confirmedAt: now)
    status.lastKnownRecording = Observed(.recording, at: now.addingTimeInterval(8 * hour + 25))
    #expect(due(8 * hour + 30) == .recording)

    // A restart neither repeats nor forgets: the schedule survives in UserDefaults as JSON.
    schedule = try! JSONDecoder().decode(HeartbeatSchedule.self, from: JSONEncoder().encode(schedule))
    #expect(due(8 * hour + 40) == nil)
    status.connection = .bluetoothOff
    #expect(due(8 * hour + 50) == .disconnect)

    // A new time zone is sent at once.
    zone = TimeZone(identifier: "Europe/Berlin")!
    #expect(due(8 * hour + 60) == .periodic)
    #expect(due(8 * hour + 70) == nil)
}

@Test func aScheduleSavedByAnOlderBuildSendsNothingExtra() throws {
    let saved = #"{"lastSent":0,"lastZone":"Asia/Jakarta","outageReported":false,"problems":[],"recording":true}"#
    var schedule = try JSONDecoder().decode(HeartbeatSchedule.self, from: Data(saved.utf8))
    var status = CaptureStatus()
    status.connection = .ready(pendantID)
    let at = Date(timeIntervalSinceReferenceDate: 60)
    #expect(schedule.due(status, phoneFreeBytes: nil, now: at, timeZone: TimeZone(identifier: "Asia/Jakarta")!) == nil)
}

@Test func outboxSendsUrgentFirstInLowPowerBacksOffAndDropsRejected() async throws {
    let directory = URL.temporaryDirectory.appending(path: "outbox-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = HealthOutbox(directory: directory)
    try await outbox.enqueue(["a": 1], path: "diagnostics", urgent: true, now: now)
    try await outbox.enqueue(["b": 2], path: "health/heartbeat", urgent: false, now: now)

    let sent = Sent()
    #expect(await outbox.flush(lowPowerMode: true, now: now) { path, _ in await sent.add(path, .delivered) } == 1)
    #expect(await sent.paths == ["diagnostics"])

    #expect(await outbox.flush(lowPowerMode: false, now: now) { path, _ in await sent.add(path, .retry) } == 1)
    // Backing off: nothing goes before the minute is up.
    #expect(
        await outbox.flush(lowPowerMode: false, now: now.addingTimeInterval(30)) { path, _ in
            await sent.add(path, .retry)
        } == 1)
    #expect(await sent.paths == ["diagnostics", "health/heartbeat"])
    let left = await outbox.flush(lowPowerMode: false, now: now.addingTimeInterval(61)) { path, _ in
        await sent.add(path, .rejected)
    }
    #expect(left == 0)
    #expect(await sent.paths == ["diagnostics", "health/heartbeat", "health/heartbeat"])
}

private actor Sent {
    var paths: [String] = []
    var bodies: [Data] = []

    func add(_ path: String, _ delivery: HealthOutbox.Delivery) -> HealthOutbox.Delivery {
        paths.append(path)
        return delivery
    }

    func add(_ body: Data) { bodies.append(body) }
}

@Test func repeatedErrorsWithinAnHourAreOneReportWithACount() async throws {
    let directory = URL.temporaryDirectory.appending(path: "outbox-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = HealthOutbox(directory: directory)
    let reporter = ErrorReporter(outbox: outbox, build: build)
    func error(line: Int = 127) -> DiagnosticUpload.AppError {
        .init(
            file: "Lifelog/Library/LibraryListStore.swift", line: line, type: "URLError", domain: "NSURLErrorDomain",
            code: -1009, httpStatus: nil, serverCode: nil, message: String(repeating: "offline ", count: 100))
    }
    let stack = Thread.callStackReturnAddresses.map(\.uintValue)
    let sent = Sent()
    func flush(at offset: TimeInterval) async -> Int {
        await outbox.flush(lowPowerMode: false, now: now.addingTimeInterval(offset)) { _, body in
            await sent.add(body)
            return .delivered
        }
    }
    func bodies() async -> [[String: Any]] {
        await sent.bodies.map { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any]) ?? [:] }
    }
    func counts() async -> [Int] {
        await bodies().map { (($0["error"] as? [String: Any])?["count"] as? Int) ?? 0 }
    }
    func ids() async -> [String] { await bodies().map { $0["id"] as? String ?? "" } }

    #expect(try await reporter.record(error(), returnAddresses: stack, now: now))
    #expect(try await !reporter.record(error(), returnAddresses: stack, now: now.addingTimeInterval(60)))
    #expect(try await !reporter.record(error(), returnAddresses: stack, now: now.addingTimeInterval(120)))
    #expect(try await reporter.record(error(line: 140), returnAddresses: stack, now: now.addingTimeInterval(130)))
    #expect(await flush(at: 200) == 0)
    #expect(await counts() == [3, 1])
    // Delivered, then repeated: sent again under the same id, with the higher count.
    try await reporter.record(error(), returnAddresses: stack, now: now.addingTimeInterval(600))
    #expect(await flush(at: 700) == 0)
    #expect(await counts() == [3, 1, 4])
    #expect(await ids()[0] == ids()[2])
    // A new hour, a new report.
    #expect(try await reporter.record(error(), returnAddresses: stack, now: now.addingTimeInterval(3601)))
    #expect(await flush(at: 3700) == 0)
    #expect(await counts().last == 1)
    #expect(await ids().last != ids()[0])

    let first = try #require(await bodies().first)
    #expect(first["kind"] as? String == "app_error")
    #expect(((first["error"] as? [String: Any])?["message"] as? String)?.count == 300)
    // The catch site's stack, resolved like MetricKit's frames: binary, UUID, and an offset into it.
    let frames = try #require((first["callStacks"] as? [[String: Any]])?.first?["frames"] as? [[String: Any]])
    let top = try #require(frames.first)
    #expect(top["binaryUUID"] is String)
    #expect((top["offsetIntoBinaryTextSegment"] as? Int ?? .max) <= (top["address"] as? Int ?? 0))
    #expect(!((first["binaries"] as? [Any]) ?? []).isEmpty)
}

@Test func aReportRewrittenWhileOutIsSentAgain() async throws {
    let directory = URL.temporaryDirectory.appending(path: "outbox-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = HealthOutbox(directory: directory)
    try await outbox.enqueue(["count": 1], path: "diagnostics", urgent: false, replacing: "k", now: now)
    let left = await outbox.flush(lowPowerMode: false, now: now) { _, _ in
        try? await outbox.enqueue(["count": 2], path: "diagnostics", urgent: false, replacing: "k", now: now)
        return .delivered
    }
    #expect(left == 1)
}

@Test func eventsPastTheirLimitWaitForTheNextWindow() async throws {
    let directory = URL.temporaryDirectory.appending(path: "events-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = HealthOutbox(directory: directory)
    let reporter = EventReporter(outbox: outbox)
    for _ in 0..<EventReporter.limit {
        #expect(try await reporter.record("activity.content_update", ["macDictating": "true"], now: now))
    }
    #expect(try await !reporter.record("activity.content_update", [:], now: now.addingTimeInterval(1)))
    #expect(try await reporter.record("activity.started", [:], now: now.addingTimeInterval(1)))
    #expect(
        try await reporter.record("activity.content_update", [:], now: now.addingTimeInterval(EventReporter.window)))

    let sent = Sent()
    await outbox.flush(lowPowerMode: false, now: now.addingTimeInterval(EventReporter.window)) { path, body in
        await sent.add(body)
        return await sent.add(path, .delivered)
    }
    #expect(await sent.paths == Array(repeating: "events", count: EventReporter.limit + 2))
    let first = try #require(await sent.bodies.first)
    let event = try #require(try JSONSerialization.jsonObject(with: first) as? [String: Any])
    #expect(Set(event.keys) == ["id", "at", "name", "fields"])
    #expect(event["fields"] as? [String: String] == ["macDictating": "true"])
}
