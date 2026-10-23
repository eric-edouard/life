import Capture
import Foundation
import Incidents
import PendantProtocol

/// Which build and phone a report comes from (openapi `HeartbeatUpload.build`, `DiagnosticUpload.build`).
public struct BuildInfo: Codable, Sendable, Equatable {
    public var appVersion: String
    public var appBuild: String
    /// "iOS 27.0 (24A100)".
    public var os: String
    /// The model identifier, "iPhone17,1".
    public var device: String
    /// The running executable's Mach-O UUID, which is its dSYM's. Heartbeats only: a diagnostic names the binaries in
    /// its own stacks, from the build that recorded it.
    public var executableUUID: String?

    public init(appVersion: String, appBuild: String, os: String, device: String, executableUUID: String? = nil) {
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.os = os
        self.device = device
        self.executableUUID = executableUUID
    }
}

/// The phone's capture health at one moment, for the owner when he is away from the Mac (openapi `HeartbeatUpload`).
/// States, times, counts and the time zone only: no audio, transcript text, names, places, coordinates, Bluetooth
/// identifiers or error text. Enum values are case names without their payloads.
public struct Heartbeat: Codable, Sendable, Equatable {
    public enum Reason: String, Codable, Sendable {
        case periodic
        /// The Pendant connected or lost its connection.
        case disconnect
        /// Pages the store holds back (integrity, encryption), or the phone low on space.
        case storageIncident = "storage_incident"
        /// A page or gap could not be made durable.
        case writeFailure = "write_failure"
        /// What the Pendant records changed: on, off, unknown.
        case recording
    }

    public struct Connection: Codable, Sendable, Equatable {
        var state: String
        var disconnectReason: String?
        var since: Date
        var lastContact: Date?
        var lastReply: Date?
    }

    public struct Recording: Codable, Sendable, Equatable {
        var state: String
        var lastKnown: String?
        var lastKnownAt: Date?
    }

    public struct Backlog: Codable, Sendable, Equatable {
        var pages: UInt64
        var estimatedSeconds: Double?
        var observedAt: Date
    }

    public struct Pendant: Codable, Sendable, Equatable {
        var batteryPercent: Int?
        var charging: String?
        var freePages: UInt64?
        var totalPages: UInt64?
    }

    public struct Phone: Codable, Sendable, Equatable {
        /// 0...1, `nil` when iOS doesn't say.
        public var batteryLevel: Double?
        public var charging: Bool?
        public var freeBytes: Int64?
        public var lowPowerMode: Bool

        public init(batteryLevel: Double?, charging: Bool?, freeBytes: Int64?, lowPowerMode: Bool) {
            self.batteryLevel = batteryLevel
            self.charging = charging
            self.freeBytes = freeBytes
            self.lowPowerMode = lowPowerMode
        }
    }

    /// Background wakes in the last 24 h (`WakeLog`): counts only.
    public struct Wakes: Codable, Sendable, Equatable {
        var last24h: Int
        var pagesSaved24h: Int
        var duplicates24h: Int
        var bytes24h: Int
        var lastAt: Date?
    }

    public var id: UUID
    public var reason: Reason
    public var observedAt: Date
    public var build: BuildInfo
    var connection: Connection
    var recording: Recording
    var sync: String
    var backlog: Backlog?
    var pendant: Pendant
    var phone: Phone
    var incidents: [String]
    var wakes: Wakes
    /// Pendant messages dropped since launch (`CaptureStatus.droppedMessages`).
    var droppedMessages: Int
    /// The phone's zone, "Europe/Berlin": the server shows the owner's days and times in it.
    var timeZone: String

    public init(
        id: UUID = UUID(), reason: Reason, at now: Date, build: BuildInfo, status: CaptureStatus, connectionSince: Date,
        lastContact: Date?, phone: Phone, wakeLog: WakeLog, timeZone: TimeZone = .current
    ) {
        self.id = id
        self.timeZone = timeZone.identifier
        self.reason = reason
        observedAt = now
        self.build = build
        connection = Connection(
            state: status.connection.caseName, disconnectReason: status.connection.disconnectReason,
            since: connectionSince, lastContact: status.lastContact ?? lastContact, lastReply: status.lastReply)
        recording = Recording(
            state: status.recording.caseName, lastKnown: status.lastKnownRecording?.value.caseName,
            lastKnownAt: status.lastKnownRecording?.at)
        sync = status.sync.caseName
        backlog = status.backlog.map {
            Backlog(
                pages: $0.value.pages, estimatedSeconds: $0.value.estimatedDuration.map { $0 / .seconds(1) },
                observedAt: $0.at)
        }
        pendant = Pendant(
            batteryPercent: status.batteryPercent?.value, charging: status.charging?.value.caseName,
            freePages: status.storage?.value.freePages, totalPages: status.storage?.value.totalPages)
        self.phone = phone
        incidents = status.incidents.map(\.caseName).sorted()
        droppedMessages = status.droppedMessages
        let recent = wakeLog.wakes.filter { now.timeIntervalSince($0.start) <= 24 * 3600 }
        wakes = Wakes(
            last24h: recent.count, pagesSaved24h: recent.reduce(0) { $0 + $1.saved.pushed + $1.saved.pulled },
            duplicates24h: recent.reduce(0) { $0 + $1.saved.duplicates },
            bytes24h: recent.reduce(0) { $0 + $1.saved.bytes }, lastAt: wakeLog.wakes.last?.end)
    }
}

