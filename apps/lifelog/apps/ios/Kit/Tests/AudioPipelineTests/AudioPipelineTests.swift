import AVFoundation
import Foundation
import PendantProtocol
import SourceStore
import Testing
import Timeline

@testable import AudioPipeline

private let device = "pendant-1"
private let base: Int64 = 1_790_000_000_000

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "audio-pipeline-\(UUID().uuidString)")
}

/// Speech-like test signal: a gliding harmonic voice, 3 s on, 1 s off, over faint noise.
private func signal(seconds: Double) -> [Float] {
    var seed: UInt64 = 42
    return (0..<Int(seconds * 16_000)).map { index in
        seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        let noise = Float(seed >> 40) / Float(1 << 24) * 0.01 - 0.005
        let time = Float(index) / 16_000
        guard Int(time) % 4 != 3 else { return noise }
        let pitch = 120 + 30 * sin(time * 0.7)
        let voice = (1...6).reduce(Float(0)) { $0 + sin(2 * .pi * pitch * Float($1) * time) / Float($1) }
        return 0.15 * voice * (0.5 + 0.5 * sin(2 * .pi * 4 * time)) + noise
    }
}

private func encode(_ samples: [Float]) throws -> [Data] {
    let encoder = try OpusPacketEncoder(bitRate: 24_000)
    return try encoder.encode(samples) + encoder.encode(nil)
}

private func decode(_ packets: [Data]) throws -> (samples: [Float], outcomes: [OpusPacketDecoder.Outcome]) {
    let decoder = try OpusPacketDecoder()
    var samples: [Float] = []
    let outcomes = packets.map { decoder.decode($0, into: &samples) }
    return (samples, outcomes)
}

/// A stored page as the Pendant sends it: `StorageBufferMsg` around a `FlashPage` stamped when it opens, with one audio
/// chunk per packet at its offset.
private func page(_ index: UInt64, packets: [Data], offsets: [Int]? = nil) -> RawPage {
    let stamp = base + Int64(index) * Int64(packets.count) * 20
    var buffer = ProtoWriter()
    buffer.varint(2, 7)
    buffer.varint(5, index)
    buffer.message(6) { flash in
        flash.varint(1, UInt64(stamp))
        flash.varint(2, UInt64(stamp - base))
        for (offset, packet) in packets.enumerated() {
            flash.message(3) { chunk in
                chunk.varint(1, UInt64(offsets?[offset] ?? offset * 20))
                chunk.message(2) { $0.bytes(4, packet) }
            }
        }
    }
    return RawPage(
        key: PageKey(deviceID: device, index: index), session: 7, deviceTimeMillis: stamp, payload: buffer.data,
        receivedAt: .now)
}

/// A store holding `seconds` of encoded test signal as pages of 50 packets (1 s), indices from 0.
private func store(seconds: Int, at directory: URL) async throws -> (SourceStore, [Data]) {
    let store = try SourceStore(directory: directory)
    let packets = Array(try encode(signal(seconds: Double(seconds))).prefix(seconds * 50))
    for index in 0..<seconds {
        _ = try await store.persist(page(UInt64(index), packets: Array(packets[index * 50..<(index + 1) * 50])))
    }
    return (store, packets)
}

@Test func opusRoundTripIsExactToThePacket() throws {
    let samples = signal(seconds: 2.5)
    let packets = try encode(samples)
    #expect(packets.count == (samples.count + 104 + 319) / 320)

    let decoded = try decode(packets)
    #expect(decoded.samples.count == packets.count * PendantAudio.samplesPerPacket)
    #expect(decoded.outcomes.allSatisfy { $0 == .decoded })
}

