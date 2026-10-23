import Foundation
import PendantProtocol
import SourceStore
import Testing
import Timeline
import Upload

@testable import AudioPipeline

/// The server turns a thin phone's raw pages into speech fragments by the phone's rules (`apps/voice/src/page-rules.ts`).
/// This runs the phone's own code on the same made-up Omi records (`fixtures/pages/omi.bin`, written by
/// `apps/voice/scripts/page-fixture.ts`) and checks it against `fixtures/pages/expected.json`, which the server's test
/// checks too. `WRITE_PAGES=1` rewrites it.
private let pages = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "fixtures/pages")

private struct Expected: Codable, Equatable {
    struct Piece: Codable, Equatable {
        var first: UInt64
        var last: UInt64
        var start: Int64
        var end: Int64
        var speech: [[Int64]]
        /// Silero's frame probabilities, to three decimals: the server's runtime differs in the last digits.
        var probabilities: [Double]
    }

    /// A timeline span as `FactsBuilder.spans` builds it, times in epoch milliseconds.
    struct Span: Codable, Equatable {
        var firstPage: UInt64
        var start: Int64
        var end: Int64
        var speech: [[Int64]]
        var audible: [[Int64]]
        var unanalyzed: [[Int64]]
        var breaks: [String]
    }

    struct Fragment: Codable, Equatable {
        var segments: [[Int64]]
        var pages: [[UInt64]]
        var last: UInt64
    }

    var quiet: [[Int64]]
    var heardThrough: Int64
    var pieces: [Piece]
    var kept: [[Int64]]
    var fragments: [Fragment]
    var timeline: [Span]
}

private func millis(_ ranges: [Range<CaptureInstant>]) -> [[Int64]] {
    ranges.map { [$0.lowerBound.millis, $0.upperBound.millis] }
}

@Test func thePhonesRulesOnTheFixtureRecords() async throws {
    let bytes = try Data(contentsOf: pages.appending(path: "omi.bin"))
    let omi = DeviceKind.omi.deviceID
    let store = try SourceStore(
        directory: FileManager.default.temporaryDirectory.appending(path: "page-parity-\(UUID().uuidString)"))
    let count = bytes.count / OmiRecord.size
    for index in 0..<count {
        let record = bytes.subdata(in: index * OmiRecord.size..<(index + 1) * OmiRecord.size)
        let stamp = Int64(try OmiRecord(decoding: record).timestampSeconds ?? 0) * 1000
        _ = try await store.persist(
            RawPage(
                key: PageKey(deviceID: omi, index: UInt64(index)), session: 0, deviceTimeMillis: stamp,
                payload: record, receivedAt: .now))
    }
    let scan = try await PageScan.scan(store, deviceID: omi, indices: 0...UInt64(count - 1))
    let source = SourceAudio(store: store, deviceID: omi, pages: scan.pages, clock: ClockModel(syncs: []))

    var pieces: [Expected.Piece] = []
    var windows: [ActivityWindow] = []
    var energy: [ActivityWindow] = []
    for span in source.spans {
        for piece in DerivedAudioWorker.pieces(span) {
            let detector = try SileroDetector()
            let samples = try await source.samples(piece.interval).samples
            try detector.append(samples)
            // The worker's 30 s chunks start on whole seconds of the piece: one pass gives the same windows.
            energy += EnergyDetector.windows(samples, start: piece.interval.lowerBound)
            let labeled = try detector.windows(start: piece.interval.lowerBound, millis: piece.interval.millis)
            windows += labeled
            pieces.append(
                Expected.Piece(
                    first: piece.pages.lowerBound, last: piece.pages.upperBound,
                    start: piece.interval.lowerBound.millis, end: piece.interval.upperBound.millis,
                    speech: millis(labeled.speech()),
                    probabilities: detector.probabilities.map { (Double($0) * 1000).rounded() / 1000 }))
        }
    }

    // A quiet range over part of the second span's first sentence; heard-through 3 s before the audio ends.
    let second = try #require(source.spans.last).interval
    let quiet = [second.lowerBound.advanced(by: 3_000)..<second.lowerBound.advanced(by: 4_000)]
    let heard = second.upperBound.advanced(by: -3_000)
    let speech = windows.speech()
    let kept = SpeechPolicy().keptAudio(spans: source.spans, windows: windows, quietRanges: quiet)
    let runs = source.spans.flatMap(\.runs)
    var fragments: [Expected.Fragment] = []
    var cursor: UInt64 = 0
    while true {
        let free = SpeechFragment.unheld(kept: kept, runs: runs) { $0 < cursor }
        guard let fragment = SpeechFragment.next(kept: free.kept, runs: free.runs, speech: speech, heardThrough: heard)
        else { break }
        fragments.append(
            Expected.Fragment(
                segments: millis(fragment.segments), pages: fragment.pages.map { [$0.lowerBound, $0.upperBound] },
                last: fragment.last))
        cursor = fragment.last + 1
    }

    func ms(_ dates: [[Date]]) -> [[Int64]] {
        dates.map { $0.map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) } }
    }
    let timeline = FactsBuilder.spans(source.spans, windows: windows + energy, pauses: [], after: nil).map {
        Expected.Span(
            firstPage: $0.firstPage, start: Int64(($0.startAt.timeIntervalSince1970 * 1000).rounded()),
            end: Int64(($0.endAt.timeIntervalSince1970 * 1000).rounded()), speech: ms($0.speech),
            audible: ms($0.audible), unanalyzed: ms($0.unanalyzed), breaks: $0.breaks.map(\.kind))
    }
    let result = Expected(
        quiet: millis(quiet), heardThrough: heard.millis, pieces: pieces, kept: millis(kept), fragments: fragments,
        timeline: timeline)
    let url = pages.appending(path: "expected.json")
    if ProcessInfo.processInfo.environment["WRITE_PAGES"] != nil {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(result).write(to: url)
    }
    let expected = try JSONDecoder().decode(Expected.self, from: Data(contentsOf: url))
    #expect(result == expected, "the phone's rules drifted from fixtures/pages/expected.json")
    #expect(!fragments.isEmpty)
}
