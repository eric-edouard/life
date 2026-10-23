import Foundation
import Testing

@testable import PendantProtocol

// Byte layouts from BasedHardware/omi `storage.c` and `ring_protocol.dart` (firmware 3.0.21).

@Suite struct Omi {
    /// The ring's bytes both phones read alike (`fixtures/wire/omi-ring.json`, shared with the Android app).
    @Test func commandsAndNotificationsMatchTheSharedFixture() throws {
        struct Wire: Decodable {
            struct Entry: Decodable {
                let name: String
                let hex: String
                var seq: UInt64?, unixMillis: UInt64?, status: UInt8?, read: UInt64?, write: UInt64?
                var capacity: UInt32?, dropped: UInt64?, bytes: String?, next: UInt64?, start: UInt64?
                var count: UInt32?, error: String?
            }
            let commands: [Entry]
            let notifications: [Entry]
        }
        let wire = try JSONDecoder().decode(Wire.self, from: Data(contentsOf: Self.fixture))
        for c in wire.commands {
            let expected = Data(hex: c.hex)
            if c.name == "clock" {
                #expect(OmiCommand.clock(unixMillis: try #require(c.unixMillis)) == expected)
                continue
            }
            let command: OmiCommand =
                switch c.name {
                case "info": .info
                case "read": .read(from: try #require(c.seq))
                case "advance": .advance(to: try #require(c.seq))
                default: throw ProtocolError.unknownCommand
                }
            #expect(command.bytes == expected, "\(c.name)")
            #expect(try OmiCommand(decoding: expected) == command, "\(c.name)")
        }
        for n in wire.notifications {
            let bytes = Data(hex: n.hex)
            switch n.error {
            case "truncated": #expect(throws: ProtocolError.truncated) { try OmiNotification(decoding: bytes) }
            case "unknown": #expect(throws: ProtocolError.unknownCommand) { try OmiNotification(decoding: bytes) }
            default:
                let expected: OmiNotification =
                    switch n.name {
                    case "ack": .ack(status: try #require(n.status))
                    case "info":
                        .info(
                            OmiRingInfo(
                                read: try #require(n.read), write: try #require(n.write),
                                capacity: try #require(n.capacity), dropped: try #require(n.dropped)))
                    case "data": .data(Data(hex: try #require(n.bytes)))
                    case "done": .done(status: try #require(n.status), next: try #require(n.next))
                    case "readBegin": .readBegin(start: try #require(n.start), count: try #require(n.count))
                    default: throw ProtocolError.unknownCommand
                    }
                #expect(try OmiNotification(decoding: bytes) == expected, "\(n.name)")
                #expect(expected.encoded == bytes, "\(n.name)")
            }
        }
    }

    /// What only the iPhone's simulated Omi needs: STOP, and CLEAR refused.
    @Test func stopRoundTripsAndClearIsRefused() throws {
        #expect(OmiCommand.stop.bytes == Data([0x03]))
        #expect(try OmiCommand(decoding: Data([0x03])) == .stop)
        #expect(throws: ProtocolError.unknownCommand) { try OmiCommand(decoding: Data([0x13])) }
    }

    static let fixture = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "fixtures/wire/omi-ring.json")

    @Test func recordsUnpackTheirFrames() throws {
        let frames = [Data(repeating: 0xB8, count: 80), Data(repeating: 0x5A, count: 79)]
        let record = try OmiRecord(decoding: OmiRecord.encode(timestampSeconds: 1_700_000_123, frames: frames))
        #expect(record.timestampSeconds == 1_700_000_123)
        #expect(record.frames == frames)
    }

    @Test func aLengthWithoutItsFrameEndsTheRecord() throws {
        // The firmware's overflow: a length byte at the end, its frame in the next record, stale bytes after it.
        let frame = Data(repeating: 1, count: 200)
        var bytes = [UInt8](OmiRecord.encode(timestampSeconds: 1_700_000_000, frames: [frame, frame]))
        bytes[4 + 402] = 60
        bytes[4 + 403] = 0xEE
        let record = try OmiRecord(decoding: Data(bytes))
        #expect(record.frames == [frame, frame])
    }

    @Test func aFrameEndingOnTheLastByteIsTheFirmwaresStaleOverflow() throws {
        // `write_to_storage` (transport.c) never ends a frame on the record's last byte: a frame that fits exactly
        // ends one byte before it, and one that would reach it goes to the next record, its length left here over
        // stale bytes. So the longest real frame ends on byte 442, and a length reaching byte 443 is the overflow.
        let first = Data(repeating: 1, count: 200)
        let last = Data(repeating: 2, count: 237)
        let fits = try OmiRecord(decoding: OmiRecord.encode(timestampSeconds: 1_700_000_000, frames: [first, last]))
        #expect(fits.frames == [first, last], "the second frame ends on byte 442")
        var bytes = [UInt8](OmiRecord.encode(timestampSeconds: 1_700_000_000, frames: [first]))
        bytes[4 + 201] = 238
        let overflow = try OmiRecord(decoding: Data(bytes))
        #expect(overflow.frames == [first], "a length reaching byte 443 is the overflow's, over stale bytes")
    }

    @Test func anUptimeStampHasNoTime() throws {
        let record = try OmiRecord(decoding: OmiRecord.encode(timestampSeconds: 0x8000_0010, frames: []))
        #expect(record.timestampSeconds == nil)
        #expect(throws: ProtocolError.truncated) { try OmiRecord(decoding: Data(count: 443)) }
    }

    @Test func recordsAreRebuiltFromAnySplit() {
        let records = (0..<3).map {
            OmiRecord.encode(
                timestampSeconds: 1_700_000_000 + UInt32($0), frames: [Data(repeating: UInt8($0), count: 9)])
        }
        let stream = records.reduce(Data(), +)
        var rebuilt = OmiRecordStream()
        #expect(rebuilt.append(stream.prefix(10)).isEmpty, "bytes before a read began are dropped")
        rebuilt.begin(at: 50)
        var out: [(seq: UInt64, record: Data)] = []
        for start in stride(from: 0, to: stream.count, by: 177) {
            out += rebuilt.append(Data(stream[start..<min(start + 177, stream.count)]))
        }
        #expect(out.map(\.seq) == [50, 51, 52])
        #expect(out.map(\.record) == records)
    }

    @Test func firmwareFreesOnDeliveryUntilTheFixShips() {
        #expect(OmiFirmware.freesOnDelivery("3.0.21"))
        #expect(OmiFirmware.freesOnDelivery(nil))
        #expect(OmiFirmware.version("v3.0.21-beta") == [3, 0, 21])
        #expect(OmiFirmware.version("Unknown") == nil)
        #expect(!OmiFirmware.freesOnDelivery("3.1", fixedIn: [3, 1, 0]), "3.1 is 3.1.0")
        #expect(!OmiFirmware.freesOnDelivery("3.0.22", fixedIn: [3, 0, 22]))
        #expect(OmiFirmware.freesOnDelivery("3.0.21.9", fixedIn: [3, 0, 22]))
    }

    @Test func aSourceIdNamesItsKind() {
        #expect(DeviceKind(deviceID: DeviceKind.omi.deviceID) == .omi)
        #expect(DeviceKind(deviceID: "limitless-pendant") == .limitless)
    }
}