@Test func shortDtxPacketsDecodeAndCorruptPacketsBecomeGaps() throws {
    var packets = try encode(signal(seconds: 1))
    packets[10] = Data([packets[10][0]])  // TOC only: a DTX/concealment packet
    packets[20] = Data([0xFF, 0xFF, 0x12, 0x34])  // code 3 with 63 frames: invalid

    let decoded = try decode(packets)
    #expect(decoded.samples.count == packets.count * PendantAudio.samplesPerPacket)
    #expect(decoded.outcomes[10] == .decoded)
    #expect(decoded.outcomes[20] == .rejected)
    #expect(decoded.outcomes.enumerated().allSatisfy { $0.offset == 20 || $0.element == .decoded })
}

@Test func workerWritesPlaybackFilesWhoseOffsetsMapExactlyToCaptureTime() async throws {
    let directory = temporaryDirectory()
    let (store, packets) = try await store(seconds: 12, at: directory)
    var corrupt = page(12, packets: Array(packets.prefix(50)))
    corrupt.payload = Data([0x30, 0xFF])
    _ = try await store.persist(corrupt)
    let output = DerivedAudioDirectory(url: directory.appending(path: "derived"))
    let worker = DerivedAudioWorker(store: store, output: output, canRunHeavyWork: { true })

    #expect(await worker.run { _ in } == 1)

    let manifest = try output.manifest(deviceID: device)
    let segment = try #require(manifest.segments.only)
    let start = CaptureInstant(millis: base)
    #expect(segment.interval == start..<start.advanced(by: 12_000))
    #expect(segment.pages == 0...11)
    #expect(try output.decodeGaps(deviceID: device) == [DecodeGap(page: 12, packet: nil, reason: .unreadablePage)])

    let file = try AVAudioFile(forReading: output.directory(device).appending(path: segment.file))
    #expect(file.length == 12 * 16_000)
    let analyzers = Set(segment.activity.map(\.analyzer))
    #expect(analyzers.isSuperset(of: [EnergyDetector.analyzer, SoundClassifier.analyzer]))
}

@Test func playbackAnalyzedBeforeSileroIsRebuiltOnce() async throws {
    let directory = temporaryDirectory()
    let (store, _) = try await store(seconds: 12, at: directory)
    let output = DerivedAudioDirectory(url: directory.appending(path: "derived"))
    let worker = DerivedAudioWorker(store: store, output: output, canRunHeavyWork: { true })
    #expect(await worker.run { _ in } == 1)
    #expect(try output.staleAnalysis().isEmpty)

    var old = try #require(output.manifest(deviceID: device).segments.only)
    old.windows = [
        StoredWindow(
            ActivityWindow(interval: old.interval, activity: .speech, confidence: 1, analyzer: "energy-vad 1"))
    ]
    try output.write(old)
    #expect(try output.staleAnalysis().map(\.pages) == [0...11])

    try await worker.requeueStaleAnalysis()
    #expect(!FileManager.default.fileExists(atPath: output.audioURL(device, pages: 0...11).path))
    #expect(await worker.run { _ in } == 1)
    #expect(try output.staleAnalysis().isEmpty)
    let rebuilt = try #require(output.manifest(deviceID: device).segments.only)
    #expect(rebuilt.activity.contains { $0.analyzer == SileroDetector.analyzer })

    // Done once: the next call queues nothing, even if a stale sidecar comes back.
    try output.write(old)
    try await worker.requeueStaleAnalysis()
    #expect(await worker.run { _ in } == 0)
}

@Test func packetsDecodeAtTheirOffsetsWithSilenceWhereNoneWasSent() async throws {
    let directory = temporaryDirectory()
    let store = try SourceStore(directory: directory)
    let packets = Array(try encode(signal(seconds: 2)).prefix(100))
    // One page: 1 s of audio, 600 ms the Pendant sent nothing for (DTX), then 1 s more.
    let offsets = (0..<100).map { $0 < 50 ? $0 * 20 : 1_600 + ($0 - 50) * 20 }
    _ = try await store.persist(page(0, packets: packets, offsets: offsets))
    let scan = try await PageScan.scan(store, deviceID: device, indices: 0...0)
    let source = SourceAudio(store: store, deviceID: device, pages: scan.pages, clock: ClockModel(syncs: []))
    let start = CaptureInstant(millis: base)

    let audio = try await source.samples(start..<start.advanced(by: 2_600))

    #expect(source.spans.map(\.interval) == [start..<start.advanced(by: 2_600)])
    #expect(audio.samples.count == 2_600 * 16)
    #expect(audio.samples[16_000..<25_600].allSatisfy { $0 == 0 })
    #expect(audio.samples[25_600...].contains { $0 != 0 })
    #expect(audio.gaps.isEmpty)
}

