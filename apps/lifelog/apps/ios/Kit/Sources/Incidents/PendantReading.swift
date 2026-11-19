import Capture
import Foundation
import Glance

/// The one reading of the Pendant that the sheet and the top-bar pill share: which state it is in, whether that needs
/// the owner, and the problems with it, one each. No words: the app says them (`CaptureCondition+Copy`). It is built
/// from the same glance the Watch and the widgets read (`RecordingGlance.reading`), so it is never fresher than the
/// Pendant's own reports. The glance says whether it records; this says what state the Pendant is in.
public struct PendantReading: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        /// A current report says it records.
        case recording
        /// A current report says it does not (paused on the Pendant, or stopped).
        case notRecording
        /// Known, but not reachable: it keeps recording by itself.
        case outOfRange
        /// Not connected for a reason on this side (Bluetooth, another app holds it), or between drains.
        case notConnected
        /// Storage at its end.
        case full
        /// None paired, or none found nearby.
        case noPendant
        /// Nothing confirmed yet, or only an old report: never said as fine.
        case checking
    }

    public var state: State
    /// The state needs the owner: its word is drawn in the flag colour.
    public var isFlag: Bool
    /// When the recording going on now began, if the Pendant confirmed it. Only while `state` is `recording`.
    public var since: Date?
    /// When a long press on the Pendant paused it, if that is the reason it is not recording.
    public var pausedAt: Date?
    /// The problems with the Pendant, one per condition; the state's own cause (checking, none found) is not one.
    public var conditions: [CaptureCondition]
    /// The level, when it is current, at or below the owner's threshold, and not charging.
    public var lowBattery: Int?

    /// A hold on the Pendant this recent is named as the cause of the state it reports.
    public static let longPressWindow: TimeInterval = 600

    /// - Parameters:
    ///   - recordingSince: `CaptureStatus.recordingSince`, read from the stored changes.
    ///   - lowBatteryPercent: the owner's low-battery threshold, `nil` while he turned that alert off.
    public init(
        status: CaptureStatus, context: CaptureContext, recordingSince: Date?, lowBatteryPercent: Int?, now: Date
    ) {
        let all = CaptureCondition.evaluate(status, context: context, now: now)
        let glance = RecordingGlance(
            PendantSnapshot(status, previous: nil), sound: nil, lowBatteryPercent: lowBatteryPercent ?? -1, now: now)
        let isConnected = if case .ready = status.connection { true } else { false }
        func has(_ condition: (CaptureCondition) -> Bool) -> Bool { all.contains(where: condition) }
        let noneFound = has { $0 == .neverConfigured || isNoPendantFound($0) }

        state =
            if noneFound {
                .noPendant
            } else if isConnected && has({ $0 == .pendantStorageFull }) {
                .full
            } else if has({ $0.blocksLink }) {
                .notConnected
            } else if has(isOutOfReach) {
                .outOfRange
            } else if has(isChecking) {
                .checking
            } else {
                Self.state(glance.reading(now: now), connection: status.connection)
            }
        let own: (CaptureCondition) -> Bool = { !isChecking($0) && !($0 == .neverConfigured) && !isNoPendantFound($0) }
        conditions = noneFound ? [] : all.filter(own)
        lowBattery = glance.batteryIsLow(now: now) ? glance.battery : nil
        isFlag =
            [.full, .outOfRange].contains(state) || (state == .notConnected && !conditions.isEmpty)
            || conditions.contains(.recordingStopped)
        since = state == .recording ? recordingSince : nil
        pausedAt = state == .notRecording ? Self.longPress(status, now: now) : nil
    }

    /// Conditions the owner has to act on, for the pill's badge (`CaptureCondition.needsOwner`).
    public var needs: Int { conditions.filter(\.needsOwner).count }

    private static func state(_ reading: RecordingGlance.Reading, connection: ConnectionState) -> State {
        switch (reading, connection) {
        case (.confirmed(.recording, _), _): return .recording
        case (.confirmed(.paused, _), _): return .notRecording
        case (_, .ready), (_, .idle), (_, .discovering): return .checking
        default: return .notConnected
        }
    }

    /// A ~2 s hold the firmware acted on, recent enough to be the reason for the pause shown.
    private static func longPress(_ status: CaptureStatus, now: Date) -> Date? {
        guard let press = status.lastButton, press.value == .long, now.timeIntervalSince(press.at) < longPressWindow
        else { return nil }
        return press.at
    }
}

private func isChecking(_ condition: CaptureCondition) -> Bool {
    if case .checking = condition { true } else { false }
}

private func isOutOfReach(_ condition: CaptureCondition) -> Bool {
    if case .outOfReach = condition { true } else { false }
}

private func isNoPendantFound(_ condition: CaptureCondition) -> Bool {
    if case .noPendantFound = condition { true } else { false }
}
