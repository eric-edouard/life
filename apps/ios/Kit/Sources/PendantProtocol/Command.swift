import Foundation

/// `ServerCommandMsg` field numbers. Only the ones marked "sent" are encodable through `PendantCommand`;
/// the destructive ones are listed so nobody re-derives them by accident. They are never sent.
public enum CommandField: Int, Sendable, CaseIterable {
    case setCurrentTime = 6
    /// Destructive: frees every page at or below the index.
    case deleteFlashPage = 7
    case downloadFlashPages = 8
    /// Never sent: wipes flash and bond.
    case factoryReset = 10
    /// Never sent unless the owner explicitly asks to reboot.
    case resetDevice = 11
    case getDeviceInfo = 14
    /// Never sent.
    case unpairBluetooth = 15
    case startRecording = 17
    case stopRecording = 18
    case getDeviceStatus = 21
    /// Never sent: erases flash.
    case clearStorage = 25
    /// UNVERIFIED on hardware.
    case setLEDBrightness = 26
    /// Never sent.
    case shippingMode = 27
    /// Never sent: turns on audio encryption with a key we don't hold.
    case setServerPublicKey = 28
    case requestData = 30
}

/// Where the Pendant sends audio. Recording itself is separate: none of these pause the microphone.
public enum DownloadMode: Equatable, Sendable {
    /// `{batch 0, real-time 0}`: record to flash only. The resting mode between drains.
    case recordOnly
    /// `{1, 0}`: push stored flash pages.
    case download
    /// `{0, 1}`: live stream. UNVERIFIED on our firmware; not used.
    case live

    var flags: (batch: Bool, realTime: Bool) {
        switch self {
        case .recordOnly: (false, false)
        case .download: (true, false)
        case .live: (false, true)
        }
    }
}

/// The commands this app may send. Destructive commands (factory reset, clear storage, unpair, server key)
/// are deliberately not representable.
public enum PendantCommand: Equatable, Sendable {
    case setCurrentTime(unixMillis: UInt64)
    /// `DeleteFlashPage`: destructive, deletes every page at or below the index.
    case acknowledge(throughIndex: UInt64)
    case setDownloadMode(DownloadMode)
    case getDeviceStatus
    /// Identity and flash generation. The reply often lacks the request id (pendant-cli, sdelcore).
    case getDeviceInfo
    case startRecording
    case stopRecording
    /// UNVERIFIED: whether firmware applies it, whether 0 turns the recording LED off, whether it persists.
    case setLEDBrightness(UInt32)

    public var field: CommandField {
        switch self {
        case .setCurrentTime: .setCurrentTime
        case .acknowledge: .deleteFlashPage
        case .setDownloadMode: .downloadFlashPages
        case .getDeviceStatus: .getDeviceStatus
        case .getDeviceInfo: .getDeviceInfo
        case .startRecording: .startRecording
        case .stopRecording: .stopRecording
        case .setLEDBrightness: .setLEDBrightness
        }
    }

    /// Encodes `<command field> <field 30 RequestData{request_id, do_not_ack = 0}>`, Omi's byte order.
    public func serverCommand(requestID: Int64) -> Data {
        var writer = ProtoWriter()
        writer.message(field.rawValue) { body in
            switch self {
            case .setCurrentTime(let millis): body.varint(1, millis)
            case .acknowledge(let index): body.varint(1, index)
            case .setDownloadMode(let mode):
                body.bool(1, mode.flags.batch)
                body.bool(2, mode.flags.realTime)
            case .setLEDBrightness(let level): body.varint(1, UInt64(min(level, 100)))
            case .getDeviceStatus, .getDeviceInfo, .startRecording, .stopRecording: break
            }
        }
        writer.message(CommandField.requestData.rawValue) { request in
            request.varint(1, UInt64(bitPattern: requestID))
            request.bool(2, false)
        }
        return writer.data
    }

    /// Decodes a `ServerCommandMsg`. Used by the simulated Pendant; returns the request id when present.
    public static func decode(_ data: Data) throws(ProtocolError) -> (command: PendantCommand, requestID: Int64?) {
        let message = try ProtoMessage(data)
        let requestID = try message.message(CommandField.requestData.rawValue)?.signed(1)
        for field in message.fields {
            guard let known = CommandField(rawValue: field.number), case .bytes(let raw) = field.value else {
                continue
            }
            let body = try ProtoMessage(raw)
            let command: PendantCommand? =
                switch known {
                case .setCurrentTime: .setCurrentTime(unixMillis: body.varint(1) ?? 0)
                case .deleteFlashPage: .acknowledge(throughIndex: body.varint(1) ?? 0)
                case .downloadFlashPages:
                    switch (body.bool(1) ?? false, body.bool(2) ?? false) {
                    case (true, _): .setDownloadMode(.download)
                    case (false, true): .setDownloadMode(.live)
                    case (false, false): .setDownloadMode(.recordOnly)
                    }
                case .getDeviceStatus: .getDeviceStatus
                case .getDeviceInfo: .getDeviceInfo
                case .startRecording: .startRecording
                case .stopRecording: .stopRecording
                case .setLEDBrightness: .setLEDBrightness(UInt32(clamping: body.varint(1) ?? 0))
                default: nil
                }
            if let command { return (command, requestID) }
        }
        throw .unknownCommand
    }
}

/// Numbers outgoing commands: fragment index starts at 0 and request id at 1, both monotonic per connection.
public struct CommandEncoder: Sendable {
    public private(set) var nextIndex: UInt64 = 0
    public private(set) var nextRequestID: Int64 = 1

    public init() {}

    /// One fragment is always enough: every command we send is under 30 bytes.
    public mutating func encode(_ command: PendantCommand) -> (bytes: Data, requestID: Int64) {
        let requestID = nextRequestID
        let fragment = Fragment(index: nextIndex, payload: command.serverCommand(requestID: requestID))
        nextIndex += 1
        nextRequestID += 1
        return (fragment.encoded, requestID)
    }
}