@Test func omiRecordsDecodeBackToBackFromTheirFirstStamp() async throws {
    let directory = temporaryDirectory()
    let store = try SourceStore(directory: directory)
    let omi = DeviceKind.omi.deviceID
    let packets = Array(try encode(signal(seconds: 1)).prefix(50))
    // Ten records of five frames, all stamped in the same second, as an Omi writes 100 ms of audio each.
    for index in 0..<10 {
        let record = OmiRecord.encode(
            timestampSeconds: UInt32(base / 1000), frames: Array(packets[index * 5..<(index + 1) * 5]))
        _ = try await store.persist(
            RawPage(
                key: PageKey(deviceID: omi, index: UInt64(index)), session: 0, deviceTimeMillis: base,
                payload: record, receivedAt: .now))
    }
    let scan = try await PageScan.scan(store, deviceID: omi, indices: 0...9)
    let source = SourceAudio(store: store, deviceID: omi, pages: scan.pages, clock: ClockModel(syncs: []))
    let start = CaptureInstant(millis: base)

    let audio = try await source.samples(start..<start.advanced(by: 1_000))

    #expect(scan.gaps.isEmpty)
    #expect(source.spans.map(\.interval) == [start..<start.advanced(by: 1_000)])
    #expect(audio.gaps.isEmpty)
    #expect(audio.samples[15_000...].contains { $0 != 0 }, "the last record plays at the end of the second")
}

@Test func preparedAudioIsDeterministicAndExactlyAsLongAsItsTimeMap() async throws {
    let directory = temporaryDirectory()
    let (store, _) = try await store(seconds: 10, at: directory)
    let scan = try await PageScan.scan(store, deviceID: device, indices: 0...9)
    let source = SourceAudio(store: store, deviceID: device, pages: scan.pages, clock: ClockModel(syncs: []))
    let start = CaptureInstant(millis: base)
    let part = try #require(
        TimeMap(segments: [
            start.advanced(by: 500)..<start.advanced(by: 3_210), start.advanced(by: 6_000)..<start.advanced(by: 9_990),
        ]))

    let first = try await PreparedAudio.render(part, from: source, to: directory.appending(path: "a.ogg"))
    let second = try await PreparedAudio.render(part, from: source, to: directory.appending(path: "b.ogg"))

    #expect(first.sha256 == second.sha256)
    #expect(first.durationMillis == part.preparedMillis)
    let file = try AVAudioFile(forReading: first.url)
    #expect(file.length == AVAudioFramePosition(part.preparedMillis * 48))
}

@Test func workerFailureNeverMovesAck() async throws {
    let directory = temporaryDirectory()
    let (store, _) = try await store(seconds: 3, at: directory)
    let ackable = try await store.ackableIndex(deviceID: device, startingAt: 0)
    let blocked = directory.appending(path: "not-a-directory")
    try Data().write(to: blocked)
    let worker = DerivedAudioWorker(
        store: store, output: DerivedAudioDirectory(url: blocked), canRunHeavyWork: { true })

    #expect(await worker.run { _ in } == 0)

    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == ackable)
    #expect(ackable == 2)
    #expect(try await store.claimJob() == nil)  // backed off, not lost
    #expect(try await store.claimJob(now: .now.addingTimeInterval(120)) != nil)
}

