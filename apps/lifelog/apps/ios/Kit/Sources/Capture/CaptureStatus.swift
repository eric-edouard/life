import Foundation
import PendantProtocol
import SourceStore

/// A value together with when the device last told us. `nil` in the snapshot means "unknown";
/// a stale `Observed` is "last known".
public struct Observed<Value: Sendable & Equatable>: Sendable, Equatable {
    public var value: Value
    public var at: Date

    public init(_ value: Value, at: Date) {
        self.value = value
        self.at = at
    }
}

extension Observed: Codable where Value: Codable {}

public struct DrainProgress: Sendable, Equatable {
    /// Pages not yet saved when this drain started (`Backlog.pages`), not every page the Pendant holds.
    public var expected: UInt64
    public var received: UInt64
    /// Of those, stored, duplicate or recorded as a gap.
    public var settled: UInt64

    public init(expected: UInt64, received: UInt64, settled: UInt64) {
        self.expected = expected
        self.received = received
        self.settled = settled
    }
}

public enum DrainFailure: Sendable, Equatable {
    /// The device didn't answer the status query.
    case noReply
    /// The source store could not make a page or gap durable. Nothing past it is ACKed.
    case storage(String)
    /// The download ended with pages still missing from the contiguous run; the ACK stalls there.
    case incomplete(missingFrom: UInt64)
}

public enum DrainPhase: Sendable, Equatable {
    case idle
    case requestingStatus
    case downloading(DrainProgress)
    /// Download finished; pages still being made durable.
    case persisting(DrainProgress)
    case acking(throughIndex: UInt64)
    case gapRecorded(index: UInt64, reason: GapReason)
    case caughtUp(at: Date)
    case failed(DrainFailure)
}

/// Problems that need the owner. Each clears only when that specific problem recovers.
public enum CaptureIncident: Sendable, Equatable, Hashable {
    /// Same index came back with different bytes or time (possible index restart). ACK stops below it.
    case integrityConflict(index: UInt64)
    /// A previous host turned on audio encryption. Reboot the Pendant; these pages are never ACKed.
    case encryptedAudio(index: UInt64)
    /// A page this app can't decode. Kept on the Pendant until the owner accepts it as a gap.
    case undecodablePage(index: UInt64)
    case storageWriteFailed(String)
    case recordingStoppedUnexpectedly
    case recordingControlFailed(RecordingFailure)
}

public struct Backlog: Sendable, Equatable {
    public var pages: UInt64
    /// An estimate from audio measured in pages saved so far; `nil` until there is data to calibrate on.
    public var estimatedDuration: Duration?

    public init(pages: UInt64, estimatedDuration: Duration?) {
        self.pages = pages
        self.estimatedDuration = estimatedDuration
    }
}

public enum ChargingState: Sendable, Equatable {
    case charging
    /// The sources disagree on every other value; kept raw until seen on hardware.
    case unverified(UInt64)
}

/// Pages this launch saved, for the background-wake log. `pushed`: sent by the Pendant on its own while the stream
/// stayed open after a drain. `pulled`: sent in a drain we asked for. `duplicates`: re-sent pages already on disk.
/// `bytes` counts new pages only.
public struct SavedPages: Sendable, Equatable, Codable {
    public var pushed = 0
    public var pulled = 0
    public var duplicates = 0
    public var bytes = 0

    public init() {}
}

/// How long a live connection went without a handled Pendant message, the transport event the run loop was parked in
/// (`nil`: idle, the transport delivered nothing) and the writes still waiting on the transport (none: a sink call).
public struct Stall: Sendable, Equatable {
    public var silentSeconds: Int
    public var parkedIn: String?
    public var writesInFlight: Int
}

/// Everything the UI shows about the Pendant, as one Sendable value.
public struct CaptureStatus: Sendable, Equatable {
    public var connection: ConnectionState = .idle
    public var recording: RecordingState = .unknown
    public var lastKnownRecording: Observed<KnownRecording>?
    public var sync: DrainPhase = .idle
    public var backlog: Observed<Backlog>?
    public var batteryPercent: Observed<Int>?
    public var charging: Observed<ChargingState>?
    public var storage: Observed<StorageState>?
    public var lastContact: Date?
    /// The last time the app stopped handling a live connection's messages (`Stall`); it then drops the link.
    public var lastStall: Observed<Stall>?
    /// When the Pendant last answered over its own protocol, not just the radio link. `nil` until its first answer
    /// since launch: until then nothing about it is known.
    public var lastReply: Date?
    public var lastButton: Observed<ButtonEvent>?
    /// Whether the Pendant is storing sound, and when that last held. `nil` until the Pendant gave evidence.
    public var soundActivity: Observed<SoundActivity>?
    public var lastAcknowledgedIndex: UInt64?
    public var incidents: Set<CaptureIncident> = []
    public var saved = SavedPages()
    /// Messages dropped since launch: a malformed fragment, or a message that didn't decode. Safe for ACK, since an
    /// unacknowledged page comes back on the next drain, but counted so a hole is never silent.
    public var droppedMessages = 0
    /// Which pendant the last connection was. `nil` before the first since launch.
    public var deviceKind: DeviceKind?
    /// The Omi's firmware version, which says whether it frees records on delivery (`OmiFirmware`).
    public var firmwareRevision: String?

    public init() {}
}

extension CaptureStatus {
    /// The battery level with what the Pendant was doing, for learning its drain (`BatteryLife`). Only a connected,
    /// not charging Pendant with a confirmed recording state is observed.
    public func batteryReading(at now: Date) -> BatteryReading? {
        guard let percent = batteryPercent?.value else { return nil }
        let state: BatteryReading.State =
            switch (connection, charging?.value, recording) {
            case (.ready, .charging?, _): .unobserved
            case (.ready, _, .recording): .recording
            case (.ready, _, .paused): .paused
            default: .unobserved
            }
        return BatteryReading(at: now, percent: percent, state: state)
    }
}
