import Foundation

/// The owner's words from this phone's microphone while dictating, encoded as they come: 16 kHz mono PCM in, Ogg Opus
/// in memory out, through the same encoder and muxer as an upload (`PreparedAudio`). Nothing is written to disk.
public final class DictationRecording {
    /// A dictation stops taking sound before this: the server takes at most 10 minutes of audio.
    public static let capMillis: Int64 = 600_000

    private let encoder: OpusPacketEncoder
    private let writer: OggOpusWriter
    private var samples = 0
    /// What was heard since the stream last took a level, and that level.
    private var heard: (squares: Float, count: Int) = (0, 0)
    private var level: Float = 0

    public init() throws {
        encoder = try OpusPacketEncoder(bitRate: PreparedAudio.bitRate)
        writer = try OggOpusWriter(url: nil, preSkip: encoder.leadingSamples)
    }

    /// How long it holds, in ms.
    public var millis: Int64 { Int64(samples / PendantAudio.samplesPerMilli) }

    /// Takes 16 kHz mono samples; past the cap they're left out.
    public func append(_ new: [Float]) throws {
        let room = Int(Self.capMillis) * PendantAudio.samplesPerMilli - samples
        let taken = Array(new.prefix(max(0, room)))
        guard !taken.isEmpty else { return }
        try writer.append(encoder.encode(taken))
        // Counted only once encoded.
        samples += taken.count
        heard = (heard.squares + taken.reduce(0) { $0 + $1 * $1 }, heard.count + taken.count)
    }

    /// The loudness of everything appended since the last take, 0 to 1 (root mean square), so each of the field's
    /// bars is its whole moment, not only the buffer that came last; the last level again when nothing came since.
    public func takeLevel() -> Float {
        if heard.count > 0 { (level, heard) = ((heard.squares / Float(heard.count)).squareRoot(), (0, 0)) }
        return level
    }

    /// The whole stream, trimmed to the samples taken.
    public func finish() throws -> Data {
        try writer.append(encoder.encode(nil))
        _ = try writer.finish(totalSamples: samples)
        return writer.data
    }
}