/// 12 s of audio derived by the worker (analysis included), from a capture long past.
private func derivedArchive() async throws
    -> (SourceStore, DerivedAudioWorker, DerivedAudioDirectory, PlaybackSegment)
{
    let directory = temporaryDirectory()
    let (store, _) = try await store(seconds: 12, at: directory)
    let output = DerivedAudioDirectory(url: directory.appending(path: "derived"))
    let worker = DerivedAudioWorker(store: store, output: output, canRunHeavyWork: { true })
    #expect(await worker.run { _ in } == 1)
    return (store, worker, output, try #require(output.manifest(deviceID: device).segments.only))
}

@Test func evictionDeletesOldAudioButKeepsItsSidecarAndAnalysis() async throws {
    let (store, worker, output, old) = try await derivedArchive()
    // Ended three days ago: kept.
    let recent = try output.writePlayback(
        deviceID: device, pages: 100...101, start: CaptureInstant(.now.addingTimeInterval(-3 * 86_400)), millis: 1_000
    ) { Array(repeating: 0, count: $0.count) }
    #expect(!old.activity.isEmpty)

    // Written just now: the grace day keeps even old audio.
    #expect(try await worker.evictPlayback() == 0)
    #expect(try await worker.evictPlayback(now: .now.addingTimeInterval(2 * 86_400)) == 1)

    let segments = try output.manifest(deviceID: device).segments
    let evicted = try #require(segments.first { $0.pages == old.pages })
    #expect(evicted.evicted == true)
    #expect(evicted.activity == old.activity)
    #expect(evicted.interval == old.interval)
    #expect(!FileManager.default.fileExists(atPath: output.audioURL(device, pages: old.pages).path))
    #expect(segments.first { $0.pages == recent.pages }?.evicted == nil)
    #expect(FileManager.default.fileExists(atPath: output.audioURL(device, pages: recent.pages).path))
    // A restored backup rebuilds missing audio, but not evicted audio, and a job never writes it again.
    #expect(try output.missingAudio().isEmpty)
    try await store.requeueJob(deviceID: device, indices: old.pages)
    #expect(await worker.run { _ in } == 1)
    #expect(!FileManager.default.fileExists(atPath: output.audioURL(device, pages: old.pages).path))
}

@Test func rebuildRestoresAnEvictedFileAndClearsTheMark() async throws {
    let (_, worker, output, old) = try await derivedArchive()
    try await worker.evictPlayback(now: .now.addingTimeInterval(2 * 86_400))
    let start = old.interval.lowerBound

    // Two players asking at once share one rebuild.
    async let first = worker.rebuildPlayback(deviceID: device, covering: start..<start.advanced(by: 1_000))
    async let second = worker.rebuildPlayback(deviceID: device, covering: start..<start.advanced(by: 1_000))
    #expect(try await [first, second] == [1, 1])
    #expect(try await worker.rebuildPlayback(deviceID: device, covering: old.interval) == 0)

    let rebuilt = try #require(output.manifest(deviceID: device).segments.only)
    #expect(rebuilt == old)
    let file = try AVAudioFile(forReading: output.audioURL(device, pages: old.pages))
    #expect(file.length == 12 * 16_000)
}

@Test func playbackTimelineMapsOffsetsToCaptureTimeAcrossFilesAndGaps() throws {
    let directory = DerivedAudioDirectory(url: temporaryDirectory())
    let start = CaptureInstant(millis: base)
    let voice = signal(seconds: 10)
    let first = try directory.writePlayback(deviceID: device, pages: 0...9, start: start, millis: 10_000) {
        Array(voice[$0])
    }
    // 2 s not recorded, then a second file.
    let second = try directory.writePlayback(
        deviceID: device, pages: 10...14, start: start.advanced(by: 12_000), millis: 5_000
    ) { Array(repeating: 0, count: $0.count) }
    let manifest = try directory.manifest(deviceID: device)
    #expect(manifest.segments == [first, second])
    #expect(try AVAudioFile(forReading: directory.audioURL(file: first.file, deviceID: device)).length == 10 * 16_000)

    // A conversation from 4 s into the first file to 1 s before the end of the second.
    let range = start.advanced(by: 4_000)..<start.advanced(by: 16_000)
    let timeline = PlaybackTimeline(range: range, manifest: manifest)

    #expect(
        timeline.pieces == [
            .init(file: first.file, fileMillis: 4_000..<10_000, offset: 0),
            .init(file: second.file, fileMillis: 0..<4_000, offset: 8_000),
        ])
    #expect(timeline.gaps == [start.advanced(by: 10_000)..<start.advanced(by: 12_000)])
    #expect(timeline.durationMillis == 12_000)
    let moment = start.advanced(by: 13_250)
    #expect(timeline.offset(of: moment) == 9_250)
    #expect(timeline.instant(atOffset: 9_250) == moment)
    // Clamped at both ends.
    #expect(timeline.offset(of: start) == 0)
    #expect(timeline.instant(atOffset: 60_000) == range.upperBound)
}

