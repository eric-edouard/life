import Foundation

/// Which pendant a source holds. A source id names its kind, so its pages are read the right way long after capture.
public enum DeviceKind: String, Sendable, Codable {
    case limitless
    case omi

    /// The store's slot and the server's source id. The server needs nothing per kind: any id is a Pendant's.
    public var deviceID: String {
        switch self {
        case .limitless: "limitless-pendant"
        case .omi: "omi-pendant"
        }
    }

    public init(deviceID: String) { self = deviceID.hasPrefix("omi") ? .omi : .limitless }

    /// The one reading of a page's bytes as stored: a Limitless `StorageBufferMsg`, or an Omi ring record. Capture
    /// settles pages with it and the audio pipeline plays them with it.
    public func decodePage(_ payload: Data) throws(ProtocolError) -> DecodedPage {
        switch self {
        case .limitless:
            let buffer = try StorageBuffer(decoding: payload)
            let page = try FlashPage(decoding: buffer.flashPage ?? Data())
            // Each packet plays at its chunk's offset, 20 ms after the one before it in the same chunk.
            let packets = page.chunks.flatMap { chunk in
                (chunk.audio?.opusPackets ?? []).enumerated().map {
                    (offsetMillis: (chunk.timeOffsetMillis ?? 0) + Int64($0.offset) * 20, data: $0.element)
                }
            }
            return DecodedPage(
                timestampMillis: page.timestampMillis, boot: buffer.run, uptimeMillis: page.bootUptimeMillis,
                packets: packets, encrypted: page.isEncrypted, clockStepMillis: nil)
        case .omi:
            let record = try OmiRecord(decoding: payload)
            // Frames back to back from the record's stamp, a whole second.
            return DecodedPage(
                timestampMillis: record.timestampSeconds.map { UInt64($0) * 1000 }, boot: 0, uptimeMillis: nil,
                packets: record.frames.enumerated().map { (offsetMillis: Int64($0.offset) * 20, data: $0.element) },
                encrypted: false, clockStepMillis: 1000)
        }
    }
}

/// A page's bytes as the drain and the timeline need them.
public struct DecodedPage: Sendable {
    /// The device's clock when the page opened (Limitless) or was written (Omi); `nil` when it carries none.
    public var timestampMillis: UInt64?
    /// `StorageBufferMsg.run`: which boot wrote the page. 0 for an Omi.
    public var boot: UInt64
    public var uptimeMillis: UInt64?
    /// Opus packets in page order, each at its offset from `timestampMillis`.
    public var packets: [(offsetMillis: Int64, data: Data)]
    /// Audio another host encrypted.
    public var encrypted: Bool
    /// How coarse `timestampMillis` is; `nil`: to the millisecond.
    public var clockStepMillis: Int64?
}
