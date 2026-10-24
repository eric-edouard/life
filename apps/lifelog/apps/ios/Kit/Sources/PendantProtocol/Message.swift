import Foundation

/// A reassembled `PendantAllMsg`: optional `ResponseData` plus one content field.
public struct PendantMessage: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case storageBuffer(StorageBuffer)
        case deviceStatus(DeviceStatus)
        case battery(BatteryStatus)
        case button(ButtonStatus)
        case setCurrentTimeResponse
        case deviceInfo(DeviceInfo)
        /// Any other content field (real-time audio, ingest auth, …): ignored.
        case other
    }

    public var response: CommandResponse?
    public var content: Content

    public init(response: CommandResponse? = nil, content: Content) {
        self.response = response
        self.content = content
    }

    public init(decoding payload: Data) throws(ProtocolError) {
        let message = try ProtoMessage(payload)
        response = try message.message(6).map(CommandResponse.init)
        if let raw = message.bytes(2) {
            content = .storageBuffer(try StorageBuffer(decoding: raw))
        } else if let status = try message.message(5) {
            content = .deviceStatus(try DeviceStatus(status))
        } else if let battery = try message.message(7) {
            content = .battery(BatteryStatus(battery))
        } else if let button = try message.message(8) {
            content = .button(ButtonStatus(button))
        } else if message.bytes(3) != nil {
            content = .setCurrentTimeResponse
        } else if let info = try message.message(1) {
            content = .deviceInfo(DeviceInfo(info))
        } else {
            content = .other
        }
    }
}

/// `ResponseData { int64 request_id = 1; ServerCommandRequestError error = 2; }` (pendant-cli schema).
public struct CommandResponse: Equatable, Sendable {
    public enum Failure: Equatable, Sendable {
        /// Category 1, `FAILED_TO_EXECUTE`.
        case failedToExecute(message: String)
        case otherCategory(UInt64, message: String)
        /// Field 2 arrived as a varint: sdelcore's schema says `bool success`. Conflicting sources; kept raw.
        case unrecognized(UInt64)
    }

    public var requestID: Int64?
    public var failure: Failure?

    public init(requestID: Int64?, failure: Failure? = nil) {
        self.requestID = requestID
        self.failure = failure
    }

    init(_ message: ProtoMessage) throws(ProtocolError) {
        requestID = message.signed(1)
        if let error = try message.message(2) {
            let text = error.bytes(2).map { String(decoding: $0, as: UTF8.self) } ?? ""
            switch error.varint(1) ?? 0 {
            case 0: failure = nil
            case 1: failure = .failedToExecute(message: text)
            case let category: failure = .otherCategory(category, message: text)
            }
        } else {
            failure = message.varint(2).map(Failure.unrecognized)
        }
    }
}

/// `StorageBufferMsg`: one flash page envelope. `raw` is exactly what the source store persists.
public struct StorageBuffer: Equatable, Sendable {
    /// Storage session. On the owner's Pendant it changes every time recording starts or stops, often every few
    /// seconds: metadata, never a conversation boundary.
    public var session: Int64
    /// Counts Pendant boots: it rose by one when the owner's unit rebooted (and `boot_uptime_ms` restarted).
    public var run: UInt64
    public var index: UInt64
    /// pendant-cli calls it `page_seq_uptime_ms`. On the owner's Pendant it equals the flash page index.
    public var sequence: UInt64
    /// Sources conflict on the enum; never classify by it.
    public var ingestType: UInt64
    public var flashPage: Data?
    public var error: FlashPageError?
    public var raw: Data

    public init(decoding raw: Data) throws(ProtocolError) {
        let message = try ProtoMessage(raw)
        session = message.signed(2) ?? 0
        run = message.varint(3) ?? 0
        index = message.varint(5) ?? 0
        sequence = message.varint(4) ?? 0
        ingestType = message.varint(1) ?? 0
        flashPage = message.bytes(6)
        error = message.varint(7).flatMap(FlashPageError.init(rawValue:))
        self.raw = raw
    }