@Test func playbackTimelineNeverPlaysOverlappingFilesTwice() {
    let start = CaptureInstant(millis: base)
    let segment = { (file: String, from: Int64, to: Int64) in
        PlaybackSegment(
            deviceID: device, file: file, pages: 0...0, interval: start.advanced(by: from)..<start.advanced(by: to),
            decodeGaps: [], windows: [])
    }
    let manifest = PlaybackManifest(segments: [segment("a", 0, 6_000), segment("b", 5_000, 9_000)])

    let timeline = PlaybackTimeline(range: start..<start.advanced(by: 10_000), manifest: manifest)

    #expect(
        timeline.pieces == [
            .init(file: "a", fileMillis: 0..<6_000, offset: 0),
            .init(file: "b", fileMillis: 1_000..<4_000, offset: 6_000),
        ])
    #expect(timeline.gaps == [start.advanced(by: 9_000)..<start.advanced(by: 10_000)])
}

/// Samples from an array, starting at `start`.
private struct ArrayAudio: CaptureAudio {
    let start: CaptureInstant
    let samples: [Float]

    func pcm(_ interval: Range<CaptureInstant>) async throws -> [Float] {
        let first = Int(start.distance(to: interval.lowerBound)) * PendantAudio.samplesPerMilli
        return Array(samples[first..<first + Int(interval.millis) * PendantAudio.samplesPerMilli])
    }
}

