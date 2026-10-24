import AVFoundation
import Timeline

/// Decoded 16 kHz mono capture audio, for uploads and voice samples: the Pendant's pages (`SourceAudio`) or an
/// imported recording's own file (`FileAudio`).
public protocol CaptureAudio: Sendable {
    /// Exactly `interval.millis × 16` samples; moments without audio are silence.
    func pcm(_ interval: Range<CaptureInstant>) async throws -> [Float]
}

extension SourceAudio: CaptureAudio {
    public func pcm(_ interval: Range<CaptureInstant>) async throws -> [Float] { try await samples(interval).samples }
}

/// An imported recording's audio, read run by run from its own file. Moments no run covers are silence.
public struct FileAudio: CaptureAudio {
    public let url: URL
    public let runs: [FileRun]

    public init(url: URL, runs: [FileRun]) {
        self.url = url
        self.runs = runs
    }

    /// Opens a file as 16 kHz mono, the only format placed sample-exactly, with its length in milliseconds.
    public static func open(_ url: URL) throws -> (file: AVAudioFile, millis: Int64) {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard file.processingFormat.sampleRate == Double(PendantAudio.sampleRate),
            file.processingFormat.channelCount == 1
        else { throw AudioPipelineError.notSixteenKilohertzMono }
        return (file, file.length / Int64(PendantAudio.samplesPerMilli))
    }

    public func pcm(_ interval: Range<CaptureInstant>) async throws -> [Float] {
        let perMilli = PendantAudio.samplesPerMilli
        var samples = [Float](repeating: 0, count: Int(interval.millis) * perMilli)
        let overlapping = runs.filter { $0.interval.overlaps(interval) }
        guard !overlapping.isEmpty else { return samples }
        let file = try Self.open(url).file
        for run in overlapping {
            let start = max(run.interval.lowerBound, interval.lowerBound)
            let end = min(run.interval.upperBound, interval.upperBound)
            file.framePosition = (run.fileMillis + run.interval.lowerBound.distance(to: start)) * Int64(perMilli)
            // A file a little shorter than its runs say ends in silence.
            let count = min(Int(start.distance(to: end)) * perMilli, Int(max(file.length - file.framePosition, 0)))
            guard count > 0,
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(count))
            else { continue }
            try file.read(into: buffer, frameCount: AVAudioFrameCount(count))
            guard let channel = buffer.floatChannelData?[0] else { continue }
            let offset = Int(interval.lowerBound.distance(to: start)) * perMilli
            for index in 0..<Int(buffer.frameLength) { samples[offset + index] = channel[index] }
        }
        return samples
    }
}
