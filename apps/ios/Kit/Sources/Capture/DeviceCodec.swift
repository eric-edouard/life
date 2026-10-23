import Foundation
import PendantProtocol

/// One pendant family's wire format on one connection: the drain's commands become writes, notifications become the
/// drain's messages. So one `DrainCoordinator` drains both: the Limitless Pendant speaks protobuf fragments, an Omi
/// its ring commands (`docs/research/omi.md`).
protocol DeviceCodec: Sendable {
    /// The writes for `command` and the request id its reply will carry; `nil` when the device has no such command.
    mutating func encode(_ command: PendantCommand) -> (writes: [(WriteTarget, Data)], requestID: Int64)?
    /// The messages one notification completes; none while a message is still partial. Throws on a malformed one.
    mutating func decode(_ notification: Data) throws -> [PendantMessage]
}

extension DeviceKind {
    func makeCodec() -> any DeviceCodec {
        switch self {
        case .limitless: LimitlessCodec()
        case .omi: OmiCodec()
        }
    }

    /// The Limitless Pendant records while a phone holds its link and pushes pages as they seal. An Omi drops its audio
    /// while a phone is connected without streaming it live (firmware 3.0.21, `transport.c` `pusher`), so the phone
    /// lets go once a drain settles and connects again for the next one.
    var holdsLink: Bool { self == .limitless }

    /// A Limitless page carries the Pendant's uptime, so a clock set anchors the pages after it (`ClockModel`). An Omi
    /// record carries a UTC second only: a set anchors nothing, so it isn't recorded.
    var anchorsClock: Bool { self == .limitless }

    /// An Omi on released firmware has freed what it sent: when a record clashes at a re-used ring number (a cleared
    /// ring), the drain may carry on into a new flash life instead of dropping its queue and reading again, if its
    /// firmware frees on delivery (`DrainCoordinator.carriesDrainIntoNewLife`). The Limitless Pendant keeps every page
    /// until ACKed, so it starts over.
    var carriesDrainIntoNewLife: Bool { self == .omi }

    /// An Omi's ring restarts its numbers at 0 when cleared and never lowers them otherwise, so a write number at or
    /// below what the phone holds is a new ring. The Limitless Pendant's newest page is the one being written, so the
    /// same test could misfire; it relies on a clash instead.
    var restartsNumbersWhenCleared: Bool { self == .omi }
}

struct LimitlessCodec: DeviceCodec {
    private var encoder = CommandEncoder()
    private var reassembler = Reassembler()

    mutating func encode(_ command: PendantCommand) -> (writes: [(WriteTarget, Data)], requestID: Int64)? {
        let (bytes, requestID) = encoder.encode(command)
        return ([(.control, bytes)], requestID)
    }

    mutating func decode(_ notification: Data) throws -> [PendantMessage] {
        guard let payload = try reassembler.accept(Fragment(decoding: notification)) else { return [] }
        return [try PendantMessage(decoding: payload)]
    }
}

/// The Omi's ring as the drain's vocabulary: INFO answers both the identity and the status query, READ is download
/// mode, ADVANCE is the ACK, and each record rebuilt from the data notifications is a page at its ring number.
struct OmiCodec: DeviceCodec {
    private var nextRequestID: Int64 = 1
    /// The newest INFO request not answered yet. The firmware answers requests that come close together once, so an
    /// INFO answers the newest; an older one times out.
    private var asked: (requestID: Int64, identity: Bool)?
    private var ring: OmiRingInfo?
    private var records = OmiRecordStream()

    mutating func encode(_ command: PendantCommand) -> (writes: [(WriteTarget, Data)], requestID: Int64)? {
        let requestID = nextRequestID
        let write: (WriteTarget, Data)
        switch command {
        case .setCurrentTime(let millis): write = (.clock, OmiCommand.clock(unixMillis: millis))
        case .getDeviceInfo, .getDeviceStatus:
            asked = (requestID, command == .getDeviceInfo)
            write = (.control, OmiCommand.info.bytes)
        // From the ring's oldest record, by the last INFO: the drain asked for it just before.
        case .setDownloadMode(.download): write = (.control, OmiCommand.read(from: ring?.read ?? 0).bytes)
        case .setDownloadMode: write = (.control, OmiCommand.stop.bytes)
        case .acknowledge(let index): write = (.control, OmiCommand.advance(to: index + 1).bytes)
        case .startRecording, .stopRecording, .setLEDBrightness: return nil
        }
        nextRequestID += 1
        return ([write], requestID)
    }

    mutating func decode(_ notification: Data) throws -> [PendantMessage] {
        switch try OmiNotification(decoding: notification) {
        case .info(let info):
            ring = info
            let ask = asked
            asked = nil
            let response = ask.map { CommandResponse(requestID: $0.requestID) }
            // 3.0.21 says nothing stable about which ring this is: the current flash life stands, and the drain
            // starts a new one when the numbers don't match what the phone holds.
            if ask?.identity == true { return [PendantMessage(response: response, content: .deviceInfo(DeviceInfo()))] }
            let storage = StorageState(
                oldestPage: info.read, newestPage: Int64(info.write) - 1, session: 0,
                freePages: UInt64(info.capacity) - min(info.write - info.read, UInt64(info.capacity)),
                totalPages: UInt64(info.capacity))
            return [PendantMessage(response: response, content: .deviceStatus(DeviceStatus(storage: storage)))]
        case .readBegin(let start, _):
            records.begin(at: start)
            return []
        case .data(let bytes):
            return records.append(bytes).map {
                PendantMessage(content: .storageBuffer(StorageBuffer(index: $0.seq, raw: $0.record)))
            }
        // A read ends at the ring's write number, which the drain already knows; an ADVANCE that fails frees nothing.
        case .ack, .done: return []
        }
    }
}
