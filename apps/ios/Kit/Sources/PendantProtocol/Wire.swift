import Foundation

/// Every way the codec can reject input. Decoding never traps on garbage.
public enum ProtocolError: Error, Equatable, Sendable {
    case truncated
    case varintTooLong
    case invalidFieldNumber
    /// Wire types 3, 4, 6 and 7 (groups and undefined) are rejected; 1 and 5 are skipped safely.
    case unsupportedWireType(UInt8)
    case missingField(String)
    case fragmentCountZero
    case fragmentSequenceOutOfRange(sequence: UInt64, count: UInt64)
    case fragmentCountChanged(index: UInt64)
    case conflictingDuplicateFragment(index: UInt64, sequence: UInt64)
    case messageTooLarge(index: UInt64)
    case unknownCommand
}

/// One protobuf field value, by wire type.
public enum WireValue: Equatable, Sendable {
    case varint(UInt64)
    case fixed64(UInt64)
    case bytes(Data)
    case fixed32(UInt32)
}

/// A decoded protobuf message: its fields in wire order. Scalar getters follow protobuf's "last one wins"
/// and ignore a field that arrives with an unexpected wire type, so schema conflicts never crash.
public struct ProtoMessage: Sendable {
    public let fields: [(number: Int, value: WireValue)]

    public init(_ data: Data) throws(ProtocolError) {
        let bytes = [UInt8](data)
        var position = 0
        var fields: [(number: Int, value: WireValue)] = []
        while position < bytes.count {
            let key = try Self.varint(bytes, &position)
            guard key >> 3 > 0, key >> 3 <= 536_870_911 else { throw .invalidFieldNumber }
            let number = Int(key >> 3)
            switch UInt8(key & 7) {
            case 0:
                fields.append((number, .varint(try Self.varint(bytes, &position))))
            case 1:
                fields.append((number, .fixed64(try Self.littleEndian(bytes, &position, width: 8))))
            case 2:
                let length = try Self.varint(bytes, &position)
                guard length <= UInt64(bytes.count - position) else { throw .truncated }
                let end = position + Int(length)
                fields.append((number, .bytes(Data(bytes[position..<end]))))
                position = end
            case 5:
                fields.append((number, .fixed32(UInt32(try Self.littleEndian(bytes, &position, width: 4)))))
            case let wireType:
                throw .unsupportedWireType(wireType)
            }
        }
        self.fields = fields
    }

    public func varint(_ number: Int) -> UInt64? {
        for field in fields.reversed() where field.number == number {
            if case .varint(let value) = field.value { return value }
        }
        return nil
    }

    public func bool(_ number: Int) -> Bool? { varint(number).map { $0 != 0 } }

    /// proto3 `int32`/`int64`: negative values arrive as 10-byte varints.
    public func signed(_ number: Int) -> Int64? { varint(number).map { Int64(bitPattern: $0) } }

    public func bytes(_ number: Int) -> Data? { allBytes(number).last }

    public func allBytes(_ number: Int) -> [Data] {
        fields.compactMap { field in
            guard field.number == number, case .bytes(let data) = field.value else { return nil }
            return data
        }
    }

    public func message(_ number: Int) throws(ProtocolError) -> ProtoMessage? {
        guard let data = bytes(number) else { return nil }
        return try ProtoMessage(data)
    }

    public func has(_ number: Int) -> Bool { fields.contains { $0.number == number } }

    private static func varint(_ bytes: [UInt8], _ position: inout Int) throws(ProtocolError) -> UInt64 {
        var result: UInt64 = 0
        for shift in stride(from: UInt64(0), to: 70, by: 7) {
            guard position < bytes.count else { throw .truncated }
            let byte = bytes[position]
            position += 1
            // The tenth byte may only carry the top bit of a 64-bit value.
            if shift == 63, byte > 1 { throw .varintTooLong }
            result |= UInt64(byte & 0x7f) << shift
            if byte & 0x80 == 0 { return result }
        }
        throw .varintTooLong
    }

    private static func littleEndian(_ bytes: [UInt8], _ position: inout Int, width: Int) throws(ProtocolError)
        -> UInt64
    {
        guard bytes.count - position >= width else { throw .truncated }
        var value: UInt64 = 0
        for offset in 0..<width { value |= UInt64(bytes[position + offset]) << (8 * UInt64(offset)) }
        position += width
        return value
    }
}

/// Minimal protobuf writer. Writes zero values explicitly, like Omi, which the Pendant accepts.
public struct ProtoWriter: Sendable {
    public private(set) var data = Data()

    public init() {}

    public mutating func varint(_ number: Int, _ value: UInt64) {
        Self.append(UInt64(number) << 3, to: &data)
        Self.append(value, to: &data)
    }

    public mutating func bool(_ number: Int, _ value: Bool) { varint(number, value ? 1 : 0) }

    public mutating func bytes(_ number: Int, _ value: Data) {
        Self.append(UInt64(number) << 3 | 2, to: &data)
        Self.append(UInt64(value.count), to: &data)
        data.append(value)
    }

    public mutating func message(_ number: Int, _ build: (inout ProtoWriter) -> Void) {
        var inner = ProtoWriter()
        build(&inner)
        bytes(number, inner.data)
    }

    private static func append(_ value: UInt64, to data: inout Data) {
        var value = value
        while value >= 0x80 {
            data.append(UInt8(value & 0x7f) | 0x80)
            value >>= 7
        }
        data.append(UInt8(value))
    }
}
