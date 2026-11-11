@testable import AudioPipeline
import Capture
import Foundation
import Library
import PendantProtocol
@testable import ServerAPI
import SourceStore
import Synchronization
import Testing
import Timeline
@testable import Upload

// MARK: Where a fragment ends

/// One page per second from `seconds`, each a run of 50 packets: page `n` plays at `at(n)`.
private func runs(_ seconds: Range<Int>, page: (Int) -> UInt64 = { UInt64($0) }) -> [PlacedRun] {
    seconds.map { PlacedRun(page: page($0), packets: 0..<50, start: at(Double($0))) }
}

private func instants(_ seconds: [Range<Double>]) -> [Range<CaptureInstant>] {
    seconds.map { at($0.lowerBound)..<at($0.upperBound) }
}

/// The next fragment of the one-second pages `0..<pages`; `speech` is `kept` unless given.
private func next(_ kept: [Range<Double>], speech: [Range<Double>]? = nil, pages: Int, heard: Double?)
    -> SpeechFragment?
{
    SpeechFragment.next(
        kept: instants(kept), runs: runs(0..<pages), speech: instants(speech ?? kept), heardThrough: heard.map(at))
}

@Test func aFragmentEndsAtTheLastPauseAndSpeechStillGoingOnWaits() throws {
    // Talk, a 5 s pause, talk still going on: the first stretch goes, through the pages of the pause.
    let first = try #require(next([0..<10, 15..<30], pages: 30, heard: 28))
    #expect(first.segments == instants([0..<10]))
    #expect(first.pages == [0...9])
    #expect(first.last == 14, "the pause's pages go with it: nothing on them to send")
    #expect(next([0..<30], pages: 30, heard: 28) == nil, "speech still going on")
    #expect(next([0..<30], pages: 30, heard: nil) == nil, "nothing heard yet")
    // The Pendant vouches for the quiet after the last page it pushed: everything goes, the last page too.
    let all = try #require(next([0..<10, 15..<30], pages: 30, heard: 30))
    #expect(all.pages == [0...9, 15...29] && all.last == 29)
}

@Test func aLongStretchIsCutInsideItsLatestQuietSecondOnceAMinuteWaits() throws {
    // A stretch with no pause; the analyzers hear no speech from 20 to 22 s and from 70 to 72 s.
    let speech: [Range<Double>] = [0..<20, 22..<70, 72..<100]
    #expect(next([0..<100], speech: speech, pages: 50, heard: 40) == nil, "under a minute waits")
    #expect(next([0..<100], speech: speech, pages: 65, heard: 55)?.last == 20, "a minute: the latest quiet second")
    let cut = try #require(next([0..<100], speech: speech, pages: 100, heard: 95))
    #expect(cut.last == 70 && cut.segments == instants([0..<71]), "inside the second, never at speech's edge")
    // Speech in every second: cut at 90 s anyway.
    #expect(next([0..<100], pages: 100, heard: 95)?.segments == instants([0..<90]))
}

@Test func theSilenceBetweenTwoHeldPagesIsNotKeptAudio() {
    // Oct 15, the old flash session: an old job holds pages 0 to 9, with 0.76 s of silence inside their span between
    // pages 1 and 2 (683970 and 683971 on the phone); free pages 10 to 14 after them hold no speech.
    let shifted = (2..<15).map { PlacedRun(page: UInt64($0), packets: 0..<50, start: at(Double($0) + 0.76)) }
    let free = SpeechFragment.unheld(kept: [at(0)..<at(10.76)], runs: runs(0..<2) + shifted) { $0 < 10 }
    #expect(free.kept.isEmpty, "no free page plays in it")
    #expect(free.runs.map(\.page) == Array(10..<15))
    #expect(SpeechFragment.next(kept: free.kept, runs: free.runs, speech: [], heardThrough: at(100)) == nil)
}

@Test func heldPagesAreTakenOutWithTheirAudio() throws {
    // Pages 5 to 9 are held (an old part, or behind the cursor): a fragment never holds them, nor their seconds.
    let free = SpeechFragment.unheld(kept: [at(0)..<at(20)], runs: runs(0..<20)) { (5...9).contains($0) }
    #expect(free.kept == [at(0)..<at(5), at(10)..<at(20)])
    #expect(free.runs.map(\.page) == Array(0..<5) + Array(10..<20))
    let fragment = try #require(
        SpeechFragment.next(kept: free.kept, runs: free.runs, speech: free.kept, heardThrough: at(100)))
    #expect(fragment.pages == [0...4, 10...19])
}

// MARK: Server

/// A server for the rebuild's routes, one state per host so tests run in parallel. Each request is recorded;
/// `failures` answers a path with these statuses in turn (0: the connection drops).
final class RebuildServer: URLProtocol {
    struct Host {
        var requests: [(method: String, path: String, body: Data, sha: String?)] = []
        var held = #"{"handedOver":true,"blocks":[]}"#
        var backup = #"{"packs":[]}"#
        var feed = #"{"cursor":"1","more":false}"#
        var failures: [String: [Int]] = [:]
        /// The code a 409 answers with.
        var conflict = "held"
        /// Paths whose answer waits until they leave this set, as a long upload does.
        var holds: Set<String> = []
    }

    static let hosts = Mutex<[String: Host]>([:])

    static func client(_ host: String) -> ServerClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RebuildServer.self]
        return ServerClient(
            server: { URL(string: "https://\(host)") }, session: URLSession(configuration: configuration)
        ) {
            "t"
        }
    }

    static func requests(_ host: String, _ method: String, _ prefix: String) -> [(path: String, body: Data)] {
        hosts.withLock { $0[host]?.requests ?? [] }.filter { $0.method == method && $0.path.hasPrefix(prefix) }
            .map { ($0.path, $0.body) }
    }

    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let host = request.url?.host() ?? ""
        let path = request.url?.path() ?? ""
        let method = request.httpMethod ?? "GET"
        let body = requestBody(request)
        let sha = request.value(forHTTPHeaderField: "X-Content-Sha256")
        let hold = Self.hosts.withLock { hosts in
            hosts[host, default: Host()].requests.append((method, path, body, sha))
            return hosts[host]?.holds.contains(path) == true
        }
        guard hold else { return answer(host, path, method) }
        // URLProtocol isn't Sendable; this one is touched again only once the wait ends.
        nonisolated(unsafe) let server = self
        DispatchQueue.global().async {
            while Self.hosts.withLock({ $0[host]?.holds.contains(path) == true }) {
                Thread.sleep(forTimeInterval: 0.01)
            }
            server.answer(host, path, method)
        }
    }

    private func answer(_ host: String, _ path: String, _ method: String) {
        let (failure, held, feed, backup, conflict) = Self.hosts.withLock { hosts in
            let failure = hosts[host]?.failures[path]?.first
            if failure != nil { hosts[host]?.failures[path]?.removeFirst() }
            let host = hosts[host] ?? Host()
            return (failure, host.held, host.feed, host.backup, host.conflict)
        }
        if failure == 0 { return client!.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) }
        let status = failure ?? 200
        let answer: String
        if status == 409 {
            answer = #"{"error":"\#(conflict)","message":"wait"}"#
        } else if status != 200 {
            answer = #"{"error":"refused","message":"no such conversation"}"#
        } else if method == "GET", path.hasSuffix("/blocks") {
            answer = held
        } else if method == "GET", path == "/changes" {
            answer = feed
        } else if method == "GET", path.hasPrefix("/backup/") {
            answer = backup
        } else {
            answer = "{}"
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client!.urlProtocol(self, didLoad: Data(answer.utf8))
        client!.urlProtocolDidFinishLoading(self)
    }

    /// The id the server gives the fragment starting at `page`.
    static func fragment(_ page: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", page) }
}

