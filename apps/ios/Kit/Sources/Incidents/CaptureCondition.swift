import Capture
import Foundation

/// What Life knows about capture beside the Pendant's own status.
public struct CaptureContext: Sendable, Equatable {
    public enum BluetoothPermission: Sendable, Equatable {
        case notDetermined
        case denied
        /// Blocked by Screen Time or a profile; the owner can't grant it from Life's settings alone.
        case restricted
        case allowed
    }

    /// Why the archive would not open, if it didn't.
    public var archiveError: String?
    /// False before the first unlock after a restart: the archive's files can't be opened yet.
    public var protectedDataAvailable: Bool
    /// A Pendant was paired or connected before.
    public var hasKnownPendant: Bool
    public var bluetoothPermission: BluetoothPermission
    /// When `CaptureStatus.connection` last changed.
    public var connectionSince: Date
    public var phoneFreeBytes: Int64?
    /// Last contact with the Pendant before this launch (`CaptureStatus` only knows this one).
    public var lastContact: Date?

    public init(
        archiveError: String? = nil, protectedDataAvailable: Bool = true, hasKnownPendant: Bool = true,
        bluetoothPermission: BluetoothPermission = .allowed, connectionSince: Date, phoneFreeBytes: Int64? = nil,
        lastContact: Date? = nil
    ) {
        self.archiveError = archiveError
        self.protectedDataAvailable = protectedDataAvailable
        self.hasKnownPendant = hasKnownPendant
        self.bluetoothPermission = bluetoothPermission
        self.connectionSince = connectionSince
        self.phoneFreeBytes = phoneFreeBytes
        self.lastContact = lastContact
    }
}

/// One condition the owner should know about, with the way out. Short disconnections and routine retries are not
/// conditions: they recover quietly.
public enum CaptureCondition: Sendable, Equatable {
    case protectedDataUnavailable
    case archiveUnavailable(String)
    case bluetoothPermissionNotDetermined
    case bluetoothDenied
    case bluetoothRestricted
    case bluetoothUnsupported
    case bluetoothOff
    case neverConfigured
    case noPendantFound(since: Date)
    case pairingPending
    case busyElsewhere
    /// The Pendant hasn't answered since launch: nothing about it is confirmed yet, so nothing is reported as fine.
    case checking(since: Date)
    case notReady(since: Date)
    /// Out of reach long enough to matter. The Pendant keeps recording; its pages wait on it.
    case outOfReach(lastContact: Date?)
    /// Connected, but no telemetry within one cycle: what's shown is last known.
    case staleTelemetry(lastContact: Date?)
    case transferIncomplete(missingFrom: UInt64)
    case noReply
    case storageWriteFailed(String)
    case phoneStorageLow(freeBytes: Int64)
    case pendantStorageLow(freeFraction: Double)
    case recordingStopped
    case recordingControlFailed(RecordingFailure)

    /// Scanning this long without finding a known Pendant is "not found".
    public static let noPendantAfter: TimeInterval = 60
    /// Services this slow to come up are worth saying.
    public static let notReadyAfter: TimeInterval = 30
    /// Reconnects shorter than this stay quiet.
    public static let outOfReachAfter: TimeInterval = 120
    /// A known Pendant in range answers a launch's pending connect within this; past it, it's out of reach.
    public static let checkingFor: TimeInterval = 10

