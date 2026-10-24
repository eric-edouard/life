import AVFoundation
import AudioPipeline
import Library
import Timeline

/// An audio file and the capture time it covers: `fileMillis` into the file is `interval.lowerBound`.
public struct AudioSource: Sendable, Equatable {
    public var url: URL
    public var interval: Range<CaptureInstant>
    public var fileMillis: Int64

    public init(url: URL, interval: Range<CaptureInstant>, fileMillis: Int64 = 0) {
        self.url = url
        self.interval = interval
        self.fileMillis = fileMillis
    }

    /// The device's derived playback files (AAC, 10 minutes at most each).
    public static func derived(_ directory: DerivedAudioDirectory, deviceID: String) throws -> [AudioSource] {
        try directory.manifest(deviceID: deviceID).segments.map {
            AudioSource(url: directory.audioURL($0.deviceID, pages: $0.pages), interval: $0.interval)
        }
    }

    /// The audio of conversations imported from the old app, run by run (`LibraryStore.importedAudio(of:)`).
    /// ponytail: one source list serves a whole export, so a Pendant conversation exported alongside an imported one
    /// that overlaps it in time would take the imported audio there. The two never overlap in practice: the old app
    /// drained the same Pendant.
    public static func imported(_ audio: [ImportedAudio], in library: LibraryStore) -> [AudioSource] {
        audio.flatMap { audio in
            let url = library.importedAudio.appending(path: audio.file)
            return audio.runs.map { AudioSource(url: url, interval: $0.interval, fileMillis: $0.fileMillis) }
        }
    }
}

public enum AudioFormat: String, Sendable, CaseIterable {
    case m4a
    case wav

    public var fileName: String {
        switch self {
        case .m4a: ExportPackage.compressedAudio
        case .wav: ExportPackage.wavAudio
        }
    }

    /// AAC at 32 kbps (above playback's 24, so re-encoding loses little), or 16-bit PCM. Both 16 kHz mono.
    var settings: [String: Any] {
        switch self {
        case .m4a:
            [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: PendantAudio.sampleRate,
                AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
            ]
        case .wav:
            [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: PendantAudio.sampleRate,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
            ]
        }
    }
}

/// Renders an exact capture range as audio: what was recorded plays where it was recorded, and silence fills the
/// rest, so `audio time = capture time - range start` everywhere and the file is exactly as long as the range.
///
/// The derived files are decoded and re-encoded in one streaming pass (30 s held at once). Passthrough was tried
/// and rejected: AVFoundation refuses to splice several AAC files without re-encoding (-16976), and a composition
/// drops trailing silence, so the length would be wrong.
public enum RangeAudio {
    static let chunkFrames = 30 * PendantAudio.sampleRate

    /// Stretches of `range` no source covers: the Pendant recorded nothing there, so the export holds silence.
    /// ponytail: audio not yet derived also counts as unrecorded; export once processing has caught up.
    public static func unrecorded(in range: Range<CaptureInstant>, sources: [AudioSource]) -> [Range<CaptureInstant>] {
        var gaps: [Range<CaptureInstant>] = []
        var cursor = range.lowerBound
        for source in sorted(sources, in: range) {
            if source.interval.lowerBound > cursor { gaps.append(cursor..<source.interval.lowerBound) }
            cursor = max(cursor, source.interval.upperBound)
        }
        if cursor < range.upperBound { gaps.append(cursor..<range.upperBound) }
        return gaps
    }

    /// Writes `range` once into every requested format. `progress` gets the fraction written, from 0 to 1.
    /// Cancellable between chunks; a cancelled export leaves partial files for the caller to discard.
    @concurrent
    public static func write(
        _ range: Range<CaptureInstant>, from sources: [AudioSource], to outputs: [AudioFormat: URL],
        progress: @Sendable (Double) -> Void = { _ in }
    ) async throws {
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(PendantAudio.sampleRate), channels: 1,
                interleaved: false),
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(chunkFrames))
        else { throw AudioExportError.unsupportedAudio }
        let files = try outputs.map { output, url in
            try AVAudioFile(
                forWriting: url, settings: output.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        defer { files.forEach { $0.close() } }
        let total = max(range.millis, 1)
        var cursor = range.lowerBound

        /// Writes `millis` from `source` (at its current position) or silence, chunk by chunk.
        func emit(_ millis: Int64, from source: AVAudioFile?) throws {
            var remaining = Int(millis) * PendantAudio.samplesPerMilli
            while remaining > 0 {
                try Task.checkCancellation()
                let count = min(remaining, chunkFrames)
                buffer.frameLength = 0
                if let source { try source.read(into: buffer, frameCount: AVAudioFrameCount(count)) }
                // Silence, or the tail of a file shorter than its sidecar says: the length stays exact.
                let read = Int(buffer.frameLength)
                if let channel = buffer.floatChannelData?[0], read < count {
                    (channel + read).update(repeating: 0, count: count - read)
                }
                buffer.frameLength = AVAudioFrameCount(count)
                for file in files { try file.write(from: buffer) }
                remaining -= count
            }
        }

        for source in sorted(sources, in: range) {
            let start = max(cursor, source.interval.lowerBound)
            let end = min(source.interval.upperBound, range.upperBound)
            guard start < end else { continue }
            try emit(cursor.distance(to: start), from: nil)
            let file = try AVAudioFile(forReading: source.url, commonFormat: .pcmFormatFloat32, interleaved: false)
            guard file.processingFormat.sampleRate == format.sampleRate, file.processingFormat.channelCount == 1
            else { throw AudioExportError.unsupportedAudio }
            file.framePosition =
                (source.fileMillis + source.interval.lowerBound.distance(to: start))
                * Int64(PendantAudio.samplesPerMilli)
            try emit(start.distance(to: end), from: file)
            cursor = end
            progress(Double(range.lowerBound.distance(to: cursor)) / Double(total))
        }
        try emit(cursor.distance(to: range.upperBound), from: nil)
        progress(1)
    }

    private static func sorted(_ sources: [AudioSource], in range: Range<CaptureInstant>) -> [AudioSource] {
        sources.filter { $0.interval.overlaps(range) }.sorted { $0.interval.lowerBound < $1.interval.lowerBound }
    }
}

public enum AudioExportError: Error, Equatable {
    /// A derived file is not 16 kHz mono, so it can't be placed sample-exactly.
    case unsupportedAudio
}
