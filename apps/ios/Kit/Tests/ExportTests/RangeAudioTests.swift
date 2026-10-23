import AVFoundation
import Export
import Foundation
import Library
import Testing
import Timeline

private let base: Int64 = 1_790_000_000_000

private func at(_ offset: Int64) -> CaptureInstant { CaptureInstant(millis: base + offset) }

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(
        path: "range-audio-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// A synthetic derived playback file: AAC 16 kHz mono, a tone of `amplitude`, exactly `interval` long.
private func segment(_ interval: Range<CaptureInstant>, amplitude: Float, in directory: URL) throws -> AudioSource {
    let url = directory.appending(path: "\(interval.lowerBound.millis).m4a")
    let file = try AVAudioFile(
        forWriting: url,
        settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 24_000,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
    let frames = AVAudioFrameCount(interval.millis * 16)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
    buffer.frameLength = frames
    let channel = try #require(buffer.floatChannelData?[0])
    for index in 0..<Int(frames) { channel[index] = amplitude * sin(Float(index) * 0.2) }
    try file.write(from: buffer)
    file.close()
    return AudioSource(url: url, interval: interval)
}

private func samples(_ url: URL) throws -> [Float] {
    let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
    let buffer = try #require(
        AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
    try file.read(into: buffer)
    let channel = try #require(buffer.floatChannelData?[0])
    return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
}

/// Root mean square over milliseconds of audio time.
private func level(_ samples: [Float], _ millis: Range<Int>) -> Float {
    let window = samples[(millis.lowerBound * 16)..<(millis.upperBound * 16)]
    return (window.reduce(0) { $0 + $1 * $1 } / Float(window.count)).squareRoot()
}

/// Recorded 1.0–3.0 s (loud) and 3.0–4.0 s (quiet), nothing until 6.0 s, then 6.0–7.0 s. The export covers
/// 0.5–6.5 s: silence first, both files, a 2 s hole, and the start of the last file.
private func fixture() throws -> (sources: [AudioSource], range: Range<CaptureInstant>, directory: URL) {
    let directory = try temporaryDirectory()
    let sources = [
        try segment(at(6000)..<at(7000), amplitude: 0.5, in: directory),
        try segment(at(1000)..<at(3000), amplitude: 0.5, in: directory),
        try segment(at(3000)..<at(4000), amplitude: 0.1, in: directory),
    ]
    return (sources, at(500)..<at(6500), directory)
}

@Test func rangeAudioIsExactlyAsLongAsTheRangeWithSilenceWhereNothingWasRecorded() async throws {
    let (sources, range, directory) = try fixture()
    #expect(RangeAudio.unrecorded(in: range, sources: sources) == [at(500)..<at(1000), at(4000)..<at(6000)])

    let outputs: [AudioFormat: URL] = [
        .m4a: directory.appending(path: "out.m4a"), .wav: directory.appending(path: "out.wav"),
    ]
    try await RangeAudio.write(range, from: sources, to: outputs)

    // Audio time = capture time - range start, to the sample, in both files.
    for url in outputs.values {
        #expect(try AVAudioFile(forReading: url).length == range.millis * 16, "\(url.lastPathComponent)")
    }
    let wav = try samples(try #require(outputs[.wav]))
    #expect(level(wav, 0..<500) == 0)
    #expect(level(wav, 3500..<5500) == 0)
    // Edges land on the right millisecond: recorded audio right up to the hole, silence right after it.
    #expect(level(wav, 3490..<3500) > 0.02)
    #expect(level(wav, 5500..<5510) > 0.1)
    #expect(level(wav, 600..<2400) > 0.3)  // the loud file
    #expect((0.05..<0.1).contains(level(wav, 2600..<3400)))  // the quiet one, in its place

    let m4a = try samples(try #require(outputs[.m4a]))
    #expect(level(m4a, 3700..<5300) < 0.001)
    #expect(level(m4a, 600..<2400) > 0.3)

    // A range inside one file starts at the right offset of that file.
    let inside = directory.appending(path: "inside.wav")
    try await RangeAudio.write(at(2000)..<at(2500), from: sources, to: [.wav: inside])
    let part = try samples(inside)
    #expect(part.count == 500 * 16 && level(part, 0..<500) > 0.3)
}

@Test func exportJobWritesAudioTextAndStatesWhatIsMissing() async throws {
    let (sources, _, directory) = try fixture()
    let library = try LibraryStore(directory: directory.appending(path: "library"))
    let id = ConversationID(anchor: at(500)).serverID
    let iso = { (instant: CaptureInstant) in
        instant.date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
    try await library.apply(
        feed: Data(
            #"""
            {"cursor":"1","conversations":[{"id":"\#(id.uuidString.lowercased())","startAt":"\#(iso(at(500)))",
             "endAt":"\#(iso(at(6500)))","kind":"conversation","retired":null}]}
            """#.utf8), withdrawn: { _ in })

    let missing = UUID()
    let result = try await ExportJob.run(
        ExportRequest(conversations: [id, missing], audio: [.m4a], text: [.json, .txt]), library: library,
        audio: sources, timeZone: .gmt, appVersion: "test", in: directory.appending(path: "work"))

    #expect(result.share.pathExtension == "zip")
    #expect(
        result.manifest.unsupported == [
            .init(item: missing.uuidString.lowercased(), what: "conversation", reason: "Not in the library.")
        ])
    let item = try #require(result.manifest.items.first)
    #expect(
        item.files.map { $0.path.split(separator: "/").last ?? "" } == [
            "audio.m4a", "conversation.json", "transcript.txt",
        ])
    let document = try JSONDecoder().decode(
        ConversationDocument.self,
        from: Data(contentsOf: result.folder.appending(path: "\(item.folder)/conversation.json")))
    #expect(document.unrecorded.map(\.start.audioMs) == [0, 3500])
    #expect(document.transcriptAbsent == "No words were transcribed in this range.")
}
