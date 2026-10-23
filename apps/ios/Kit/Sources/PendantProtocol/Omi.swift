import Foundation

/// The Omi pendant's offline ring (firmware 3.0.20 and later, BasedHardware/omi `storage.c`, `ring_protocol.dart`).
/// See `docs/research/omi.md`. Codec only: no I/O.
public enum OmiGATT {
    /// Advertised: how a scan finds an Omi. Its live audio is never subscribed to: while subscribed the Omi streams
    /// instead of writing its ring.
    public static let audioService = "19B10000-E8F2-537E-4F6C-D104768A1214"
    public static let storageService = "30295780-4301-EABD-2904-2849ADFEAE43"
    /// Ring commands are written here, and every ring notification (ACK, INFO, DATA, DONE, READ_BEGIN) comes on it.
    public static let storageControl = "30295781-4301-EABD-2904-2849ADFEAE43"
    public static let timeService = "19B10030-E8F2-537E-4F6C-D104768A1214"
    /// Write epoch seconds, a little-endian UInt32. The ring writes nothing until the clock is set.
    public static let timeWrite = "19B10031-E8F2-537E-4F6C-D104768A1214"
    public static let deviceInfoService = "180A"
    public static let firmwareRevision = "2A26"
}

/// Ring commands, written with response to `OmiGATT.storageControl`. CLEAR (0x13) is deliberately not representable.
public enum OmiCommand: Equatable, Sendable {
    case info
    /// Streams every record from `seq` to the write number.
    case read(from: UInt64)
    /// Frees every record below `seq`. Destructive.
    case advance(to: UInt64)
    case stop

    public var bytes: Data {
        switch self {
        case .info: Data([0x10])
        case .read(let seq): Data([0x11]) + Self.bigEndian(seq)
        case .advance(let seq): Data([0x12]) + Self.bigEndian(seq)
        case .stop: Data([0x03])
        }
    }

    /// The clock write: epoch seconds, little-endian, to `OmiGATT.timeWrite`.
    public static func clock(unixMillis: UInt64) -> Data {
        withUnsafeBytes(of: UInt32(clamping: unixMillis / 1000).littleEndian) { Data($0) }
    }

    /// Decodes a written command. Used by the simulated Omi.
    public init(decoding data: Data) throws(ProtocolError) {
        let bytes = [UInt8](data)
        switch (bytes.first, bytes.count) {
        case (0x10, 1): self = .info
        case (0x11, 9), (0x11, 13): self = .read(from: Self.uint64(bytes, at: 1))
        case (0x12, 9): self = .advance(to: Self.uint64(bytes, at: 1))
        case (0x03, 1): self = .stop
        default: throw .unknownCommand
        }
    }

    static func bigEndian(_ value: UInt64) -> Data { withUnsafeBytes(of: value.bigEndian) { Data($0) } }

    static func uint64(_ bytes: [UInt8], at offset: Int) -> UInt64 {
        bytes[offset..<offset + 8].reduce(0) { $0 << 8 | UInt64($1) }
    }
}

/// The ring's numbers: records `read..<write` are held, the oldest first.
public struct OmiRingInfo: Equatable, Sendable {
    public var read: UInt64
    public var write: UInt64
    public var capacity: UInt32
    /// Records the ring overwrote when full, since it was last cleared.
    public var dropped: UInt64

    public init(read: UInt64, write: UInt64, capacity: UInt32, dropped: UInt64 = 0) {
        self.read = read
        self.write = write
        self.capacity = capacity
        self.dropped = dropped
    }
}

/// One notification on `OmiGATT.storageControl`: an opcode byte, then its payload, numbers big-endian.
public enum OmiNotification: Equatable, Sendable {
    case ack(status: UInt8)
    case info(OmiRingInfo)
    /// Record bytes, not aligned to records.
    case data(Data)
    case done(status: UInt8, next: UInt64)
    /// A read begins at `start`: the next data byte is that record's first.
    case readBegin(start: UInt64, count: UInt32)

    public init(decoding data: Data) throws(ProtocolError) {
        let bytes = [UInt8](data)
        switch (bytes.first ?? 0, bytes.count) {
        case (0x01, 2...): self = .ack(status: bytes[1])
        case (0x02, 31...):
            self = .info(
                OmiRingInfo(
                    read: OmiCommand.uint64(bytes, at: 1), write: OmiCommand.uint64(bytes, at: 9),
                    capacity: bytes[17..<21].reduce(0) { $0 << 8 | UInt32($1) },
                    dropped: OmiCommand.uint64(bytes, at: 21)))
        case (0x03, _): self = .data(Data(bytes.dropFirst()))
        case (0x04, 10...): self = .done(status: bytes[1], next: OmiCommand.uint64(bytes, at: 2))
        case (0x05, 13...):
            self = .readBegin(
                start: OmiCommand.uint64(bytes, at: 1), count: bytes[9..<13].reduce(0) { $0 << 8 | UInt32($1) })
        case (0...0x05, _): throw .truncated
        default: throw .unknownCommand
        }
    }

