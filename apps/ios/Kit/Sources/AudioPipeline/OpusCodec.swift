import AVFoundation

/// Pendant audio: Opus, 16 kHz mono, one 20 ms packet per chunk (research/pendant.md §2.5–2.6).
public enum PendantAudio {
    public static let sampleRate = 16_000
    public static let samplesPerMilli = 16
    public static let samplesPerPacket = 320

    static func pcmFormat() throws(AudioPipelineError) -> AVAudioFormat {
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)
        else { throw .codecUnavailable }
        return format
    }

    static func opusFormat() throws(AudioPipelineError) -> AVAudioFormat {
        var description = AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate), mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(samplesPerPacket), mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0,
            mReserved: 0)
        guard let format = AVAudioFormat(streamDescription: &description) else { throw .codecUnavailable }
        return format
    }

    static func buffer(_ samples: [Float]) throws(AudioPipelineError) -> AVAudioPCMBuffer {
        guard
            let buffer = AVAudioPCMBuffer(
                pcmFormat: try pcmFormat(), frameCapacity: AVAudioFrameCount(max(samples.count, 1))),
            let channel = buffer.floatChannelData?[0]
        else { throw .codecUnavailable }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            if let base = source.baseAddress { channel.update(from: base, count: samples.count) }
        }
        return buffer
    }
}

public enum AudioPipelineError: Error, Equatable {
    case codecUnavailable
    case encodeFailed(String)
    /// A stored page no longer yields the packet count it was scanned with.
    case pageChanged(UInt64)
    /// An audio file is not 16 kHz mono, so it can't be placed sample-exactly.
    case notSixteenKilohertzMono
}

/// Audio that could not be decoded. It is played and analyzed as silence, and always recorded.
public struct DecodeGap: Sendable, Equatable, Codable {
    public enum Reason: String, Sendable, Codable, Error {
        /// The Opus decoder produced nothing for this packet (corrupt or malformed).
        case rejectedPacket
        /// The packet decoded to a length other than 20 ms; it was padded or cut to 20 ms.
        case unexpectedLength
        /// The page's protobuf could not be parsed. It is left out of the timeline, which then sees missing pages.
        case unreadablePage
        /// The page holds encrypted audio (a previous host pushed a key).
        case encryptedPage
    }

    public var page: UInt64
    /// Packet position within the page; `nil` for the whole page.
    public var packet: Int?
    public var reason: Reason

    public init(page: UInt64, packet: Int?, reason: Reason) {
        self.page = page
        self.packet = packet
        self.reason = reason
    }
}

/// Decodes one continuous run of packets through `AVAudioConverter`. Every packet yields exactly 320 samples so
/// packet k stays at k × 20 ms. Short DTX packets decode through the codec (concealment or silence). The codec drops
/// a corrupt packet without an error, so a packet that yields nothing is replaced by silence and reported.
final class OpusPacketDecoder {
    enum Outcome: Equatable {
        case decoded
        case rejected
        case unexpectedLength(Int)
    }

    private let converter: AVAudioConverter
    private let output: AVAudioPCMBuffer
    private let channel: UnsafeMutablePointer<Float>
    private var started = false

    init() throws(AudioPipelineError) {
        // One Opus packet holds at most 120 ms.
        guard let converter = AVAudioConverter(from: try PendantAudio.opusFormat(), to: try PendantAudio.pcmFormat()),
            let output = AVAudioPCMBuffer(pcmFormat: try PendantAudio.pcmFormat(), frameCapacity: 6 * 320 * 3),
            let channel = output.floatChannelData?[0]
        else { throw .codecUnavailable }
        self.converter = converter
        self.output = output
        self.channel = channel
    }

    func decode(_ packet: Data, into samples: inout [Float]) -> Outcome {
        let input = AVAudioCompressedBuffer(
            format: converter.inputFormat, packetCapacity: 1, maximumPacketSize: max(packet.count, 1))
        packet.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress { input.data.copyMemory(from: base, byteCount: packet.count) }
        }
        input.byteLength = UInt32(packet.count)
        input.packetCount = 1
        input.packetDescriptions?[0] = AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))

        output.frameLength = 0
        let feed = OneShot(input)
        let status = converter.convert(to: output, error: nil) { _, status in
            guard let buffer = feed.take() else {
                status.pointee = .noDataNow
                return nil
            }
            status.pointee = .haveData
            return buffer
        }
        let count = status == .error ? 0 : Int(output.frameLength)
        let first = !started
        started = started || count > 0
        let packetSamples = PendantAudio.samplesPerPacket
        guard count > 0 else {
            converter.reset()
            started = false
            samples.append(contentsOf: repeatElement(0, count: packetSamples))
            return .rejected
        }
        let decoded = UnsafeBufferPointer(start: channel, count: min(count, packetSamples))
        // The codec trims its 2.5 ms start-up delay from the first packet: pad at the front to keep 20 ms.
        samples.append(contentsOf: repeatElement(0, count: packetSamples - decoded.count))
        samples.append(contentsOf: decoded)
        return count == packetSamples || (first && count < packetSamples) ? .decoded : .unexpectedLength(count)
    }
}

/// Encodes 16 kHz mono PCM to Opus packets, pushed in chunks. Deterministic for identical input.
final class OpusPacketEncoder {
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    /// Encoder start-up samples at the head of the stream (Ogg pre-skip).
    let leadingSamples: Int

    init(bitRate: Int) throws(AudioPipelineError) {
        let format = try PendantAudio.opusFormat()
        guard let converter = AVAudioConverter(from: try PendantAudio.pcmFormat(), to: format) else {
            throw .codecUnavailable
        }
        converter.bitRate = bitRate
        self.converter = converter
        self.format = format
        leadingSamples = Int(converter.primeInfo.leadingFrames)
    }

    /// Encodes `samples` (or flushes the stream when `nil`) and returns the packets completed so far.
    func encode(_ samples: [Float]?) throws(AudioPipelineError) -> [Data] {
        let feed = OneShot(try samples.map { samples throws(AudioPipelineError) in try PendantAudio.buffer(samples) })
        let ending = samples == nil
        var packets: [Data] = []
        while true {
            let out = AVAudioCompressedBuffer(
                format: format, packetCapacity: 64, maximumPacketSize: converter.maximumOutputPacketSize)
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, status in
                if let buffer = feed.take() {
                    status.pointee = .haveData
                    return buffer
                }
                status.pointee = ending ? .endOfStream : .noDataNow
                return nil
            }
            for index in 0..<Int(out.packetCount) {
                guard let description = out.packetDescriptions?[index] else { break }
                packets.append(
                    Data(bytes: out.data + Int(description.mStartOffset), count: Int(description.mDataByteSize)))
            }
            switch status {
            case .haveData: continue
            case .error: throw .encodeFailed(error?.localizedDescription ?? "unknown")
            default: return packets
            }
        }
    }
}

/// Hands one buffer to a converter input block, then nothing. Used synchronously within `convert`.
private final class OneShot: @unchecked Sendable {
    // Safety: `convert(to:error:withInputFrom:)` calls the block synchronously on the calling thread.
    private var buffer: AVAudioBuffer?

    init(_ buffer: AVAudioBuffer?) { self.buffer = buffer }

    func take() -> AVAudioBuffer? {
        defer { buffer = nil }
        return buffer
    }
}
