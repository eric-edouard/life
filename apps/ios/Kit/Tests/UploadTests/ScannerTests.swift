import AVFoundation
import Foundation
import Library
import PendantProtocol
import SourceStore
import Synchronization
import Testing
import Timeline

@testable import AudioPipeline
@testable import Upload
@testable import ServerAPI

let base: Int64 = 1_790_000_000_000

func at(_ seconds: Double) -> CaptureInstant {
    CaptureInstant(millis: base + Int64((seconds * 1000).rounded()))
}

func requestBody(_ request: URLRequest) -> Data {
    guard let stream = request.httpBodyStream else { return request.httpBody ?? Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while case let count = stream.read(&buffer, maxLength: buffer.count), count > 0 { data += buffer[..<count] }
    return data
}

/// The seconds in `range` of a speech-like signal (harmonic voice, 3 s on, 1 s off), one Pendant page each.
/// Pages of one second each, stamped `shift` seconds after their index.
func persistPages(_ range: Range<Int>, in store: SourceStore, shift: Int64 = 0) async throws {
    let encoder = try OpusPacketEncoder(bitRate: 24_000)
    let samples = (0..<(range.upperBound * 16_000)).map { index in
        let time = Float(index) / 16_000
        guard Int(time) % 4 != 3 else { return Float(0.001) }
        let voice = (1...6).reduce(Float(0)) { $0 + sin(2 * .pi * 140 * Float($1) * time) / Float($1) }
        return 0.15 * voice * (0.5 + 0.5 * sin(2 * .pi * 4 * time))
    }
    let packets = try encoder.encode(samples) + encoder.encode(nil)
    for index in range {
        let stamp = base + (shift + Int64(index)) * 1000  // stamped when the page opens
        var buffer = ProtoWriter()
        buffer.varint(2, 7)
        buffer.varint(5, UInt64(index))
        buffer.message(6) { flash in
            flash.varint(1, UInt64(stamp))
            for (offset, packet) in packets[index * 50..<(index + 1) * 50].enumerated() {
                flash.message(3) { chunk in
                    chunk.varint(1, UInt64(offset * 20))
                    chunk.message(2) { $0.bytes(4, packet) }
                }
            }
        }
        _ = try await store.persist(
            RawPage(
                key: PageKey(deviceID: "pendant-1", index: UInt64(index)), session: 7, deviceTimeMillis: stamp,
                payload: buffer.data, receivedAt: .now))
    }
}

extension ScannerFixture {
    /// Replaces the analyzers' labels: `speech` (seconds from `base`) is speech, the rest silence, in 1 s windows.
    func label(speech: [Range<Double>]) async throws {
        let scanner = try scanner()
        for var segment in try derived.manifest(deviceID: "pendant-1").segments {
            let end = segment.interval.upperBound.millis
            segment.windows = stride(from: segment.interval.lowerBound.millis, to: end, by: 1000).map { millis in
                let isSpeech = speech.contains { $0.contains(Double(millis - base) / 1000) }
                return StoredWindow(
                    ActivityWindow(
                        interval: CaptureInstant(millis: millis)..<CaptureInstant(millis: min(millis + 1000, end)),
                        activity: isSpeech ? .speech : .silence, confidence: 0.9, analyzer: "test"))
            }
            try derived.write(segment)
            try await scanner.index(segment)
        }
    }
}

/// Grouping over a fresh directory, with the derived-audio worker; every stretch of audio stored is labeled speech.
struct ScannerFixture {
    let directory = FileManager.default.temporaryDirectory.appending(path: "scanner-\(UUID().uuidString)")
    let source: SourceStore
    let derived: DerivedAudioDirectory
    let library: LibraryStore
    let worker: DerivedAudioWorker

    init() throws {
        source = try SourceStore(directory: directory.appending(path: "source"))
        derived = DerivedAudioDirectory(url: directory.appending(path: "derived"))
        library = try LibraryStore(directory: directory.appending(path: "library"))
        worker = DerivedAudioWorker(store: source, output: derived, canRunHeavyWork: { true })
    }

    func scanner() throws -> TimelineScanner {
        try TimelineScanner(
            source: source, derived: derived, library: library, database: directory.appending(path: "timeline.sqlite"),
            deviceID: "pendant-1")
    }

    func store(_ pages: Range<Int>, shift: Int64 = 0) async throws {
        try await persistPages(pages, in: source, shift: shift)
        let scanner = try scanner()
        await worker.run { try await scanner.index($0) }
        try await label(speech: [-1e9..<1e9])
    }
}

@Test func sidecarsAnOlderBuildNeverIndexedAreIndexedByTheMigration() async throws {
    let fixture = try ScannerFixture()
    // timeline.sqlite as the build before left it, and a run it cut after the worker: the sidecars are on disk only,
    // their job complete.
    try SQLite(path: fixture.directory.appending(path: "timeline.sqlite").path).migrate(
        Array(TimelineStore.migrations.prefix(TimelineStore.listingDropped)), tooNew: { _ in CancellationError() })
    try await persistPages(0..<5, in: fixture.source)
    #expect(await fixture.worker.run { _ in } == 1)
    #expect(try await fixture.source.claimJob() == nil)
    #expect(try await fixture.scanner().scan().unanalyzedFrom == nil)
}

@Test func aSidecarWrittenBeforeACrashReachesTheTimelineWhenItsJobRunsAgain() async throws {
    let fixture = try ScannerFixture()
    let scanner = try fixture.scanner()
    try await persistPages(0..<5, in: fixture.source)
    // The run dies once the sidecar is written, before the scanner has it: the job is left to run again.
    let crashed = Task {
        await fixture.worker.run { _ in
            withUnsafeCurrentTask { $0?.cancel() }
            throw CancellationError()
        }
    }
    #expect(await crashed.value == 0)
    #expect(try await scanner.scan().unanalyzedFrom == at(0), "no sidecar indexed")
    #expect(await fixture.worker.run { try await scanner.index($0) } == 1)
    #expect(try await scanner.scan().unanalyzedFrom == nil)
}

@Test func aPageStoredBelowOnesAlreadyScannedReachesTheTimeline() async throws {
    let fixture = try ScannerFixture()
    let scanner = try fixture.scanner()
    func covered() async throws -> Bool {
        try await scanner.scan().spans(overlapping: at(4)..<at(5)).contains { $0.interval.contains(at(4.5)) }
    }
    // A dropped message leaves a hole at page 4; the drain stores the pages after it.
    try await fixture.store(0..<4)
    try await fixture.store(5..<10)
    #expect(try await !covered())
    // The next drain fills the hole, below pages already scanned.
    try await fixture.store(4..<5)
    #expect(try await covered())
}

@Test func onlyAPauseCountsNeverALateResume() {
    #expect(TimelineScanner.pauses([RecordingChange(.resumed, at: at(1.5))]).isEmpty)
    #expect(TimelineScanner.pauses([RecordingChange(.paused, at: at(1.5))]) == [at(1.5)])
}

@Test func serverConversationIDIsStableAndDistinct() {
    let conversation = ConversationID(anchor: at(0))
    #expect(conversation.serverID == ConversationID(anchor: at(0)).serverID)
    #expect(conversation.serverID != ConversationID(anchor: at(0.001)).serverID)
    #expect(conversation.serverID.uuidString.lowercased().dropFirst(14).hasPrefix("8"), "version 8")
    #expect(ConversationID(serverID: conversation.serverID) == conversation)
    #expect(ConversationID(serverID: UUID()) == nil)
}

@Test func droppedConnectionIsTransientButABadRequestIsNot() throws {
    // What URLSession threw on a 5G drop, bridged from NSError as the app catches it.
    let dropped = try #require(NSError(domain: NSURLErrorDomain, code: -1005) as Error as? URLError)
    #expect(dropped.isTransient)
    #expect(URLError(.notConnectedToInternet).isTransient)
    #expect(!URLError(.badURL).isTransient)
}

@Test func aMacReasonThisAppDoesNotKnowNeverFailsTheResponse() throws {
    let mac = Data(#"{"able":false,"reason":"brand_new"}"#.utf8)
    #expect(try JSONDecoder().decode(ServerClient.MacLLM.self, from: mac).reason == .unknown)
}

/// Answers by path: `/ok` 200, anything else as if offline.
private final class AnsweringServer: URLProtocol {
    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        guard request.url?.path() == "/ok", let url = request.url,
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)
        else { return client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) ?? () }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
