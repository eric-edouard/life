import Foundation

/// One BLE fragment envelope. Every GATT write and every notification is exactly one of these.
///
/// `BLEMessageFromNativeToPendant` / `BLEMessageFromPendantToNative`: index = 1, seq = 2, count = 3, payload = 4.
public struct Fragment: Equatable, Sendable {
    public var index: UInt64
    public var sequence: UInt64
    public var count: UInt64
    public var payload: Data

    public init(index: UInt64, sequence: UInt64 = 0, count: UInt64 = 1, payload: Data) {
        self.index = index
        self.sequence = sequence
        self.count = count
        self.payload = payload
    }

    /// proto3 may omit `index = 0` and `seq = 0`; they read as 0. A missing or zero count is malformed.
    public init(decoding data: Data) throws(ProtocolError) {
        let message = try ProtoMessage(data)
        guard let count = message.varint(3), count > 0 else { throw .fragmentCountZero }
        let sequence = message.varint(2) ?? 0
        guard sequence < count else { throw .fragmentSequenceOutOfRange(sequence: sequence, count: count) }
        self.init(index: message.varint(1) ?? 0, sequence: sequence, count: count, payload: message.bytes(4) ?? Data())
    }

    public var encoded: Data {
        var writer = ProtoWriter()
        writer.varint(1, index)
        writer.varint(2, sequence)
        writer.varint(3, count)
        writer.bytes(4, payload)
        return writer.data
    }

    /// Splits a message so each encoded fragment fits `maxFragmentSize` bytes. Send them in order: the Pendant
    /// decodes when it sees `seq + 1 == count`.
    public static func split(_ payload: Data, index: UInt64, maxFragmentSize: Int) -> [Fragment] {
        // Worst-case envelope overhead: three 10-byte varint fields plus tags, and the payload tag and length.
        let chunk = max(1, maxFragmentSize - 40)
        let pieces = stride(from: 0, to: max(payload.count, 1), by: chunk).map { start in
            Data(payload.dropFirst(start).prefix(chunk))
        }
        return pieces.enumerated().map { offset, piece in
            Fragment(index: index, sequence: UInt64(offset), count: UInt64(pieces.count), payload: piece)
        }
    }
}

/// Reassembles fragments into messages, keyed by message index, in sequence order whatever the arrival order.
/// Bounded: at most `maxOpenMessages` partials (oldest evicted) and `maxMessageBytes` per message.
/// Create a fresh one per connection and per mode switch.
public struct Reassembler: Sendable {
    private struct Partial {
        var count: UInt64
        var parts: [UInt64: Data] = [:]
        var bytes = 0
    }

    public let maxOpenMessages: Int
    public let maxMessageBytes: Int
    private var partials: [UInt64: Partial] = [:]
    private var openOrder: [UInt64] = []

    public init(maxOpenMessages: Int = 8, maxMessageBytes: Int = 64 * 1024) {
        self.maxOpenMessages = maxOpenMessages
        self.maxMessageBytes = maxMessageBytes
    }

    public var openMessageCount: Int { partials.count }

    /// Returns the complete inner payload once the last missing fragment arrives, else `nil`.
    public mutating func accept(_ fragment: Fragment) throws(ProtocolError) -> Data? {
        let index = fragment.index
        if fragment.count == 1 {
            drop(index)
            return fragment.payload
        }
        var partial = partials[index] ?? Partial(count: fragment.count)
        guard partial.count == fragment.count else {
            drop(index)
            throw .fragmentCountChanged(index: index)
        }
        if let existing = partial.parts[fragment.sequence] {
            guard existing == fragment.payload else {
                drop(index)
                throw .conflictingDuplicateFragment(index: index, sequence: fragment.sequence)
            }
            return nil
        }
        partial.parts[fragment.sequence] = fragment.payload
        partial.bytes += fragment.payload.count
        guard partial.bytes <= maxMessageBytes else {
            drop(index)
            throw .messageTooLarge(index: index)
        }
        if UInt64(partial.parts.count) == partial.count {
            drop(index)
            return partial.parts.sorted { $0.key < $1.key }.reduce(into: Data()) { $0.append($1.value) }
        }
        if partials[index] == nil {
            openOrder.append(index)
            if openOrder.count > maxOpenMessages { drop(openOrder[0]) }
        }
        partials[index] = partial
        return nil
    }

    private mutating func drop(_ index: UInt64) {
        partials[index] = nil
        openOrder.removeAll { $0 == index }
    }
}
