import Capture
import Foundation

/// One owner-facing alert. Each is notified at most once, and cleared only when that specific problem recovers.
public enum IncidentAlert: String, Sendable, Codable, CaseIterable {
    /// The Pendant stopped recording without a pause from the owner (app or long press).
    case recordingStopped
    /// A pause or resume the owner asked for was rejected or never confirmed.
    case recordingControlFailed
    /// The source store could not make a page durable.
    case storageWriteFailed
    /// Replay conflict or encrypted audio: ACK is held below it.
    case integrity
    case pendantStorageLow
    case phoneStorageLow
    /// No contact with the Pendant for `noContactAfter`. Scheduled ahead of time, because the app is usually
    /// suspended when it becomes true.
    case noContact
    /// At or below the owner's threshold, not charging. Once per discharge (`AlertSettings`).
    case batteryLow
    // Changes made on the Pendant itself, decided by `PendantChangeReducer`. Changes asked for in Life never notify.
    case recordingPausedOnPendant
    case recordingResumedOnPendant
    /// Not answering for `PendantChangeReducer.disconnectAfter` while it recorded: asks for a restart. Scheduled, and
    /// dropped if it comes back sooner. Named before Oct 20; stored by name, so renaming it breaks saved state.
    case pendantDisconnected
    case pendantReconnected
}

/// Alerts the owner can tune. Stored by the app; the reducers only read it.
public struct AlertSettings: Sendable, Codable, Equatable {
    public var lowBattery = true
    public var lowBatteryPercent = 20
    public var lowPendantStorage = true
    public var lowPendantStoragePercent = Int(IncidentReducer.pendantLowBelow * 100)

    public init() {}
}

public enum IncidentEffect: Sendable, Equatable {
    case post(IncidentAlert)
    /// Remove it whether delivered or still scheduled.
    case clear(IncidentAlert)
    /// Deliver at `at` unless rescheduled or cleared first. Replaces any earlier schedule.
    case schedule(IncidentAlert, at: Date)
    /// Drop a pending schedule without touching a delivered one.
    case unschedule(IncidentAlert)
    /// `pendantReconnected`, with the pages still on the Pendant when it's known.
    case postReconnected(catchingUpPages: UInt64?)
}

/// Pure: decides which incident notifications to post, schedule or clear from successive capture snapshots.
/// Codable so "already notified" survives relaunches; a fresh snapshot after launch knows nothing yet, so an
/// absent incident is never taken as recovery — each alert has its own positive recovery evidence.
public struct IncidentReducer: Sendable, Codable, Equatable {
    /// The default Pendant storage threshold, also used by `CaptureCondition`.
    public static let pendantLowBelow = 0.10
    /// Percentage points above a threshold that count as recovered, so a reading hovering on it warns once.
    public static let rearmMargin = 10
    public static let phoneLowBelow: Int64 = 1 << 30
    public static let phoneRecoveredAt: Int64 = 2 << 30
    /// The Pendant records on its own; only a full day without a sync endangers its flash.
    public static let noContactAfter: TimeInterval = 24 * 3600
    /// ponytail: reschedule the no-contact deadline at most this often; the deadline may fire this much early.
    public static let rescheduleStep: TimeInterval = 15 * 60

    public private(set) var notified: Set<IncidentAlert> = []
    /// The contact time the pending no-contact notification counts from.
    public private(set) var noContactAnchor: Date?

    public init() {}

    public mutating func reduce(
        _ status: CaptureStatus, phoneFreeBytes: Int64?, settings: AlertSettings = AlertSettings()
    ) -> [IncidentEffect] {
        var effects: [IncidentEffect] = []
        for alert in IncidentAlert.allCases where alert != .noContact {
            switch evaluate(alert, status, phoneFreeBytes, settings) {
            case .active where !notified.contains(alert):
                notified.insert(alert)
                effects.append(.post(alert))
            case .recovered where notified.contains(alert):
                notified.remove(alert)
                effects.append(.clear(alert))
            default:
                break
            }
        }
        return effects + reduceNoContact(status)
    }

    private enum Evidence {
        case active
        case recovered
        case undetermined
    }

    private func evaluate(
        _ alert: IncidentAlert, _ status: CaptureStatus, _ phoneFree: Int64?, _ settings: AlertSettings
    ) -> Evidence {
        let incidents = status.incidents
        switch alert {
        case .recordingStopped:
            if incidents.contains(.recordingStoppedUnexpectedly) { return .active }
            if case .recording = status.recording { return .recovered }
        case .recordingControlFailed:
            if incidents.contains(where: { if case .recordingControlFailed = $0 { true } else { false } }) {
                return .active
            }
            switch status.recording {
            case .recording, .paused: return .recovered
            default: break
            }
        case .storageWriteFailed:
            if incidents.contains(where: { if case .storageWriteFailed = $0 { true } else { false } }) {
                return .active
            }
            if case .caughtUp = status.sync { return .recovered }
        case .integrity:
            // ponytail: latched until an owner resolution flow exists; the store keeps the evidence.
            let integrity = incidents.contains {
                switch $0 {
                case .integrityConflict, .encryptedAudio, .undecodablePage: true
                default: false
                }
            }
            if integrity { return .active }
        case .pendantStorageLow:
            guard settings.lowPendantStorage, let storage = status.storage?.value, storage.totalPages > 0 else { break }
            let free = Double(storage.freePages) / Double(storage.totalPages) * 100
            if free < Double(settings.lowPendantStoragePercent) { return .active }
            if free >= Double(settings.lowPendantStoragePercent + Self.rearmMargin) { return .recovered }
        case .batteryLow:
            // Charging, or a level well above the threshold (charged away from the phone), re-arms it.
            guard settings.lowBattery, let battery = status.batteryPercent?.value else { break }
            if status.charging?.value == .charging || battery >= settings.lowBatteryPercent + Self.rearmMargin {
                return .recovered
            }
            if battery <= settings.lowBatteryPercent { return .active }
        case .phoneStorageLow:
            guard let phoneFree else { break }
            if phoneFree < Self.phoneLowBelow { return .active }
            if phoneFree >= Self.phoneRecoveredAt { return .recovered }
        case .noContact, .recordingPausedOnPendant, .recordingResumedOnPendant, .pendantDisconnected,
            .pendantReconnected:
            break
        }
        return .undetermined
    }

    private mutating func reduceNoContact(_ status: CaptureStatus) -> [IncidentEffect] {
        // Another app holds the Pendant: the owner chose that and the app says so. Don't count it down.
        if case .busyElsewhere = status.connection {
            guard noContactAnchor != nil else { return [] }
            noContactAnchor = nil
            return [.unschedule(.noContact)]
        }
        guard let contact = status.lastContact, contact > noContactAnchor ?? .distantPast else { return [] }
        var effects: [IncidentEffect] = []
        // Contact is the recovery. Without an anchor (first contact, or after busy elsewhere) a delivered
        // alert may still be showing, so clear it too.
        let fired = noContactAnchor.map { contact.timeIntervalSince($0) >= Self.noContactAfter } ?? true
        if fired { effects.append(.clear(.noContact)) }
        if fired || noContactAnchor.map({ contact.timeIntervalSince($0) >= Self.rescheduleStep }) == true {
            noContactAnchor = contact
            effects.append(.schedule(.noContact, at: contact.addingTimeInterval(Self.noContactAfter)))
        }
        return effects
    }
}