    /// A page that isn't a `StorageBufferMsg`: an Omi ring record, at its ring number.
    public init(index: UInt64, raw: Data) {
        (session, run, self.index, sequence, ingestType, flashPage, error) = (0, 0, index, index, 0, nil, nil)
        self.raw = raw
    }
}

/// `StorageBufferMsg.flash_page_error` (field 7). Any non-zero value means the page has no usable bytes.
///
/// The value mapping is UNVERIFIED and the sources conflict: sdelcore says 1 = READ_FAILED, 2 = CORRUPT;
/// pendant-cli says 1 = CRC, 2 = IO (roughly the reverse). We follow sdelcore's names and keep the raw value.
public enum FlashPageError: Equatable, Sendable {
    case readFailed
    case corrupt
    case unknown(UInt64)

    init?(rawValue: UInt64) {
        switch rawValue {
        case 0: return nil
        case 1: self = .readFailed
        case 2: self = .corrupt
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: UInt64 {
        switch self {
        case .readFailed: 1
        case .corrupt: 2
        case .unknown(let value): value
        }
    }
}

/// `FlashPage`: the decoded content of a page. Decoding is derived work; the raw envelope is what's kept.
public struct FlashPage: Equatable, Sendable {
    /// Pendant RTC when the page was opened (verified: chunk offsets count up from it), Unix epoch ms, kept raw.
    /// Values at or below 2020-01-01 are not trustworthy: right after a boot the RTC is unset and equals uptime.
    public var timestampMillis: UInt64?
    public var bootUptimeMillis: UInt64?
    public var chunks: [Chunk]

    public static let earliestPlausibleMillis: UInt64 = 1_577_836_800_000

    public init(decoding data: Data) throws(ProtocolError) {
        let message = try ProtoMessage(data)
        timestampMillis = message.varint(1)
        bootUptimeMillis = message.varint(2)
        var chunks: [Chunk] = []
        for raw in message.allBytes(3) { chunks.append(try Chunk(ProtoMessage(raw))) }
        self.chunks = chunks
    }

    /// Every Opus packet in page order. One packet is 20 ms of 16 kHz mono audio.
    public var opusPackets: [Data] { chunks.flatMap { $0.audio?.opusPackets ?? [] } }
    public var isEncrypted: Bool { chunks.contains { $0.audio?.isEncrypted == true } }
}

/// `Chunk`: not a oneof, fields can co-exist.
public struct Chunk: Equatable, Sendable {
    /// Milliseconds after the page timestamp (verified: 0 to the page's length; the first chunk can be -1 or -2).
    /// Each audio chunk carries one packet, about 20 ms after the previous one.
    public var timeOffsetMillis: Int64?
    public var audio: AudioData?
    public var button: ButtonStatus?
    public var recording: RecordingStatus?
    public var storage: StorageStatus?
    /// `log_output` (field 10): one firmware log line, as text. Verified on the owner's Pendant; ANSI colour codes kept.
    public var log: String?

    init(_ message: ProtoMessage) throws(ProtocolError) {
        timeOffsetMillis = message.signed(1)
        audio = try message.message(2).map(AudioData.init)
        button = try message.message(3).map(ButtonStatus.init)
        recording = try message.message(9).map(RecordingStatus.init)
        storage = try message.message(12).map {
            StorageStatus(didStartSession: $0.bool(1) ?? false, didStopSession: $0.bool(2) ?? false)
        }
        log = try message.message(10)?.bytes(1).map { String(decoding: $0, as: UTF8.self) }
    }
}

/// `PendantAudioData`. Opus is field 4 (`codec_beamforming_data`), else field 5 (manual beamforming).
/// Any length of at least one byte is kept: DTX/silence packets can be 1–3 bytes. Never split a packet.
public struct AudioData: Equatable, Sendable {
    public var opusPackets: [Data]
    public var didStartRecording: Bool
    public var didStopRecording: Bool
    /// Field 13: a previous host pushed a server key. We can't decode it; the page must not be ACKed.
    public var isEncrypted: Bool

    init(_ message: ProtoMessage) {
        let beamformed = message.allBytes(4).filter { !$0.isEmpty }
        opusPackets = beamformed.isEmpty ? message.allBytes(5).filter { !$0.isEmpty } : beamformed
        didStartRecording = message.bool(8) ?? false
        didStopRecording = message.bool(9) ?? false
        isEncrypted = message.has(13)
    }
}

/// `StorageStatus` chunk. Which marker is the recording boundary is UNVERIFIED; kept as metadata.
public struct StorageStatus: Equatable, Sendable {
    public var didStartSession: Bool
    public var didStopSession: Bool
}

/// `DeviceInfoMsg` (PendantAllMsg field 1, pendant-cli schema): only what identifies the Pendant and its flash life.
///
/// UNVERIFIED on hardware: whether `storage_instance` changes when storage is cleared, and `factory_reset_id` on a
/// factory reset. `storage_run` is not read: it may count reboots, which keep the flash.
public struct DeviceInfo: Equatable, Sendable {
    public var deviceID: UInt64?
    public var serial: String?
    public var storageInstance: UInt64?
    public var factoryResetID: UInt64?

    public init(
        deviceID: UInt64? = nil, serial: String? = nil, storageInstance: UInt64? = nil, factoryResetID: UInt64? = nil
    ) {
        self.deviceID = deviceID
        self.serial = serial
        self.storageInstance = storageInstance
        self.factoryResetID = factoryResetID
    }

    init(_ message: ProtoMessage) {
        deviceID = message.varint(1)
        serial = message.bytes(2).map { String(decoding: $0, as: UTF8.self) }
        storageInstance = message.varint(5)
        factoryResetID = message.varint(16)
    }

    /// Which Pendant and which life of its flash, as one comparable string. `nil` when the Pendant didn't say who
    /// it is.
    public var flashLifeEvidence: String? {
        guard let identity = serial.map({ "serial \($0)" }) ?? deviceID.map({ "device_id \($0)" }) else { return nil }
        let instance = storageInstance.map(String.init) ?? "?"
        let reset = factoryResetID.map(String.init) ?? "?"
        return "\(identity), storage_instance \(instance), factory_reset_id \(reset)"
    }
}

/// `DeviceStatus` (PendantAllMsg field 5).
public struct DeviceStatus: Equatable, Sendable {
    public var storage: StorageState?
    /// `nil` when field 7 is absent: unknown, not "not recording".
    public var recording: RecordingStatus?
    public var battery: BatteryStatus?
    /// Readback for the LED brightness command. UNVERIFIED on hardware.
    public var ledBrightness: UInt64?

    public init(storage: StorageState? = nil, recording: RecordingStatus? = nil, battery: BatteryStatus? = nil) {
        self.storage = storage
        self.recording = recording
        self.battery = battery
    }

    init(_ message: ProtoMessage) throws(ProtocolError) {
        storage = try message.message(5).map(StorageState.init)
        recording = try message.message(7).map(RecordingStatus.init)
        battery = try message.message(9).map(BatteryStatus.init)
        ledBrightness = message.varint(4)
    }
}

/// `StorageState`. proto3: omitted scalars are 0.
public struct StorageState: Equatable, Sendable {
    public var oldestPage: UInt64
    /// `int32`: may be -1 or below `oldestPage` when flash is empty (UNVERIFIED).
    public var newestPage: Int64
    public var session: UInt64
    public var freePages: UInt64
    public var totalPages: UInt64

    public init(oldestPage: UInt64, newestPage: Int64, session: UInt64, freePages: UInt64, totalPages: UInt64) {
        self.oldestPage = oldestPage
        self.newestPage = newestPage
        self.session = session
        self.freePages = freePages
        self.totalPages = totalPages
    }

    init(_ message: ProtoMessage) {
        self.init(
            oldestPage: message.varint(1) ?? 0, newestPage: message.signed(2) ?? 0, session: message.varint(3) ?? 0,
            freePages: message.varint(4) ?? 0, totalPages: message.varint(5) ?? 0)
    }

    /// Pages waiting on the device, `newest - oldest + 1`, or 0 when empty.
    public var backlogPages: UInt64 {
        newestPage >= 0 && UInt64(newestPage) >= oldestPage ? UInt64(newestPage) - oldestPage + 1 : 0
    }
}

/// `RecordingStatus`. Present-but-empty means NOT_RECORDING (proto3 default).
public struct RecordingStatus: Equatable, Sendable {
    public var state: DeviceRecordingState
    /// 0 = button, 1 = ambient sound (VAD).
    public var source: UInt64
    /// Field 3, the detector's level, only when the Pendant sends it. UNVERIFIED: absent from every flash chunk seen,
    /// unit and meaning unknown, so nothing is derived from it yet.
    public var vadLevel: UInt64?

    public init(state: DeviceRecordingState, source: UInt64 = 0, vadLevel: UInt64? = nil) {
        self.state = state
        self.source = source
        self.vadLevel = vadLevel
    }

    init(_ message: ProtoMessage) {
        state = DeviceRecordingState(rawValue: message.varint(1) ?? 0)
        source = message.varint(2) ?? 0
        vadLevel = message.varint(3)
    }
}

public enum DeviceRecordingState: Equatable, Sendable {
    case notRecording
    case recording
    /// Probably VAD-armed, not writing. UNVERIFIED: never treated as recording or paused.
    case listening
    case unknown(UInt64)

    public init(rawValue: UInt64) {
        switch rawValue {
        case 0: self = .notRecording
        case 1: self = .recording
        case 2: self = .listening
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: UInt64 {
        switch self {
        case .notRecording: 0
        case .recording: 1
        case .listening: 2
        case .unknown(let value): value
        }
    }
}

/// `BatteryStatus`. Percentage is better read from the standard 0x2A19 characteristic.
public struct BatteryStatus: Equatable, Sendable {
    /// The state enum conflicts between sources except for 1 = charging.
    public var chargeState: UInt64?
    public var stateOfCharge: Int64?

    public init(chargeState: UInt64?, stateOfCharge: Int64? = nil) {
        self.chargeState = chargeState
        self.stateOfCharge = stateOfCharge
    }

    init(_ message: ProtoMessage) {
        // proto3 omits zero: a present message without field 1 carries state 0.
        chargeState = message.varint(1) ?? 0
        stateOfCharge = message.signed(5)
    }

    /// `true` only for the one value both sources agree on; `nil` when the value is ambiguous.
    public var isCharging: Bool? { chargeState == 1 ? true : nil }
}

/// `ButtonStatus`: live as PendantAllMsg field 8, stored on flash as Chunk field 3.
public struct ButtonStatus: Equatable, Sendable {
    public var event: ButtonEvent
    public var eventTimestampMillis: UInt64?
    public var shortPressesSinceBoot: UInt64

    public init(event: ButtonEvent, eventTimestampMillis: UInt64? = nil, shortPressesSinceBoot: UInt64 = 0) {
        self.event = event
        self.eventTimestampMillis = eventTimestampMillis
        self.shortPressesSinceBoot = shortPressesSinceBoot
    }

    init(_ message: ProtoMessage) {
        event = ButtonEvent(rawValue: message.varint(1) ?? 0)
        eventTimestampMillis = message.varint(6)
        shortPressesSinceBoot = message.varint(3) ?? 0
    }
}

public enum ButtonEvent: Equatable, Sendable {
    case notPressed
    /// Quick press (`QuickPress`).
    case short
    /// ~2 s hold: firmware toggles recording itself. Reflect it, never reverse it.
    case long
    case double
    /// Likely the factory-reset gesture. UNVERIFIED.
    case shortAndSuperLong
    case unknown(UInt64)

    public init(rawValue: UInt64) {
        switch rawValue {
        case 0: self = .notPressed
        case 1: self = .short
        case 2: self = .long
        case 3: self = .double
        case 4: self = .shortAndSuperLong
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: UInt64 {
        switch self {
        case .notPressed: 0
        case .short: 1
        case .long: 2
        case .double: 3
        case .shortAndSuperLong: 4
        case .unknown(let value): value
        }
    }
}
