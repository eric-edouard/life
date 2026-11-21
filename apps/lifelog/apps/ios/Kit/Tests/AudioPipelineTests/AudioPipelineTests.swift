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

/// Samples from an array, starting at `start`.
private struct ArrayAudio: CaptureAudio {
    let start: CaptureInstant
    let samples: [Float]

    func pcm(_ interval: Range<CaptureInstant>) async throws -> [Float] {
        let first = Int(start.distance(to: interval.lowerBound)) * PendantAudio.samplesPerMilli
        return Array(samples[first..<first + Int(interval.millis) * PendantAudio.samplesPerMilli])
    }
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

@Test func aDictationIsEncodedInMemoryAsTheSameOggAsAFileExactlyAsLongAndCappedAtTenMinutes() async throws {
    // 1.23 s of a tone in uneven chunks: a partial last page, and a last packet short of 20 ms.
    let tone = (0..<19_680).map { Float(sin(Double($0) * 0.05)) * 0.3 }
    let recording = try DictationRecording()
    for chunk in stride(from: 0, to: tone.count, by: 1_000) {
        try recording.append(Array(tone[chunk..<min(chunk + 1_000, tone.count)]))
    }
    #expect(recording.millis == 1_230)
    #expect(recording.level > 0.1)
    let memory = try recording.finish()

    // The same samples through the file writer give the same bytes.
    let url = FileManager.default.temporaryDirectory.appending(path: "dictation-\(UUID().uuidString).ogg")
    let encoder = try OpusPacketEncoder(bitRate: PreparedAudio.bitRate)
    let writer = try OggOpusWriter(url: url, preSkip: encoder.leadingSamples)
    for chunk in stride(from: 0, to: tone.count, by: 1_000) {
        try writer.append(encoder.encode(Array(tone[chunk..<min(chunk + 1_000, tone.count)])))
    }
    try writer.append(encoder.encode(nil))
    _ = try writer.finish(totalSamples: tone.count)
    #expect(memory == (try Data(contentsOf: url)))
    #expect(try AVAudioFile(forReading: url).length == AVAudioFramePosition(1_230 * 48))

    let long = try DictationRecording()
    let minute = [Float](repeating: 0, count: 60 * PendantAudio.sampleRate)
    for _ in 0..<11 { try long.append(minute) }
    #expect(long.millis == DictationRecording.capMillis)
}

@MainActor @Test func aLatePlaybackStopNeverLetsGoOfTheSessionADictationTookAfterIt() throws {
    var applied: [AudioSessionOwner.Use?] = []
    var playbackEnded = 0
    let owner = AudioSessionOwner { applied.append($0) }
    let playback = try owner.take(.playback) { playbackEnded += 1 }
    let recording = try owner.take(.recording) {}
    #expect(playbackEnded == 1, "the newer lease ends the player")
    owner.release(playback)
    #expect(applied == [.playback, .recording], "the player's late stop leaves the microphone on")
    owner.release(recording)
    #expect(applied == [.playback, .recording, nil])

    // The app's own let-go of an earlier turn, arriving late, ends nothing; the system taking the session ends the
    // holder and lets it go, once.
    var recordingEnded = 0
    _ = try owner.take(.recording) { recordingEnded += 1 }
    owner.sessionBecameInactive(byApp: true)
    #expect(recordingEnded == 0)
    owner.sessionBecameInactive(byApp: false)
    owner.sessionBecameInactive(byApp: false)
    #expect(recordingEnded == 1 && applied.suffix(2) == [.recording, nil])

    // A set-up that fails leaves no holder.
    let failing = AudioSessionOwner { if $0 != nil { throw AudioPipelineError.unsupportedInput } }
    #expect(throws: AudioPipelineError.unsupportedInput) { _ = try failing.take(.recording) {} }
}

@Test func theMicrophoneIsResampledTo16kHzMonoTheSameInPiecesAsWhole() throws {
    // A fake input: 44.1 kHz mono, one second of a tone, as the tap hands it.
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1))
    func buffer(_ from: Int, _ count: Int) throws -> AVAudioPCMBuffer {
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)))
        buffer.frameLength = AVAudioFrameCount(count)
        for index in 0..<count { buffer.floatChannelData![0][index] = Float(sin(Double(from + index) * 0.03)) * 0.3 }
        return buffer
    }
    let whole = try Resampler(from: format).samples(of: buffer(0, 44_100))
    let pieces = try Resampler(from: format)
    let pieced = try stride(from: 0, to: 44_100, by: 1_024).flatMap {
        try pieces.samples(of: buffer($0, min(1_024, 44_100 - $0)))
    }
    #expect(abs(whole.count - 16_000) < 64 && abs(pieced.count - whole.count) < 64)
    let shared = min(whole.count, pieced.count) - 64
    #expect(zip(whole.prefix(shared), pieced.prefix(shared)).allSatisfy { abs($0 - $1) < 1e-4 })
}

@MainActor @Test func aBufferThatCantBeTakenEndsTheRecordingAndNothingAfterItIsTaken() async throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
    let other = try #require(AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1))
    func buffer(_ format: AVAudioFormat) throws -> AVReadOnlyAudioPCMBuffer {
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_800))
        buffer.frameLength = 4_800
        for index in 0..<4_800 { buffer.floatChannelData![0][index] = Float(sin(Double(index) * 0.03)) * 0.3 }
        return AVReadOnlyAudioPCMBuffer(copying: buffer)
    }
    let recording = try DictationRecording()
    let (buffers, sink) = MicCapture.Buffers.makeStream()
    for next in [format, other, format] { sink.yield(try buffer(next)) }
    sink.finish()
    await #expect(throws: AudioPipelineError.unsupportedInput) {
        try await MicCapture.take(buffers, with: Resampler(from: format), into: recording)
    }
    #expect(abs(recording.millis - 100) <= 2, "the first buffer only")

    // A queue with no room left ends the stream with an overrun, after what it holds.
    let (full, tap) = MicCapture.Buffers.makeStream(bufferingPolicy: .bufferingOldest(1))
    for _ in 0..<2 { MicCapture.offer(try buffer(format), to: tap) }
    let overrun = try DictationRecording()
    await #expect(throws: AudioPipelineError.microphoneOverrun) {
        try await MicCapture.take(full, with: Resampler(from: format), into: overrun)
    }
    #expect(overrun.millis > 0)
}