/// When a heartbeat is due: at most every `period` while the app runs, and at once on a notable event (each reported
/// once per occurrence), on each change of the Pendant's connection or recording that the server reads, or when the
/// phone's time zone changes. Persist it between launches so a restart neither repeats nor forgets a change.
public struct HeartbeatSchedule: Codable, Sendable, Equatable {
    public static let period: TimeInterval = 6 * 3600

    /// What the server reads of the Pendant: connected or not, and recording as the server decides it, `lastKnown ??
    /// state` (`pendantRecording`, docs/voice/processing.md).
    private struct Pendant: Codable, Sendable, Equatable {
        var connected: Bool
        var recording: String

        init(_ status: CaptureStatus) {
            connected = if case .ready = status.connection { true } else { false }
            recording = status.lastKnownRecording?.value.caseName ?? status.recording.caseName
        }
    }

    public private(set) var lastSent: Date?
    /// The zone the last heartbeat carried.
    private var lastZone: String?
    private var problems: Set<Heartbeat.Reason> = []
    private var pendant: Pendant?

    public init() {}

    /// The reason a heartbeat is due now, if one is; the caller then sends it.
    public mutating func due(
        _ status: CaptureStatus, phoneFreeBytes: Int64?, now: Date, timeZone: TimeZone = .current
    ) -> Heartbeat.Reason? {
        let periodic =
            timeZone.identifier != lastZone || lastSent.map { now.timeIntervalSince($0) >= Self.period } ?? true
        let reason = event(status, phoneFreeBytes: phoneFreeBytes) ?? (periodic ? .periodic : nil)
        if reason != nil { (lastSent, lastZone) = (now, timeZone.identifier) }
        return reason
    }

    private mutating func event(_ status: CaptureStatus, phoneFreeBytes: Int64?) -> Heartbeat.Reason? {
        var present: Set<Heartbeat.Reason> = []
        if status.sync.isStorageFailure || status.incidents.contains(where: \.isWriteFailure) {
            present.insert(.writeFailure)
        }
        if status.incidents.contains(where: \.holdsPages) || (phoneFreeBytes ?? .max) < IncidentReducer.phoneLowBelow {
            present.insert(.storageIncident)
        }
        let new = present.subtracting(problems)
        problems = present
        // An Omi connects only to drain and reports no recording state: its link and recording are not events.
        let now = status.deviceKind == .omi ? nil : Pendant(status)
        defer { pendant = now }
        if new.contains(.writeFailure) { return .writeFailure }
        if new.contains(.storageIncident) { return .storageIncident }
        // ponytail: one heartbeat per change, link flaps included; debounce if they ever crowd the outbox.
        if let pendant, let now, pendant.connected != now.connected { return .disconnect }
        if let pendant, let now, pendant != now { return .recording }
        return nil
    }
}

// Case names on the wire (openapi enums), without payloads: those carry Bluetooth identifiers and error text.

extension ConnectionState {
    var caseName: String {
        switch self {
        case .idle: "idle"
        case .bluetoothOff: "bluetooth_off"
        case .unauthorized: "unauthorized"
        case .unsupported: "unsupported"
        case .scanning: "scanning"
        case .connecting: "connecting"
        case .discovering: "discovering"
        case .pairingPending: "pairing_pending"
        case .ready: "ready"
        case .busyElsewhere: "busy_elsewhere"
        // The server's names: an Omi between drains is a link Life let go of.
        case .disconnected, .resting: "disconnected"
        }
    }

    var disconnectReason: String? {
        if case .resting = self { return "cancelled" }
        guard case .disconnected(_, let reason) = self else { return nil }
        return switch reason {
        case .linkLost: "link_lost"
        case .connectFailed: "connect_failed"
        case .cancelled: "cancelled"
        }
    }
}

extension RecordingState {
    var caseName: String {
        switch self {
        case .unknown: "unknown"
        case .recording: "recording"
        case .paused: "paused"
        case .pauseRequested: "pause_requested"
        case .resumeRequested: "resume_requested"
        case .failed: "failed"
        }
    }
}

extension KnownRecording {
    var caseName: String {
        switch self {
        case .paused: "not_recording"
        case .recording: "recording"
        case .unrecognized: "unknown"
        }
    }
}

extension ChargingState {
    var caseName: String {
        switch self {
        case .charging: "charging"
        case .unverified: "unverified"
        }
    }
}

extension DrainPhase {
    var caseName: String {
        switch self {
        case .idle: "idle"
        case .requestingStatus: "requesting_status"
        case .downloading: "downloading"
        case .persisting: "persisting"
        case .acking: "acking"
        case .gapRecorded: "gap_recorded"
        case .caughtUp: "caught_up"
        case .failed: "failed"
        }
    }

    var isStorageFailure: Bool {
        if case .failed(.storage) = self { true } else { false }
    }
}

extension CaptureIncident {
    var caseName: String {
        switch self {
        case .integrityConflict: "integrity_conflict"
        case .encryptedAudio: "encrypted_audio"
        case .undecodablePage: "undecodable_page"
        case .storageWriteFailed: "storage_write_failed"
        case .recordingStoppedUnexpectedly: "recording_stopped_unexpectedly"
        case .recordingControlFailed: "recording_control_failed"
        }
    }

    var isWriteFailure: Bool {
        if case .storageWriteFailed = self { true } else { false }
    }

    /// Pages the store keeps on the Pendant until the owner decides.
    var holdsPages: Bool {
        switch self {
        case .integrityConflict, .encryptedAudio, .undecodablePage: true
        default: false
        }
    }
}