    /// Every condition that holds now, most fundamental first. Connection conditions are exclusive; storage,
    /// sync and recording problems are independent of them.
    public static func evaluate(_ status: CaptureStatus, context: CaptureContext, now: Date) -> [CaptureCondition] {
        if let error = context.archiveError {
            return [context.protectedDataAvailable ? .archiveUnavailable(error) : .protectedDataUnavailable]
        }
        var conditions: [CaptureCondition] = []
        if let connection = connectionCondition(status, context: context, now: now) {
            conditions.append(connection)
        }
        if case .failed(let failure) = status.sync {
            switch failure {
            case .incomplete(let index): conditions.append(.transferIncomplete(missingFrom: index))
            case .noReply: conditions.append(.noReply)
            case .storage(let detail):
                let reported = status.incidents.contains { if case .storageWriteFailed = $0 { true } else { false } }
                if !reported { conditions.append(.storageWriteFailed(detail)) }
            }
        }
        for incident in status.incidents.sorted(by: { "\($0)" < "\($1)" }) {
            switch incident {
            case .storageWriteFailed(let detail): conditions.append(.storageWriteFailed(detail))
            case .recordingStoppedUnexpectedly: conditions.append(.recordingStopped)
            case .recordingControlFailed(let failure): conditions.append(.recordingControlFailed(failure))
            // The source store's open incidents carry these, with the owner's choices.
            case .integrityConflict, .encryptedAudio, .undecodablePage: break
            }
        }
        if let free = context.phoneFreeBytes, free < IncidentReducer.phoneLowBelow {
            conditions.append(.phoneStorageLow(freeBytes: free))
        }
        if let storage = status.storage?.value, storage.totalPages > 0 {
            let fraction = Double(storage.freePages) / Double(storage.totalPages)
            if fraction < IncidentReducer.pendantLowBelow {
                conditions.append(.pendantStorageLow(freeFraction: fraction))
            }
        }
        return conditions
    }

    private static func connectionCondition(_ status: CaptureStatus, context: CaptureContext, now: Date)
        -> CaptureCondition?
    {
        let elapsed = now.timeIntervalSince(context.connectionSince)
        // Before the Pendant's first answer since launch there is no evidence that anything is fine.
        let unconfirmed = status.lastReply == nil
        switch status.connection {
        case .idle:
            if context.bluetoothPermission == .notDetermined { return .bluetoothPermissionNotDetermined }
            // Launch never scans, so with no Pendant set up the app waits for the owner, not for a report.
            return context.hasKnownPendant ? nil : .neverConfigured
        case .unauthorized:
            return context.bluetoothPermission == .restricted ? .bluetoothRestricted : .bluetoothDenied
        case .unsupported:
            return .bluetoothUnsupported
        case .bluetoothOff:
            return .bluetoothOff
        case .scanning:
            if !context.hasKnownPendant && status.lastContact == nil { return .neverConfigured }
            return elapsed >= noPendantAfter ? .noPendantFound(since: context.connectionSince) : nil
        case .connecting, .disconnected:
            let lastContact = status.lastContact ?? context.lastContact
            // At launch a known Pendant in range answers quickly; a short disconnection after evidence stays quiet.
            if unconfirmed && elapsed < checkingFor { return .checking(since: context.connectionSince) }
            return unconfirmed || elapsed >= outOfReachAfter ? .outOfReach(lastContact: lastContact) : nil
        case .discovering:
            if elapsed >= notReadyAfter { return .notReady(since: context.connectionSince) }
            return unconfirmed ? .checking(since: context.connectionSince) : nil
        case .pairingPending:
            return .pairingPending
        case .busyElsewhere:
            return .busyElsewhere
        case .resting:
            // An Omi between drains, by design.
            return nil
        case .ready:
            guard let reply = status.lastReply else { return .checking(since: context.connectionSince) }
            return EvidenceFreshness(observedAt: reply, now: now) == .fresh
                ? nil : .staleTelemetry(lastContact: status.lastContact)
        }
    }
}

/// The sync line, steady through the small transfers every cycle makes and with real progress for a catch-up.
public enum SyncSummary: Sendable, Equatable {
    /// Nothing synced since launch and nothing running.
    case notYet
    /// A first sync is running, too small to show progress.
    case syncing
    case upToDate(Date)
    case catchingUp(DrainProgress)
    case failed(DrainFailure)

    /// Below this many pages a transfer is routine and keeps the last "up to date" line.
    /// ponytail: one fixed threshold; calibrate on hardware.
    public static let catchUpPages: UInt64 = 300

    public init(_ phase: DrainPhase, lastCaughtUp: Date?) {
        switch phase {
        case .downloading(let progress) where progress.expected >= Self.catchUpPages,
            .persisting(let progress) where progress.expected >= Self.catchUpPages:
            self = .catchingUp(progress)
        case .caughtUp(let at):
            self = .upToDate(at)
        case .failed(let failure):
            self = .failed(failure)
        case .idle:
            self = lastCaughtUp.map(Self.upToDate) ?? .notYet
        case .requestingStatus, .downloading, .persisting, .acking, .gapRecorded:
            self = lastCaughtUp.map(Self.upToDate) ?? .syncing
        }
    }
}
