import CryptoKit
import Foundation
import Timeline

/// One prepared upload file.
public struct PreparedFile: Sendable, Equatable {
    public var url: URL
    /// Lowercase hex SHA-256 of the file bytes. Identical input gives identical bytes, so the server's audio-hash
    /// idempotency recognizes a re-upload.
    public var sha256: String
    /// Exactly `TimeMap.preparedMillis`.
    public var durationMillis: Int64
    public var byteCount: Int
}

/// Renders an upload part: its kept capture intervals back to back with 0.4 s of digital silence between them, as
/// Ogg Opus (24 kbps VBR, about 18 kbps on speech), which ElevenLabs accepts. AVFoundation encodes the Opus packets;
/// it can't write Ogg, so `OggOpusWriter` muxes them. AAC in `.m4a` isn't deterministic (the container stamps the
/// write time) and FLAC is about ten times larger.
public enum PreparedAudio {
    public static let bitRate = 24_000
    static let chunkMillis: Int64 = 30_000

    public static func render(_ part: TimeMap, from source: some CaptureAudio, to url: URL) async throws -> PreparedFile
    {
        let encoder = try OpusPacketEncoder(bitRate: bitRate)
        let writer = try OggOpusWriter(url: url, preSkip: encoder.leadingSamples)
        let separator = [Float](repeating: 0, count: Int(TimeMap.separatorMillis) * PendantAudio.samplesPerMilli)
        for (index, segment) in part.segments.enumerated() {
            if index > 0 { try writer.append(encoder.encode(separator)) }
            var cursor = segment.lowerBound
            while cursor < segment.upperBound {
                try Task.checkCancellation()
                let end = min(cursor.advanced(by: chunkMillis), segment.upperBound)
                try writer.append(encoder.encode(try await source.pcm(cursor..<end)))
                cursor = end
            }
        }
        try writer.append(encoder.encode(nil))
        let total = Int(part.preparedMillis) * PendantAudio.samplesPerMilli
        let (digest, bytes) = try writer.finish(totalSamples: total)
        return PreparedFile(url: url, sha256: digest, durationMillis: part.preparedMillis, byteCount: bytes)
    }
}

/// A minimal Ogg Opus muxer (RFC 7845) for 16 kHz mono packets of 20 ms: OpusHead, OpusTags, then audio pages of up
/// to 50 packets. The last page's granule position trims the stream to its exact length.
final class OggOpusWriter {
    private static let serial: UInt32 = 0x6C69_6665  // fixed, so output is deterministic
    private static let packetsPerPage = 50
    /// Granule positions count 48 kHz samples.
    private static let granulesPerSample = 3

    private let handle: FileHandle
    private let preSkip: Int
    private var hasher = SHA256()
    private var bytes = 0
    private var sequence: UInt32 = 0
    private var packets = 0
    private var pending: [Data] = []

    init(url: URL, preSkip: Int) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: 0)
        self.preSkip = preSkip * Self.granulesPerSample
        var head = Data("OpusHead".utf8)
        head += [1, 1]  // version, channels
        head += Self.littleEndian(UInt16(self.preSkip))
        head += Self.littleEndian(UInt32(PendantAudio.sampleRate))
        head += [0, 0, 0]  // output gain, channel mapping family
        try page([head], granule: 0, flags: 0x02)
        let vendor = Data("lifelog".utf8)
        try page(
            [Data("OpusTags".utf8) + Self.littleEndian(UInt32(vendor.count)) + vendor + Self.littleEndian(UInt32(0))],
            granule: 0, flags: 0)
    }

    func append(_ new: [Data]) throws {
        for packet in new {
            if pending.count == Self.packetsPerPage {
                try page(pending, granule: Int64(packets) * 960, flags: 0)
                pending = []
            }
            pending.append(packet)
            packets += 1
        }
    }

    /// Writes the last page and returns the file's SHA-256 (hex) and size.
    func finish(totalSamples: Int) throws -> (String, Int) {
        try page(pending, granule: Int64(preSkip + totalSamples * Self.granulesPerSample), flags: 0x04)
        try handle.close()
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), bytes)
    }

    private func page(_ packets: [Data], granule: Int64, flags: UInt8) throws {
        var lacing: [UInt8] = []
        for packet in packets {
            lacing += repeatElement(255, count: packet.count / 255)
            lacing.append(UInt8(packet.count % 255))
        }
        var page = Data("OggS".utf8)
        page += [0, flags]
        page += Self.littleEndian(UInt64(bitPattern: granule))
        page += Self.littleEndian(Self.serial)
        page += Self.littleEndian(sequence)
        page += Self.littleEndian(UInt32(0))  // checksum, filled below
        page.append(UInt8(lacing.count))
        page += lacing
        for packet in packets { page += packet }
        page.replaceSubrange(22..<26, with: Self.littleEndian(Self.crc(page)))
        try handle.write(contentsOf: page)
        hasher.update(data: page)
        bytes += page.count
        sequence += 1
    }

    private static func littleEndian<T: FixedWidthInteger>(_ value: T) -> Data {
        withUnsafeBytes(of: value.littleEndian) { Data($0) }
    }

    private static let crcTable: [UInt32] = (0..<256).map { index in
        var value = UInt32(index) << 24
        for _ in 0..<8 { value = value & 0x8000_0000 != 0 ? (value << 1) ^ 0x04C1_1DB7 : value << 1 }
        return value
    }

    /// Ogg's CRC-32: polynomial 0x04C11DB7, no reflection, zero initial value.
    private static func crc(_ data: Data) -> UInt32 {
        data.reduce(0) { ($0 << 8) ^ crcTable[Int(($0 >> 24) ^ UInt32($1))] }
    }
}
