import Foundation

/// Stable identity of a conversation: the instant it started when it was first seen. The server keeps the same rule
/// (its ids are `ConversationID.serverID`), so an id is the same on both.
public struct ConversationID: Hashable, Sendable, Codable {
    public var anchor: CaptureInstant

    public init(anchor: CaptureInstant) {
        self.anchor = anchor
    }
}

extension ConversationID {
    /// The server's id: the anchor's milliseconds in the last 48 bits, version and variant 8. Stable.
    public var serverID: UUID {
        let millis = UInt64(bitPattern: anchor.millis) & 0xFFFF_FFFF_FFFF
        let bytes = (0..<6).map { UInt8(truncatingIfNeeded: millis >> (8 * (5 - $0))) }
        return UUID(
            uuid: (0, 0, 0, 0, 0, 0, 0x80, 0, 0x80, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]))
    }

    /// The conversation a `serverID` names; `nil` for a UUID made otherwise.
    public init?(serverID: UUID) {
        let u = serverID.uuid
        guard [u.0, u.1, u.2, u.3, u.4, u.5, u.6, u.7, u.8, u.9] == [0, 0, 0, 0, 0, 0, 0x80, 0, 0x80, 0] else {
            return nil
        }
        let millis = [u.10, u.11, u.12, u.13, u.14, u.15].reduce(Int64(0)) { $0 << 8 | Int64($1) }
        self.init(anchor: CaptureInstant(millis: millis))
    }
}