    public var encoded: Data {
        switch self {
        case .ack(let status): Data([0x01, status])
        case .info(let info):
            Data([0x02]) + OmiCommand.bigEndian(info.read) + OmiCommand.bigEndian(info.write)
                + withUnsafeBytes(of: info.capacity.bigEndian) { Data($0) } + OmiCommand.bigEndian(info.dropped)
                + withUnsafeBytes(of: UInt16(OmiRecord.size).bigEndian) { Data($0) }
        case .data(let bytes): Data([0x03]) + bytes
        case .done(let status, let next): Data([0x04, status]) + OmiCommand.bigEndian(next)
        case .readBegin(let start, let count):
            Data([0x05]) + OmiCommand.bigEndian(start) + withUnsafeBytes(of: count.bigEndian) { Data($0) }
        }
    }
}

/// One ring record: a 4-byte big-endian UTC second, then 440 bytes of Opus frames packed as `[length][frame]…`.
/// The stamp is when the firmware wrote the record, after its frames: about 100 ms of audio at 32 kbps.
public struct OmiRecord: Equatable, Sendable {
    public static let size = 444
    static let payloadSize = 440
    /// Bit 31 marks seconds since boot, not UTC (draft custody firmware, with the clock unset).
    static let uptimeFlag: UInt32 = 0x8000_0000

    /// Epoch seconds; `nil` when the record carries uptime, not UTC.
    public var timestampSeconds: UInt32?
    /// 20 ms Opus frames, in order.
    public var frames: [Data]

    public init(decoding data: Data) throws(ProtocolError) {
        guard data.count == Self.size else { throw .truncated }
        let bytes = [UInt8](data)
        let stamp = bytes[0..<4].reduce(0) { $0 << 8 | UInt32($1) }
        timestampSeconds = stamp & Self.uptimeFlag == 0 ? stamp : nil
        // A zero byte is padding. The firmware may end a record with a length whose frame went to the next record;
        // whatever follows it is stale (`ring_protocol.dart` `parseAudioPayload`).
        var frames: [Data] = []
        var offset = 4
        while offset < bytes.count - 1 {
            let length = Int(bytes[offset])
            if length == 0 {
                offset += 1
                continue
            }
            guard offset + 1 + length < bytes.count else { break }
            frames.append(Data(bytes[offset + 1...offset + length]))
            offset += length + 1
        }
        self.frames = frames
    }

    /// Packs `frames` the firmware's way. Used by the simulated Omi; frames that don't fit are dropped.
    public static func encode(timestampSeconds: UInt32, frames: [Data]) -> Data {
        var payload = Data()
        for frame in frames where frame.count <= 255 && payload.count + frame.count + 1 < payloadSize {
            payload.append(UInt8(frame.count))
            payload.append(frame)
        }
        payload.append(Data(count: payloadSize - payload.count))
        return withUnsafeBytes(of: timestampSeconds.bigEndian) { Data($0) } + payload
    }
}

/// Rebuilds whole records from data notifications that split them anywhere. One per read: `begin` at its start.
public struct OmiRecordStream: Sendable {
    private var buffer = Data()
    /// The ring number of the record the buffer starts with; `nil` before a read began.
    private var next: UInt64?

    public init() {}

    public mutating func begin(at start: UInt64) {
        buffer = Data()
        next = start
    }

    /// The records `bytes` completes, each with its ring number. Bytes before a read began are dropped.
    public mutating func append(_ bytes: Data) -> [(seq: UInt64, record: Data)] {
        guard var seq = next else { return [] }
        buffer.append(bytes)
        var records: [(seq: UInt64, record: Data)] = []
        while buffer.count >= OmiRecord.size {
            records.append((seq, Data(buffer.prefix(OmiRecord.size))))
            buffer = Data(buffer.dropFirst(OmiRecord.size))
            seq += 1
        }
        next = seq
        return records
    }
}

/// What the Omi's firmware does with a record the phone received, by its version (Device Information, 0x2A26).
public enum OmiFirmware {
    /// The first release where only the app's ADVANCE frees ring records ("ring custody", BasedHardware/omi#20450,
    /// still an open draft on 22 Oct 2026; the latest release, 3.0.21, frees on delivery). `nil` until it ships: then
    /// set it, and the in-app warning asks the user to update. Whoever works on the Omi checks the release notes first
    /// (`docs/research/omi.md`).
    public static let custodyFixedIn: [Int]? = nil

    /// Whether `revision` frees a record as soon as Bluetooth delivers it, before the phone has stored it. An unknown
    /// revision is assumed to.
    public static func freesOnDelivery(_ revision: String?, fixedIn: [Int]? = custodyFixedIn) -> Bool {
        guard let fixed = fixedIn, let version = revision.flatMap(version) else { return true }
        // 3.1 is 3.1.0: both padded to one length before comparing.
        let length = max(version.count, fixed.count)
        func padded(_ parts: [Int]) -> [Int] { parts + Array(repeating: 0, count: length - parts.count) }
        return padded(version).lexicographicallyPrecedes(padded(fixed))
    }

    /// "3.0.21", "v3.0.21" or "3.0.21-beta" as [3, 0, 21].
    static func version(_ revision: String) -> [Int]? {
        let parts = revision.drop { !$0.isNumber }.prefix { $0.isNumber || $0 == "." }.split(separator: ".")
        let numbers = parts.compactMap { Int($0) }
        return numbers.isEmpty || numbers.count != parts.count ? nil : numbers
    }
}