/// A Who's this? clip plays a stretch of a job's Ogg Opus from the server, 15 minutes in. The bitrate there differs
/// from the file's average, so a guessed position played 30 s early, and the lit words never matched (Oct 15).
@Test func aClipFromOggOpusPlaysTheMomentAskedFor() async throws {
    let directory = temporaryDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let start = CaptureInstant(millis: base)
    // Loud noise for 40 s, then silence with one tone, from 75 s to 76 s.
    var seed: UInt64 = 7
    let samples = (0..<90 * 16_000).map { index -> Float in
        seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        if index < 40 * 16_000 { return Float(seed >> 40) / Float(1 << 24) * 0.8 - 0.4 }
        return (75 * 16_000..<76 * 16_000).contains(index) ? 0.5 * sin(Float(index) * 2 * .pi * 440 / 16_000) : 0
    }
    let part = try #require(TimeMap(segments: [start..<start.advanced(by: 90_000)]))
    let file = try await PreparedAudio.render(
        part, from: ArrayAudio(start: start, samples: samples), to: directory.appending(path: "job.ogg"))
    // The clip: 74 s into the file, for 4 s, as `.file(url, fileMillis:)` plays it.
    let range = start..<start.advanced(by: 4_000)
    let timeline = PlaybackTimeline(
        range: range, file: file.url.lastPathComponent, runs: [FileRun(interval: range, fileMillis: 74_000)])

    let composition = try await timeline.composition { directory.appending(path: $0) }

    let reader = try AVAssetReader(asset: composition)
    let output = AVAssetReaderAudioMixOutput(
        audioTracks: try await composition.loadTracks(withMediaType: .audio),
        audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
    let provider = reader.outputProvider(for: output)
    try reader.start()
    var bytes = Data()
    while let buffer = try await provider.next() {
        bytes += try buffer.withUnsafeSampleBuffer { try $0.dataBuffer?.dataBytes() } ?? Data()
    }
    let played = bytes.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    // The tone starts 1 s in, give or take Opus's lookahead.
    let onset = try #require(played.firstIndex { abs($0) > 0.1 })
    #expect(abs(onset - 16_000) < 16 * 20)
}

/// The server joins speech fragments into one Ogg by moving their packets (`audio.ts` `joinOggOpus`); its map's
/// `starts` says where each stretch begins (`fixtures/fragments`). Decoded here, each tone burst is where it says.
@Test func aJoinedOggPlaysEachToneWhereTheServersMapSays() throws {
    struct Fixture: Decodable {
        struct Tone: Decodable { var prepared: Double }
        struct Joined: Decodable { var file: String; var seconds: Double }
        var joined: Joined
        var tones: [Tone]
    }
    let fixtures = URL(filePath: #filePath).deletingLastPathComponent().appending(
        path: "../../../../../fixtures/fragments")
    let fixture = try JSONDecoder().decode(
        Fixture.self, from: Data(contentsOf: fixtures.appending(path: "fragments.json")))
    let file = try AVAudioFile(forReading: fixtures.appending(path: fixture.joined.file))
    let rate = file.processingFormat.sampleRate
    #expect(Double(file.length) == fixture.joined.seconds * rate)
    let buffer = try #require(
        AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
    try file.read(into: buffer)
    let samples = UnsafeBufferPointer(start: buffer.floatChannelData?[0], count: Int(buffer.frameLength))
    // A burst starts where a loud sample follows 50 ms of quiet.
    var onsets: [Double] = []
    var quiet = 0
    for (index, sample) in samples.enumerated() {
        if abs(sample) <= 0.1 {
            quiet += 1
            continue
        }
        if quiet > Int(rate / 20) { onsets.append(Double(index) / rate * 1000) }
        quiet = 0
    }
    #expect(onsets.count == fixture.tones.count)
    for (onset, tone) in zip(onsets, fixture.tones) {
        #expect(abs(onset - tone.prepared) < 1, "a tone at \(onset) ms, the map says \(tone.prepared)")
    }
}

extension Array {
    fileprivate var only: Element? { count == 1 ? first : nil }
}

/// Synthetic speech, then silence, then faint noise (Fixtures/vad-fixture.wav). The frame probabilities match the
/// Python reference (silero-vad 6.0.0, ONNX) the speech policy was audited with.
@Test func sileroMatchesTheReferenceModel() throws {
    let fixtures = try #require(Bundle.module.url(forResource: "Fixtures", withExtension: nil))
    let file = try AVAudioFile(forReading: fixtures.appending(path: "vad-fixture.wav"))
    let buffer = try #require(
        AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
    try file.read(into: buffer)
    let samples = Array(UnsafeBufferPointer(start: buffer.floatChannelData?[0], count: Int(buffer.frameLength)))
    let reference = try JSONDecoder().decode(
        [Float].self, from: Data(contentsOf: fixtures.appending(path: "vad-fixture.json")))

    let detector = try SileroDetector()
    try detector.append(samples)
    #expect(detector.probabilities.count == reference.count)
    let worst = zip(detector.probabilities, reference).map { abs($0 - $1) }.max() ?? 1
    #expect(worst < 0.05)

    let start = CaptureInstant(millis: 0)
    let windows = try detector.windows(start: start, millis: Int64(samples.count / 16))
    #expect(windows.prefix(3).allSatisfy { $0.activity == .speech })
    #expect(windows.suffix(3).allSatisfy { $0.activity == .silence })
}

@Test func manifestFollowsSidecarWritesAndRemovals() throws {
    let directory = DerivedAudioDirectory(url: temporaryDirectory())
    let start = CaptureInstant(millis: base)
    let silence = { (range: Range<Int>) in [Float](repeating: 0, count: range.count) }
    let first = try directory.writePlayback(
        deviceID: device, pages: 0...9, start: start, millis: 2_000, samples: silence)
    #expect(try directory.manifest(deviceID: device).segments == [first])
    // Read from memory, then a new sidecar, a rewritten one and a removed one each show on the next read.
    let second = try directory.writePlayback(
        deviceID: device, pages: 10...14, start: start.advanced(by: 3_000), millis: 2_000, samples: silence)
    #expect(try directory.manifest(deviceID: device).segments == [first, second])
    var evicted = second
    evicted.evicted = true
    try directory.write(evicted)
    #expect(try directory.manifest(deviceID: device).segments == [first, evicted])
    try FileManager.default.removeItem(at: directory.sidecarURL(device, pages: first.pages))
    #expect(try directory.manifest(deviceID: device).segments == [evicted])
}

@Test func recentAudioIsTheWindowBeforeTheEndFromTheNewestPages() async throws {
    let directory = temporaryDirectory()
    let (store, _) = try await store(seconds: 10, at: directory)
    let end = CaptureInstant(millis: base + 10_000)
    let file = try await RecentAudio.ogg(
        last: 3, before: end.date, store: store, deviceID: device, to: directory.appending(path: "press.ogg"))
    #expect(file.durationMillis == 3_000 && file.byteCount > 0)
    let source = try await RecentAudio.source(seconds: 3, store: store, deviceID: device)
    #expect(try await source.pcm(end.advanced(by: -3_000)..<end).contains { $0 != 0 })
    #expect(try await source.pcm(end.advanced(by: 60_000)..<end.advanced(by: 62_000)).allSatisfy { $0 == 0 })
    // The newest pages already reach the end: no wait.
    let wait = ContinuousClock.now
    try await RecentAudio.settle(until: end.date, store: store, deviceID: device, timeout: .seconds(2))
    #expect(ContinuousClock.now - wait < .milliseconds(100))
}

@Test func theLiveFeedReadsOnlyPagesAfterItsCursor() async throws {
    let (store, _) = try await store(seconds: 10, at: temporaryDirectory())
    let newest = try await RecentAudio.newestSeq(store: store, deviceID: device)
    #expect(try await RecentAudio.source(afterSeq: newest, store: store, deviceID: device) == nil)
    let all = try #require(try await RecentAudio.source(afterSeq: 0, store: store, deviceID: device))
    #expect(all.seq == newest)
    let later = try #require(try await RecentAudio.source(afterSeq: newest - 3, store: store, deviceID: device))
    let millis = { (audio: SourceAudio?) in audio?.spans.map(\.interval.millis).reduce(0, +) ?? 0 }
    #expect(later.seq == newest && millis(later.audio) == 3_000 && millis(all.audio) == 10_000)
}

@Test func aRecentWindowReadsOnlyTheClockSyncsFromItsPagesOn() async throws {
    let (store, _) = try await store(seconds: 10, at: temporaryDirectory())
    for index in [0, 4, 8] as [UInt64] {
        try await store.recordClockSync(
            ClockSync(firstPageIndex: index, phoneMillis: base, deviceMillisBeforeSet: nil), deviceID: device)
    }
    #expect(try await ClockModel.load(store, deviceID: device, from: 0).anchors.count == 3)
    let recent = try await ClockModel.load(store, deviceID: device, from: 6)
    #expect(recent.syncs.count == 3 && recent.anchors.map(\.pageIndex) == [4, 8], "the sync before page 6 on")
    // A sync whose first page isn't stored has no anchor: the one before it still times the pages after it.
    try await store.recordClockSync(
        ClockSync(firstPageIndex: 20, phoneMillis: base, deviceMillisBeforeSet: nil), deviceID: device)
    #expect(try await ClockModel.load(store, deviceID: device, from: 30).anchors.map(\.pageIndex) == [8])
}