private func json(_ data: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// The JSON metadata part of a fragment upload.
private func metadata(_ body: Data) throws -> [String: Any] {
    let text = String(decoding: body, as: UTF8.self)
    let start = try #require(text.firstRange(of: "application/json\r\n\r\n")).upperBound
    let end = try #require(text[start...].firstRange(of: "\r\n--")).lowerBound
    return try json(Data(text[start..<end].utf8))
}

/// A fragment upload's map segments.
private func segments(_ body: Data) throws -> [[Int64]]? {
    (try metadata(body)["map"] as? [String: Any])?["segments"] as? [[Int64]]
}

private func seconds(_ value: Any?) throws -> Double {
    let text = try #require(value as? String)
    return Double(
        CaptureInstant(try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)).millis - base)
        / 1000
}

/// The feed's row saying the server withdrew the fragment starting at `page`.
private func withdrawal(_ page: Int) -> String {
    #"{"kind":"job","ref":"\#(RebuildServer.fragment(page))","firstPage":\#(page),"sourceId":"pendant-1"}"#
}

/// A feed page bringing the Mac's dictation over `range`, and the fragments the server withdrew.
private func dictationPage(_ range: Range<CaptureInstant>, withdrawn: [Int] = []) -> String {
    let id = UUID().uuidString.lowercased()
    let (start, end) = (range.lowerBound.date.formatted(.iso8601), range.upperBound.date.formatted(.iso8601))
    let removed = withdrawn.map(withdrawal).joined(separator: ",")
    return #"""
        {"cursor":"\#(id)","more":false,"quietRanges":[{"id":"\#(id)","startedAt":"\#(start)","endedAt":"\#(end)"}],
         "removed":[\#(removed)]}
        """#
}

/// The feed bringing the Mac's dictation over `range` into the library.
private func dictation(_ range: Range<CaptureInstant>, into library: LibraryStore) async throws {
    try await library.apply(feed: Data(dictationPage(range).utf8)) { _ in }
}

/// The uploader over a scanner fixture, against `RebuildServer` at `host`.
private func makeUploader(
    _ fixture: ScannerFixture, host: String, configuration: Uploader.Configuration = .init(),
    event: @escaping AppEvent = { _, _ in }
) throws -> Uploader {
    try Uploader(
        source: fixture.source, scanner: try fixture.scanner(), client: RebuildServer.client(host),
        directory: fixture.directory.appending(path: "upload"), configuration: configuration,
        canRunHeavyWork: { true }, event: event)
}

// MARK: Timeline facts

@Test func theTimelineSendsEachSpanWithItsFactsOnceAndAgainWhenTheClockMovesIt() async throws {
    let host = "facts-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<5)
    try await fixture.store(5..<10, shift: 100)
    try await fixture.source.recordRecordingChange(RecordingChange(.paused, at: at(50)), deviceID: "pendant-1")
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(300).date)

    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/timeline")
    #expect(sent.count == 1)
    let body = try json(try #require(sent.first).body)
    #expect(try seconds(body["heardThrough"]) == 300)
    #expect(try seconds(body["sentThrough"]) == 300, "every kept second is sent")
    let spans = try #require(body["spans"] as? [[String: Any]])
    #expect(spans.map { $0["firstPage"] as? Int } == [0, 5])
    #expect(try seconds(spans[1]["startAt"]) == 105)
    #expect((spans[1]["speech"] as? [[String]])?.count == 1)
    #expect((spans[1]["breaks"] as? [[String: String]])?.first?["kind"] == "timeGap")
    #expect((spans[1]["pauses"] as? [[String: String]])?.count == 1, "the pause in the quiet before it")
    #expect((spans[0]["pauses"] as? [[String: String]])?.isEmpty == true)

    // Nothing new: nothing sent.
    try await uploader.run(savedThrough: at(300).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/timeline").count == 1)

    // A clock sync shows the Pendant ran 2 s fast: both spans go again, 2 s earlier.
    try await fixture.source.recordClockSync(
        ClockSync(firstPageIndex: 10, phoneMillis: base + 400_000, deviceMillisBeforeSet: base + 402_000),
        deviceID: "pendant-1")
    try await uploader.run(savedThrough: at(300).date)
    let again = try json(try #require(RebuildServer.requests(host, "PUT", "/sources/pendant-1/timeline").last).body)
    let moved = try #require(again["spans"] as? [[String: Any]])
    #expect(moved.count == 2)
    #expect(try seconds(moved[1]["startAt"]) == 103)
}

// MARK: Uploader

@Test func speechGoesUpOnceAsAFragmentAroundTheDictationAndNeverAgainAfterACrashARestartOrAReinstall()
    async throws
{
    let host = "fragments-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    // Five seconds, then a minute two minutes later with a dictation in it, then five seconds more.
    try await fixture.store(0..<5)
    try await fixture.store(5..<65, shift: 100)
    try await fixture.store(65..<70, shift: 200)
    try await dictation(at(120)..<at(130), into: fixture.library)
    RebuildServer.hosts.withLock { $0[host, default: .init()].failures["/sources/pendant-1/speech/0"] = [0] }

    var uploader = try makeUploader(fixture, host: host)
    let upload = fixture.directory.appending(path: "upload")
    #expect(try upload.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    // The upload loses its connection (the server may have it or not); the next run sends the same again.
    await #expect(throws: URLError.self) { try await uploader.run(savedThrough: at(400).date) }
    try await uploader.run(savedThrough: at(400).date)
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.map(\.path) == ["/sources/pendant-1/speech/0", "/sources/pendant-1/speech/0"])
    let first = try metadata(sent[1].body)
    #expect(first["pages"] as? [[Int]] == [[0, 19], [30, 69]], "the dictation's pages are in no fragment")
    #expect(try metadata(sent[0].body)["audioSha256"] as? String == first["audioSha256"] as? String, "the same one")
    #expect(
        try segments(sent[1].body) == [
            [base, base + 5_000], [base + 105_000, base + 120_000], [base + 130_000, base + 165_000],
            [base + 265_000, base + 270_000],
        ])
    #expect((first["map"] as? [String: Any])?["separatorMs"] as? Int == 400)
    #expect(try await uploader.status() == UploadStatus())

    // A relaunch sends nothing again.
    uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 2)

    // A reinstall: the cursor starts over around the server's pages, and nothing goes up twice.
    try FileManager.default.removeItem(at: upload)
    let fragment = RebuildServer.fragment(0)
    RebuildServer.hosts.withLock {
        $0[host]?.held = #"{"handedOver":true,"blocks":[{"jobId":"\#(fragment)","pages":[[0,19],[30,69]]}]}"#
    }
    let reinstalled = try makeUploader(fixture, host: host)
    try await reinstalled.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 2)
    // This install never sent it: the feed's row alone sends its pages again once it is withdrawn.
    RebuildServer.hosts.withLock { $0[host]?.held = #"{"handedOver":true,"blocks":[]}"# }
    try await reinstalled.withdrawn([("pendant-1", 0)])
    try await reinstalled.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 3)
}

/// 23 Oct: a new iPhone, migrated from the old one. Its timeline came along; its derived files and upload state are kept
/// out of backups and did not, and an older build had handed over at page 0. Every run read a lost sidecar and threw.
@Test func aMigratedPhoneResumesFromTheServersSentThroughAndNeverReadsTheHistoryItLost() async throws {
    let host = "migrated-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(5..<65, shift: 100)
    _ = try await fixture.scanner().scan()
    // Pages stored below ones already scanned leave the scanner's marker, which would rewind the cursor to them.
    try await fixture.store(0..<5)
    for name in try fixture.derived.sidecarFiles(deviceID: "pendant-1").map(\.name)
    where Int(name.prefix { $0.isNumber }) ?? 0 < 5 {
        try FileManager.default.removeItem(at: fixture.derived.directory("pendant-1").appending(path: name))
    }
    // The upload state an older build's handover left: the cursor at page 0.
    let upload = fixture.directory.appending(path: "upload")
    try FileManager.default.createDirectory(at: upload, withIntermediateDirectories: true)
    let old = try SQLite(path: upload.appending(path: "upload.sqlite").path)
    try old.migrate(Array(Uploader.migrations.dropLast()), tooNew: { _ in CancellationError() })
    try old.execute("INSERT INTO sources VALUES ('pendant-1', 0, NULL)")
    // The old phone sent or decided everything before page 5.
    RebuildServer.hosts.withLock {
        $0[host, default: .init()].held =
            #"{"handedOver":true,"blocks":[],"sentThrough":"\#(at(105).date.ISO8601Format())"}"#
    }

    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").map(\.path)
    #expect(sent.first == "/sources/pendant-1/speech/5")
    #expect(sent.allSatisfy { Int($0.split(separator: "/").last ?? "") ?? 0 >= 5 })
    #expect(try await uploader.status()?.lastError == nil)
}

/// A span begun before the server's `sentThrough` keeps the facts the last install sent: its lost files are never read.
@Test func aSpanBegunBeforeTheServersSentThroughIsNotReadAgain() async throws {
    let host = "straddle-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    // One span, two jobs' sidecars: the first lost, sentThrough inside the second.
    try await fixture.store(0..<65)
    try await fixture.store(65..<130)
    let names = try fixture.derived.sidecarFiles(deviceID: "pendant-1").map(\.name)
        .sorted { Int($0.prefix { $0.isNumber }) ?? 0 < Int($1.prefix { $0.isNumber }) ?? 0 }
    #expect(names.count > 1)
    let last = try #require(names.last.flatMap { UInt64($0.prefix { $0.isNumber }) })
    for name in names.dropLast() {
        try FileManager.default.removeItem(at: fixture.derived.directory("pendant-1").appending(path: name))
    }
    RebuildServer.hosts.withLock {
        $0[host, default: .init()].held =
            #"{"handedOver":true,"blocks":[],"sentThrough":"\#(at(Double(last) + 40).date.ISO8601Format())"}"#
    }
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    #expect(try await uploader.status()?.lastError == nil)
}

/// A new phone whose timeline doesn't reach the server's `sentThrough` yet waits, rather than start below it.
@Test func aNewPhoneWaitsUntilItsTimelineReachesTheServersSentThrough() async throws {
    let host = "waits-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<5)
    RebuildServer.hosts.withLock {
        $0[host, default: .init()].held =
            #"{"handedOver":true,"blocks":[],"sentThrough":"\#(at(105).date.ISO8601Format())"}"#
    }
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    #expect(try await uploader.status() == nil, "no cursor saved")
    try await fixture.store(5..<65, shift: 100)
    try await uploader.run(savedThrough: at(400).date)
    #expect(
        RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").first?.path == "/sources/pendant-1/speech/5")
}

/// Removes the device's sidecars whose first page `isLost` picks, as a lost `derived/` does.
private func lose(_ fixture: ScannerFixture, where isLost: (UInt64) -> Bool) throws {
    for name in try fixture.derived.sidecarFiles(deviceID: "pendant-1").map(\.name) {
        guard let pages = DerivedAudioDirectory.pages(ofSidecar: name), isLost(pages.lowerBound) else { continue }
        try FileManager.default.removeItem(at: fixture.derived.sidecarURL("pendant-1", pages: pages))
    }
}

/// A sidecar lost past the cursor is rebuilt from the packs; until then its audio is unanalyzed and the speech waits.
@Test func aSidecarLostPastTheCursorIsRebuiltAndTheSpeechWaitsForIt() async throws {
    let host = "lost-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    try lose(fixture) { _ in true }

    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").isEmpty, "nothing judged unlabelled")
    #expect(try await uploader.status()?.lastError == nil)
    #expect(try await fixture.source.queuedJobs(deviceID: "pendant-1").isEmpty == false, "its rebuild queued")

    let scanner = try fixture.scanner()
    await fixture.worker.run { try await scanner.index($0) }
    try await fixture.label(speech: [-1e9..<1e9])
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 1)
}

/// A rebuild that fails for good lifts the wait: the audio goes as unanalyzed, never held forever.
@Test func aRebuildThatFailsForGoodNeverHoldsTheSpeech() async throws {
    let host = "failed-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<30)
    try await fixture.store(30..<60)
    try lose(fixture) { $0 < 30 }
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    while let job = try await fixture.source.claimJob(now: .distantFuture) {
        try await fixture.source.failJob(job.id, error: "unreadable", now: .now)
    }
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 1)
}

/// A sidecar lost just below the cursor (read for the kept margin) never stops what comes after.
@Test func aSidecarLostBelowTheCursorNeverStopsTheSpeechAfterIt() async throws {
    let host = "below-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 1)
    try lose(fixture) { $0 < 60 }
    try await fixture.store(60..<120)
    try await uploader.run(savedThrough: at(400).date)
    #expect(try await uploader.status()?.lastError == nil)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 2)
}

/// Facts owed from far back (re-indexing moves them) never widen the rebuild below the cursor: a lost archive stays
/// unrebuilt, and new pages' jobs never wait behind it.
@Test func lostSidecarsBelowTheCursorAreNeverRebuiltWhateverTheFactsOwed() async throws {
    let host = "archive-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    try lose(fixture) { $0 < 60 }
    try await fixture.store(60..<120)
    try await fixture.scanner().startFacts(from: CaptureInstant(millis: .min))
    try await uploader.run(savedThrough: at(400).date)
    try await uploader.run(savedThrough: at(400).date)
    #expect(try await fixture.source.queuedJobs(deviceID: "pendant-1").filter { $0.lowerBound < 60 }.isEmpty)
}

/// A span begun before the server's `sentThrough` that this phone appends to never stops the run: its lost files read as
/// unanalyzed.
@Test func aSpanBegunBeforeTheServersSentThroughAndAppendedToNeverStopsTheRun() async throws {
    let host = "appended-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<65)
    try await fixture.store(65..<130)
    try lose(fixture) { $0 < 65 }
    RebuildServer.hosts.withLock {
        $0[host, default: .init()].held =
            #"{"handedOver":true,"blocks":[],"sentThrough":"\#(at(105).date.ISO8601Format())"}"#
    }
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    try await fixture.store(130..<195)
    try await uploader.run(savedThrough: at(400).date)
    #expect(try await uploader.status()?.lastError == nil)
}

/// The same night: the run threw on every pass and the app said "Up to date, nothing waits".
@Test func aRunThatStopsSaysWhyUntilARunEnds() async throws {
    let host = "stopped-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    let directory = fixture.derived.directory("pendant-1")
    let names = try fixture.derived.sidecarFiles(deviceID: "pendant-1").map(\.name)
    let kept = try names.map { try Data(contentsOf: directory.appending(path: $0)) }
    for name in names { try Data("not json".utf8).write(to: directory.appending(path: name)) }

    let uploader = try makeUploader(fixture, host: host)
    await #expect(throws: (any Error).self) { try await uploader.run(savedThrough: at(400).date) }
    #expect(try await uploader.status()?.lastError != nil)

    for (name, data) in zip(names, kept) { try data.write(to: directory.appending(path: name)) }
    try await uploader.run(savedThrough: at(400).date)
    #expect(try await uploader.status()?.lastError == nil)
}

@Test func theBlocksBuildsStateBecomesOneCursorAtTheFirstBlockNeverSent() async throws {
    let fixture = try ScannerFixture()
    let directory = fixture.directory.appending(path: "upload")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // The blocks build's database: a covered block, a block with its job, one never sent, and the cursor past them.
    let old = try SQLite(path: directory.appending(path: "upload.sqlite").path)
    try old.migrate(Array(Uploader.migrations.prefix(1)), tooNew: UploadError.unknownSchemaVersion)
    _ = try old.run("INSERT INTO sources VALUES ('pendant-1', 90, NULL)")
    let job = UUID()
    for (page, json) in [
        (5, #"{"covered":true}"#), (10, #"{"jobID":"\#(job)","covered":false}"#), (50, #"{"covered":false}"#),
    ] {
        _ = try old.run(
            "INSERT INTO blocks VALUES ('pendant-1', ?1, 0, 0, 1, ?2)", [.int(Int64(page)), .blob(Data(json.utf8))])
    }
    let uploader = try makeUploader(fixture, host: "migrated-\(UUID().uuidString).test")
    #expect(try await uploader.state()?.nextPage == 50, "the unsent block's pages go up as fragments")
    for table in ["blocks", "fragments"] {
        #expect(throws: (any Error).self) { try old.run("SELECT * FROM \(table)") }
    }
}

@Test func afterTheHandoverSpeechNoOldPartHoldsGoesUpAroundTheirPages() async throws {
    let host = "backlog-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    // A minute, five seconds two hours later, five more two hours after that.
    try await fixture.store(0..<60)
    try await fixture.store(60..<65, shift: 7_200)
    try await fixture.store(65..<70, shift: 14_400)
    // The old app transcribed pages 10 to 29 and the five seconds at two hours; the rest never went up.
    RebuildServer.hosts.withLock {
        $0[host, default: .init()].held = """
            {"handedOver":true,"blocks":[{"jobId":"\(RebuildServer.fragment(10))","pages":[[10,29]]},{"jobId":"\(RebuildServer.fragment(60))","pages":[[60,64]]}]}
            """
    }
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(15_000).date)
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.map(\.path) == ["/sources/pendant-1/speech/0", "/sources/pendant-1/speech/65"])
    let old = try metadata(try #require(sent.first).body)
    #expect(old["pages"] as? [[Int]] == [[0, 9], [30, 59]], "the old part's pages are in no fragment")
    #expect(try segments(sent[0].body) == [[base, base + 10_000], [base + 30_000, base + 60_000]], "nor their audio")
}

@Test func aFragmentTheServerRefusesAsHeldGoesAgainWithoutTheHeldPages() async throws {
    let host = "held-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    try await fixture.store(0..<60)
    // Another install already sent pages 0 to 29: the refusal reads the server's pages again.
    let other = RebuildServer.fragment(1)
    RebuildServer.hosts.withLock {
        $0[host]?.failures["/sources/pendant-1/speech/0"] = [409]
        $0[host]?.held = #"{"handedOver":true,"blocks":[{"jobId":"\#(other)","pages":[[0,29]]}]}"#
    }
    try await uploader.run(savedThrough: at(400).date)
    try await uploader.run(savedThrough: at(400).date)
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.map(\.path) == ["/sources/pendant-1/speech/0", "/sources/pendant-1/speech/30"])
    #expect(try metadata(sent[1].body)["pages"] as? [[Int]] == [[30, 59]])
    #expect(try segments(sent[1].body) == [[base + 30_000, base + 60_000]])
    #expect(RebuildServer.requests(host, "GET", "/sources/pendant-1/blocks").count == 2, "read again once")
}

@Test(arguments: [408, 530, 503, 413]) func aFragmentTheServerCantTakeWaitsAndSaysWhy(status: Int) async throws {
    let host = "failing-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    RebuildServer.hosts.withLock { $0[host, default: .init()].failures["/sources/pendant-1/speech/0"] = [status] }
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 1, "it waits its backoff")
    let state = try #require(try await uploader.status())
    #expect(state.lastError == "no such conversation", "the server's message")
    #expect(state.unsent == .seconds(60))
    let timeline = try json(try #require(RebuildServer.requests(host, "PUT", "/sources/pendant-1/timeline").last).body)
    #expect(try seconds(timeline["sentThrough"]) == 0, "the server waits for it")
}

@Test(arguments: [408, 530, 503]) func repeatedOutagesNeverLengthenTheRetryWaitOrSkipSpeech(status: Int) async throws {
    let host = "recovery-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    let path = "/sources/pendant-1/speech/0"
    RebuildServer.hosts.withLock { $0[host, default: .init()].failures[path] = Array(repeating: status, count: 4) }
    var configuration = Uploader.Configuration()
    configuration.retryMillis = 100
    let failedAt = Mutex(ContinuousClock.now)
    let uploader = try makeUploader(fixture, host: host, configuration: configuration) { name, _ in
        if name == "upload.failed" { failedAt.withLock { $0 = .now } }
    }
    for attempt in 1...4 {
        try await uploader.run(savedThrough: at(400).date)
        let failure = try #require(await uploader.failure)
        #expect(failure.retryAt <= failedAt.withLock { $0 } + .milliseconds(configuration.retryMillis))
        #expect(try await uploader.state()?.nextPage == 0, "an outage never skips the audio")
        #expect(RebuildServer.requests(host, "PUT", path).count == attempt)
        try await Task.sleep(until: failure.retryAt + .milliseconds(1), clock: .continuous)
    }
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", path).count == 5, "the same fragment recovers on the next eligible run")
    #expect(try await uploader.state()?.nextPage == 60)
    #expect(try await uploader.status()?.lastError == nil)
    #expect(try await uploader.status()?.unsent == .zero)
}

/// A refusal of the fragment itself is skipped after three tries, so the speech after it goes; an outage or a refused
/// token never is.
@Test(arguments: [(413, true), (503, false), (401, false)]) func aFragmentRefusedForItselfIsSkippedAfterThreeTries(
    status: Int, skipped: Bool
) async throws {
    let host = "skip-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    RebuildServer.hosts.withLock {
        $0[host, default: .init()].failures["/sources/pendant-1/speech/0"] = [status, status, status, status]
    }
    let events = Mutex<[(String, [String: String])]>([])
    var configuration = Uploader.Configuration()
    configuration.retryMillis = 0
    let uploader = try makeUploader(fixture, host: host, configuration: configuration) { name, fields in
        events.withLock { $0.append((name, fields)) }
    }
    for _ in 0..<3 { try await uploader.run(savedThrough: at(400).date) }
    try await fixture.store(60..<65, shift: 100)
    try await uploader.run(savedThrough: at(400).date)
    let logged = events.withLock { $0 }
    let failed = logged.filter { $0.0 == "upload.failed" }.map(\.1)
    #expect(failed.count == (skipped ? 3 : 4))
    #expect(failed.first?["status"] == "\(status)" && failed.first?["last"] == "59")
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").map(\.path)
    if skipped {
        #expect(logged.filter { $0.0 == "upload.skipped" }.map { $0.1["firstPage"] } == ["0"])
        #expect(sent.last == "/sources/pendant-1/speech/60", "the speech after it goes")
        #expect(try await uploader.status()?.lastError == nil)
    } else {
        #expect(!logged.contains { $0.0 == "upload.skipped" })
        #expect(sent == Array(repeating: "/sources/pendant-1/speech/0", count: 4), "an outage holds the cursor")
    }
}

@Test func aFragmentWithdrawnPastTheCursorIsReadAgainAndItsPagesGo() async throws {
    let host = "behind-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<20)
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    try await fixture.store(40..<60)
    try await uploader.run(savedThrough: at(400).date)
    let (first, second) = (RebuildServer.fragment(0), RebuildServer.fragment(40))
    // Pages 20 to 39 come late; the run that rewinds to them reads the listing, then stops before page 40.
    RebuildServer.hosts.withLock {
        $0[host]?.held = #"""
            {"handedOver":true,"blocks":[{"jobId":"\#(first)","pages":[[0,19]]},
             {"jobId":"\#(second)","pages":[[40,59]]}]}
            """#
        $0[host]?.failures["/sources/pendant-1/speech/20"] = [0]
    }
    try await fixture.store(20..<40)
    await #expect(throws: URLError.self) { try await uploader.run(savedThrough: at(400).date) }
    // The fragment at 40, past the cursor, is withdrawn: its pages are free again.
    let held = #"{"handedOver":true,"blocks":[{"jobId":"\#(first)","pages":[[0,19]]}]}"#
    RebuildServer.hosts.withLock { $0[host]?.held = held }
    try await uploader.withdrawn([("pendant-1", 40)])
    try await uploader.run(savedThrough: at(400).date)
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.map { $0.path.split(separator: "/").last } == ["0", "40", "20", "20"])
    #expect(try metadata(try #require(sent.last).body)["pages"] as? [[Int]] == [[20, 59]])
}

@Test func aWithdrawnFragmentsPagesGoAgainWithoutTheDictationAndAckIsUntouched() async throws {
    let host = "withdrawn-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    let ackable = try await fixture.source.ackableIndex(deviceID: "pendant-1", startingAt: 0)
    let uploader = try makeUploader(fixture, host: host)
    // The Mac hasn't reported the dictation at 20 s yet: the fragment holds it (the server's gate waits).
    try await uploader.run(savedThrough: at(400).date)
    #expect(
        try metadata(try #require(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").first).body)[
            "pages"] as? [[Int]] == [[0, 59]])
    let driver = Driver(
        library: fixture.library, client: RebuildServer.client(host),
        capture: .init(worker: fixture.worker, uploader: uploader))
    // A page the cache fails to apply, as a kill before its cursor is saved: the uploader's cursor moved back already.
    RebuildServer.hosts.withLock { $0[host]?.feed = #"{"removed":[\#(withdrawal(0))]}"# }
    await #expect(throws: LibraryCacheError.malformedFeed) { try await driver.pull() }
    #expect(try await uploader.state()?.nextPage == 0)
    // One feed page brings the range and says the server withdrew the fragment; the run pulls it first.
    RebuildServer.hosts.withLock { $0[host]?.feed = dictationPage(at(20)..<at(30), withdrawn: [0]) }
    try await driver.run(status(at: 400))
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.count == 2)
    #expect(try metadata(sent[1].body)["pages"] as? [[Int]] == [[0, 19], [30, 59]], "the dictation stays out")
    #expect(try segments(sent[1].body) == [[base, base + 20_000], [base + 30_000, base + 60_000]])
    // Another source's removal moves nothing.
    try await uploader.withdrawn([("pendant-2", 0)])
    try await uploader.run(savedThrough: at(400).date)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 2)
    // Uploads and withdrawals never reach the Pendant's pages: ACK reads the store alone.
    #expect(try await fixture.source.ackableIndex(deviceID: "pendant-1", startingAt: 0) == ackable)
    #expect(try await fixture.source.pages(deviceID: "pendant-1", from: 0, limit: 100).count == 60)
}

@Test func theFirstRunAfterTheHandoverWithNothingHeardYetWaitsForThePendant() async throws {
    let host = "unheard-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<60)
    let uploader = try makeUploader(fixture, host: host)
    // No saved-through from the Pendant's status yet: the speech may go on.
    try await uploader.run(savedThrough: nil)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").isEmpty)
    #expect(try await uploader.status()?.unsent == .seconds(60))
}

// MARK: Cache and outbox

@Test func theCacheKeepsEachFeedRowUnderItsKeyAndAReEmittedRowReplacesIt() async throws {
    let library = try LibraryStore(
        directory: FileManager.default.temporaryDirectory.appending(path: "cache-\(UUID().uuidString)"))
    let conversation = "00000000-0000-8000-8000-01a139765b01"
    func page(_ cursor: Int, text: String, more: Bool = false) -> Data {
        Data(
            """
            {"cursor":"\(cursor)","more":\(more),
             "conversations":[{"id":"\(conversation)","startAt":"2026-10-14T10:00:00.000Z",
                               "endAt":"2026-10-14T10:05:00.000Z","kind":"conversation","state":"open"}],
             "turns":[{"jobId":"00000000-0000-4000-8000-000000000001","turnIndex":4,"conversationId":"\(conversation)",
                       "startAt":"2026-10-14T10:01:00.000Z","endAt":"2026-10-14T10:01:02.000Z","text":"\(text)",
                       "speaker":{"label":"speaker_0","displayName":"Speaker 1"}}],
             "quietRanges":[{"id":"q1","startedAt":"2026-10-14T10:02:00.000Z","endedAt":"2026-10-14T10:03:00.000Z"}],
             "mac":{"watch":null}}
            """.utf8)
    }
    let applied = try await library.apply(feed: page(10, text: "hello", more: true)) { _ in }
    #expect(applied.cursor == "10" && applied.more)
    #expect(try await library.feed().pulledAt == nil, "a pull counts once its last page is in")
    try await library.apply(feed: page(11, text: "hello there")) { _ in }
    try await library.apply(feed: page(11, text: "hello there")) { _ in }

    let id = try #require(UUID(uuidString: conversation))
    #expect(try await library.turns(of: id).map(\.text) == ["hello there"])
    #expect(try await library.feedCursor() == "11")
    #expect(try await library.feed().pulledAt != nil)
    let quiet = CaptureInstant(try Date.ISO8601FormatStyle().parse("2026-10-14T10:02:30Z"))
    #expect(try await library.quietRanges(in: quiet..<quiet.advanced(by: 1)).count == 1, "dictation stays out")
    await #expect(throws: LibraryCacheError.malformedFeed) { try await library.apply(feed: Data("{}".utf8)) { _ in } }
}

@Test func theOutboxReplaysInOrderKeepsARefusalAndSurvivesARestart() async throws {
    let host = "outbox-\(UUID().uuidString).test"
    let directory = FileManager.default.temporaryDirectory.appending(path: "outbox-\(UUID().uuidString)")
    var library = try LibraryStore(directory: directory)
    let conversation = UUID()
    let ids = [UUID(), UUID(), UUID()]
    try await library.enqueue(.split(at: at(1).date), id: ids[0])
    try await library.enqueue(.title(conversation: conversation, title: "x"), id: ids[1])
    try await library.enqueue(.vocabulary(["Oakridge"]), id: ids[2])
    try await library.enqueue(.split(at: at(1).date), id: ids[0])
    let title = "/conversations/\(conversation.uuidString.lowercased())/title"
    RebuildServer.hosts.withLock {
        $0[host, default: .init()].failures = [title: [422], "/vocabulary": [503]]
    }
    let client = RebuildServer.client(host)
    await #expect(throws: ServerClient.ClientError.self) { try await Outbox.replay(library, client: client) }

    library = try LibraryStore(directory: directory)
    let left = try await library.outbox()
    #expect(left.map(\.id) == [ids[1], ids[2]])
    #expect(left[0].refused == "no such conversation")
    #expect(left[1].refused == nil)

    try await Outbox.replay(library, client: client)
    #expect(try await library.outbox().map(\.id) == [ids[1]], "the refusal waits for the owner")
    let sent = RebuildServer.hosts.withLock { $0[host]?.requests ?? [] }.map { "\($0.method) \($0.path)" }
    #expect(sent == ["POST /edits", "PUT \(title)", "PUT /vocabulary", "PUT /vocabulary"])
}

// MARK: Driver

/// The Pendant's status as a run reads it, received at `seconds`: only the page being written is still on it.
private func status(at seconds: Double) -> CaptureStatus {
    var status = CaptureStatus()
    let reading = at(seconds).date
    status.storage = Observed(
        StorageState(oldestPage: 0, newestPage: 0, session: 0, freePages: 0, totalPages: 0), at: reading)
    status.backlog = Observed(Backlog(pages: 0, estimatedDuration: nil), at: reading)
    return status
}

@Test func theDriverSendsEditsThenPullsThenUploadsAndOfflineLosesNothing() async throws {
    let host = "driver-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<5)
    try await fixture.store(5..<20, shift: 100)
    let events = Mutex<[(String, [String: String])]>([])
    let log: AppEvent = { name, fields in events.withLock { $0.append((name, fields)) } }
    let uploader = try Uploader(
        source: fixture.source, scanner: try fixture.scanner(), client: RebuildServer.client(host),
        directory: fixture.directory.appending(path: "upload"), canRunHeavyWork: { true }, event: log)
    let conversation = UUID()
    try await fixture.library.enqueue(.title(conversation: conversation, title: "Plumber"))
    try await fixture.library.record(PlaceObservation(at: at(100), latitude: 21.0, longitude: 105.8, accuracyMeters: 9))
    let driver = Driver(
        library: fixture.library, client: RebuildServer.client(host),
        capture: .init(worker: fixture.worker, uploader: uploader), event: log)
    let run = status(at: 400)

    // The edit goes first, never behind uploads. The feed first, so fragments leave out the newest dictation; offline
    // there (a GET tries twice), the speech still goes, then the timeline saying it went, and the run stops.
    RebuildServer.hosts.withLock { $0[host, default: .init()].failures["/changes"] = [0, 0] }
    await #expect(throws: URLError.self) { try await driver.run(run) }
    let title = "/conversations/\(conversation.uuidString.lowercased())/title"
    let first = RebuildServer.hosts.withLock { $0[host]?.requests ?? [] }.map(\.path)
    let steps = [title, "/changes", "/sources/pendant-1/speech/0", "/sources/pendant-1/timeline"]
    #expect(steps.compactMap { first.firstIndex(of: $0) } == steps.compactMap { first.firstIndex(of: $0) }.sorted())
    #expect(steps.allSatisfy(first.contains), "\(first)")
    #expect(try await fixture.library.outbox().isEmpty)
    #expect(try await fixture.library.feedCursor() == nil)
    #expect(try await fixture.library.unsentLocations(limit: 10).fixes.count == 1)

    let before = RebuildServer.hosts.withLock { $0[host]?.requests.count ?? 0 }
    try await driver.run(run)
    let order = Array(RebuildServer.hosts.withLock { $0[host]?.requests ?? [] }.map(\.path).dropFirst(before))
    #expect(order.firstIndex(of: "/changes") ?? .max < order.firstIndex(of: "/location-history") ?? .min, "\(order)")
    try await driver.run(run)
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").count == 1)
    #expect(try await fixture.library.outbox().isEmpty)
    #expect(try await fixture.library.feedCursor() == "1")
    #expect(try await fixture.library.unsentLocations(limit: 10).fixes.isEmpty)

    // Each run says how long it took and where (the offline one had no feed); each fragment, its lag.
    let logged = events.withLock { $0 }
    let runs = logged.filter { $0.0 == "run.done" }.map {
        $0.1["steps"]?.split(separator: ", ").map { $0.split(separator: " ")[0] }
    }
    #expect(runs.count == 3)
    #expect(runs.first == ["outbox", "audio", "upload"])
    #expect(runs.last == ["outbox", "audio", "feed", "upload", "locations"])
    let sent = logged.filter { $0.0 == "upload.sent" }.map(\.1)
    #expect(sent.map { $0["firstPage"] } == ["0"])
    #expect(sent.allSatisfy { Int($0["sinceLastKeptMs"] ?? "") ?? 0 > 0 && Int($0["pages"] ?? "") ?? 0 > 0 })
    #expect(logged.filter { $0.0 == "run.done" }.allSatisfy { Int($0.1["cpuMs"] ?? "") != nil })

    // Nothing new, or new audio alone: screens don't read again (the feed brings what they show).
    #expect(try await driver.run(run) == false)
    try await fixture.store(20..<22, shift: 100)
    #expect(try await driver.run(run) == false)
}

@Test(.timeLimit(.minutes(1)))
func aBackupItemInFlightNeverHoldsARunAndADroppedOneGoesNextRound() async throws {
    let host = "lane-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<5)
    try await fixture.store(5..<20, shift: 100)
    // The store rolled to a second pack: the first is sealed, for the backup.
    try Data("open".utf8).write(to: fixture.directory.appending(path: "source/packs/2.pack"))
    let uploader = try makeUploader(fixture, host: host)
    let driver = Driver(
        library: fixture.library, client: RebuildServer.client(host),
        capture: .init(worker: fixture.worker, uploader: uploader))

    // The pack's upload takes as long as a 64 MB one on a slow link. A run meanwhile sends its speech and pulls.
    let pack = "/backup/packs/pendant-1/1"
    RebuildServer.hosts.withLock { $0[host, default: .init()].holds = [pack] }
    let round = Task { try await uploader.backUp(library: fixture.library) }
    while RebuildServer.requests(host, "PUT", pack).isEmpty { try await Task.sleep(for: .milliseconds(10)) }
    try await driver.run(status(at: 400))
    #expect(!RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").isEmpty)
    #expect(try await fixture.library.feedCursor() == "1")

    // The connection drops under it: the round stops, the pack still owed, and the next round sends it.
    RebuildServer.hosts.withLock {
        $0[host]?.failures[pack] = [0]
        $0[host]?.holds = []
    }
    await #expect(throws: URLError.self) { try await round.value }
    #expect(try await uploader.backupStatus() == .init(packs: 1, jobs: 0))
    try await uploader.backUp(library: fixture.library)
    #expect(RebuildServer.requests(host, "PUT", pack).count == 2)
    #expect(try await uploader.backupStatus() == .init(packs: 0, jobs: 0))
}

// MARK: Fragments in time and heard-through

@Test func speechGoesUpInTheWakeTheDetectorsStopBringsAndNotWhileItGoesOn() async throws {
    let host = "quiet-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    // 50 s of speech, then the 4.5 s the Pendant's detector waits before it stops recording.
    try await persistPages(0..<55, in: fixture.source)
    await fixture.worker.run { _ in }
    try await fixture.label(speech: [0..<50])
    let uploader = try makeUploader(fixture, host: host)
    // Speech still going on as far as the Pendant vouches: nothing goes.
    try await uploader.run(savedThrough: FactsBuilder.savedThrough(status(at: 50)))
    #expect(RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/").isEmpty)
    // The status the Pendant pushes as its detector stops: the page being written is all it holds.
    try await uploader.run(savedThrough: FactsBuilder.savedThrough(status(at: 54.5)))
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.count == 1, "not at the next sound")
    #expect(try segments(try #require(sent.first).body) == [[base, base + 51_000]])
}

@Test func aLongStretchGoesUpAtAMinuteCutInsideAQuietSecond() async throws {
    let host = "long-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    // 100 s of talk with no pause; the analyzers hear no speech from 70 to 72 s.
    try await persistPages(0..<100, in: fixture.source)
    await fixture.worker.run { _ in }
    try await fixture.label(speech: [0..<70, 72..<100])
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(53).date)
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.map(\.path) == ["/sources/pendant-1/speech/0"])
    #expect(try metadata(sent[0].body)["pages"] as? [[Int]] == [[0, 70]])
    #expect(try segments(sent[0].body) == [[base, base + 71_000]])
    // The rest waits for a pause; the timeline tells the server where it starts.
    #expect(try await uploader.status()?.unsent == .seconds(29))
    let timeline = try json(try #require(RebuildServer.requests(host, "PUT", "/sources/pendant-1/timeline").last).body)
    #expect(try seconds(timeline["sentThrough"]) == 71)
}

@Test func aPageStoredLateBelowTheCursorStillGoesUp() async throws {
    let host = "late-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<20)
    try await fixture.store(40..<60)
    let uploader = try makeUploader(fixture, host: host)
    try await uploader.run(savedThrough: at(400).date)
    let first = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(try first.map { try metadata($0.body)["pages"] as? [[Int]] } == [[[0, 19], [40, 59]]])
    // Pages 20 to 39 come in a later drain (or a held page is repaired), below the cursor.
    let fragment = RebuildServer.fragment(0)
    RebuildServer.hosts.withLock {
        $0[host]?.held = #"{"handedOver":true,"blocks":[{"jobId":"\#(fragment)","pages":[[0,19],[40,59]]}]}"#
    }
    try await fixture.store(20..<40)
    try await uploader.run(savedThrough: at(400).date)
    let sent = RebuildServer.requests(host, "PUT", "/sources/pendant-1/speech/")
    #expect(sent.count == 2, "\(sent.map(\.path))")
    #expect(try metadata(try #require(sent.last).body)["pages"] as? [[Int]] == [[20, 39]], "the sent pages stay")
}

@Test func heardThroughFollowsTheStatusButNoFurtherThanTheQuietAllowanceAfterTheNewestAudio() {
    let newest = at(100)
    func heard(_ saved: Double, sent: CaptureInstant? = nil) -> CaptureInstant? {
        FactsBuilder.heardThrough(savedThrough: at(saved), newestStored: newest, unanalyzedFrom: nil, sent: sent)
    }
    #expect(heard(400) == at(400), "a quiet stretch after the last audio still counts as heard")
    #expect(heard(86_400) == newest.advanced(by: FactsBuilder.quietAllowanceMillis), "a clock jump can't carry it")
    #expect(heard(50, sent: at(300)) == at(300), "it never moves back")
    #expect(
        FactsBuilder.heardThrough(savedThrough: at(400), newestStored: newest, unanalyzedFrom: at(80), sent: nil)
            == at(80), "nor past audio the analyzers haven't reached")
    #expect(FactsBuilder.savedThrough(status(at: 403)) == at(400).date, "3 s for the page being written")
    var behind = status(at: 403)
    behind.backlog?.value.pages = 12
    #expect(FactsBuilder.savedThrough(behind) == nil, "pages still on the Pendant")
}

// MARK: Edits shown before the server has them

@Test func anEditShowsAtOnceAndARefusedOneRollsBack() async throws {
    let library = try LibraryStore(
        directory: FileManager.default.temporaryDirectory.appending(path: "pending-\(UUID().uuidString)"))
    let conversation = UUID()
    try await library.enqueue(.title(conversation: conversation, title: "Lunch with Mai"))
    try await library.enqueue(.split(at: at(30).date))
    try await library.enqueue(
        .speaker(job: conversation, label: "speaker_1", target: .new(name: "Mai"), turnIndex: nil))

    var pending = try await library.pendingEdits()
    #expect(pending.titles == [conversation: "Lunch with Mai"])
    #expect(pending.regrouping(at(0)..<at(60)) && !pending.regrouping(at(60)..<at(90)))
    #expect(pending.speakers == ["\(conversation)|speaker_1"])

    // The server refuses the title: it shows its message, and the feed's title again.
    let title = try #require(pending.waiting.first)
    try await library.settle(title.id, refused: "no such conversation")
    pending = try await library.pendingEdits()
    #expect(pending.titles.isEmpty)
    #expect(pending.refused.map(\.refused) == ["no such conversation"])
    #expect(pending.waiting.count == 2)
}

@Test func everyIntentKeepsInTheOutboxAndBecomesItsRequestWhenSent() async throws {
    let library = try LibraryStore(
        directory: FileManager.default.temporaryDirectory.appending(path: "intents-\(UUID().uuidString)"))
    let named = ServerClient.NamingItem(
        id: "w", kind: .several, conversations: 1, seconds: 2, exchanges: 0, evidence: [],
        voices: [.init(conversationId: UUID(), jobId: UUID(), speakerLabel: "speaker_1")], clips: [])
    let intents: [OwnerIntent] = [
        .split(at: at(1).date), .merge(from: at(1).date, to: at(2).date), .undo(edit: UUID()),
        .title(conversation: UUID(), title: nil), .title(conversation: UUID(), title: "Lunch"),
        .speaker(job: UUID(), label: "speaker_0", target: .person(UUID()), turnIndex: 3),
        .speaker(job: UUID(), label: "speaker_1", target: .new(name: "Mai"), turnIndex: nil),
        .dismissSplit(at: at(5).date), .vocabulary(["Nok", "Izipizi"]),
        .summarize(conversation: UUID(), after: nil), .summarize(conversation: UUID(), after: UUID()),
        .switches(transcription: nil, ai: false, engine: .codex), .renamePerson(UUID(), name: "Mai"),
        .naming(
            item: .init(
                id: "v", kind: .newPerson, conversations: 1, seconds: 2, exchanges: 3, evidence: [],
                voices: [.init(conversationId: UUID(), jobId: UUID(), speakerLabel: "speaker_0")], clips: []),
            answer: .confirm(name: "Mai")),
        .playbackQuiet(from: at(1).date, to: at(2).date),
        .naming(item: named, answer: .several(people: [UUID()], unknown: true)),
    ]
    for intent in intents { try await library.enqueue(intent) }
    let kept = try await library.outbox()
    #expect(kept.map(\.intent) == intents, "each keeps as the owner made it, a new person's id included")

    func body(_ entry: OutboxEntry) throws -> [String: Any] {
        try json(try #require(try entry.intent.request(id: entry.id, at: entry.createdAt).body))
    }
    #expect(try body(kept[3])["title"] is NSNull, "a cleared title is sent as null")
    #expect(try body(kept[9])["after"] is NSNull, "Generate with no run shown")
    let target = try #require(try body(kept[6])["target"] as? [String: Any])
    #expect(target["id"] as? String != nil, "a new person goes under the phone's id, the same on a replay")
    #expect(try body(kept[14])["id"] as? String == kept[14].id.uuidString.lowercased(), "the range's id is the edit's")
    let pending = PendingEdits(kept)
    #expect(pending.summarizing(intents.compactMap { if case .summarize(let c, nil) = $0 { c } else { nil } }[0]))
    let several = try #require(try body(kept[15])["answer"] as? [String: Any])
    #expect((several["people"] as? [String])?.count == 1 && several["unknown"] as? Bool == true)
    #expect(
        try JSONDecoder().decode(ServerClient.NamingAnswer.self, from: Data(#"{"kind":"several"}"#.utf8))
            == .several(people: [], unknown: false), "an answer kept from before the multi-select")
    #expect(
        try JSONDecoder().decode(ServerClient.NamingAnswer.self, from: Data(#"{"kind":"rest"}"#.utf8)) == .rest,
        "a waiting Assign the rest stays itself for the server to refuse, never not anyone I know")
    #expect(
        try JSONDecoder().decode(
            ServerClient.NamingAnswer.self, from: JSONEncoder().encode(ServerClient.NamingAnswer.notRelevant))
            == .notRelevant, "Not relevant survives the outbox as itself")
    let both = ServerClient.SpeakerTarget.several(people: [UUID(), UUID()], unknown: false)
    #expect(
        try JSONDecoder().decode(ServerClient.SpeakerTarget.self, from: JSONEncoder().encode(both)) == both,
        "a clip two people speak in survives the outbox as itself, never Don't know")
    #expect(pending.namedVoices.count == 2 && pending.people.count == 1)
    let mira = CachedPerson(id: UUID(), name: "Mira")
    let renamed = PendingEdits([
        OutboxEntry(intent: .renamePerson(mira.id, name: "Marie-Jo")), OutboxEntry(intent: .aliases(mira.id, ["Jojo"])),
    ])
    #expect(
        renamed.people(over: [mira]) == [CachedPerson(id: mira.id, name: "Marie-Jo", aliases: ["Jojo"])],
        "a waiting rename and other names show at once")
    let switches = PendingEdits([
        OutboxEntry(intent: .switches(transcription: false, ai: nil, engine: nil)),
        OutboxEntry(intent: .switches(transcription: nil, ai: false, engine: nil)),
        OutboxEntry(intent: .switches(openAppAfterMinutes: 30)),
    ])
    #expect(switches.switches(over: nil) == nil, "nothing shown before the feed said")
    #expect(
        switches.switches(over: .init(transcription: true, ai: true, openAppAfterMinutes: 15))
            == .init(transcription: false, ai: false, openAppAfterMinutes: 30),
        "each waiting change applies over the feed's")
}
