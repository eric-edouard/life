import Capture
import Foundation
import Incidents

/// What the owner can do about a condition, shown as one compact pill.
enum Recovery: Equatable {
    case openSettings
    case reconnect
    case syncNow

    var title: String {
        switch self {
        case .openSettings: "Open Settings"
        case .reconnect: "Try again"
        case .syncNow: "Sync now"
        }
    }
}

/// The owner-facing words for each condition, two lines: what it means (the known reason, never a guessed one) and
/// what to do about it (the bold one).
extension CaptureCondition {
    var means: String {
        switch self {
        case .protectedDataUnavailable:
            "This iPhone restarted and hasn't been unlocked yet, so lifelog can't open its recordings. The Pendant keeps recording."
        case .archiveUnavailable:
            "Capture is off so nothing goes into a new, empty archive. Your recordings are untouched."
        case .bluetoothPermissionNotDetermined: "lifelog needs Bluetooth to reach your Pendant."
        case .bluetoothDenied: "Bluetooth is off for lifelog, so it can't reach your Pendant. It keeps recording."
        case .bluetoothRestricted:
            "Screen Time or a device profile blocks Bluetooth for apps, so lifelog can't reach your Pendant."
        case .bluetoothUnsupported: "This device can't talk to a Pendant."
        case .bluetoothOff: "Bluetooth is off. The Pendant keeps recording, and lifelog syncs when it is back."
        case .neverConfigured: "No Pendant is set up on this iPhone yet."
        case .noPendantFound(let since):
            "Searching since \(since.formatted(date: .omitted, time: .shortened)). A Pendant paired to another phone doesn't show up."
        case .pairingPending: "The Pendant is waiting for this iPhone to accept pairing."
        case .busyElsewhere:
            "Another app, probably the Limitless app, holds the Pendant. lifelog let go so it doesn't fight it."
        case .checking(let since):
            "Waiting since \(since.formatted(date: .omitted, time: .shortened)) for its first report."
        case .notReady(let since):
            "Connected since \(since.formatted(date: .omitted, time: .shortened)), but it hasn't finished setting up."
        case .outOfReach: "The phone can't reach it. It keeps recording by itself."
        case .staleTelemetry(let lastContact):
            "\(Self.lastContact(lastContact)) What is shown is last known, not current."
        case .transferIncomplete(let index):
            "Page \(index) didn't arrive. Nothing past it is cleared from the Pendant; the next sync asks for it again."
        case .noReply: "The Pendant didn't answer a status request."
        case .storageWriteFailed(let detail):
            "Nothing is deleted from the Pendant until it is saved here. Details: \(detail)"
        case .phoneStorageLow(let free):
            "\(free.formatted(.byteCount(style: .file))) free. lifelog needs space to save new recordings."
        case .pendantStorageLow(let fraction):
            "\(fraction.formatted(.percent.precision(.fractionLength(0)))) free. It stops recording when full."
        case .pendantStorageFull: "Recording has stopped. Audio is leaving the pendant now."
        case .recordingStopped:
            "It reported it isn't recording, and nobody paused it from lifelog or with a long press."
        case .recordingControlFailed(.rejected(_, let message)): "The Pendant refused the command: \(message)"
        case .recordingControlFailed(.unconfirmed):
            "The Pendant never confirmed the change, so it may or may not have happened."
        }
    }

    var todo: String {
        switch self {
        case .protectedDataUnavailable: "Unlock your iPhone."
        case .archiveUnavailable: "Restart lifelog."
        case .bluetoothPermissionNotDetermined: "Allow Bluetooth when iOS asks."
        case .bluetoothDenied: "Turn on Bluetooth for lifelog in Settings."
        case .bluetoothRestricted: "Allow Bluetooth for apps in Screen Time."
        case .bluetoothUnsupported: "Use another iPhone."
        case .bluetoothOff: "Turn on Bluetooth."
        case .neverConfigured: "Pair your pendant."
        case .noPendantFound: "Keep it close and charged."
        case .pairingPending: "Accept the pairing request."
        case .busyElsewhere: "Close the other app's connection, then try again."
        case .checking: "Wait a moment."
        case .notReady: "Wait, or try again."
        case .outOfReach: "Bring it within a few metres."
        case .staleTelemetry: "Sync now."
        case .transferIncomplete, .noReply: "Sync again."
        case .storageWriteFailed: "Free some space on this iPhone."
        case .phoneStorageLow: "Free some space on this iPhone."
        case .pendantStorageLow: "Keep it near this iPhone so it can sync."
        case .pendantStorageFull: "Keep the app open near it."
        case .recordingStopped: "Check it is charged and press its button."
        case .recordingControlFailed: "Sync to ask what it is doing."
        }
    }

    var recovery: Recovery? {
        switch self {
        case .bluetoothDenied, .bluetoothRestricted, .bluetoothOff, .phoneStorageLow: .openSettings
        case .busyElsewhere, .notReady, .pairingPending: .reconnect
        case .staleTelemetry, .transferIncomplete, .noReply, .storageWriteFailed, .pendantStorageLow,
            .recordingControlFailed:
            .syncNow
        case .neverConfigured, .noPendantFound, .outOfReach, .protectedDataUnavailable, .archiveUnavailable,
            .bluetoothPermissionNotDetermined, .bluetoothUnsupported, .checking, .recordingStopped,
            .pendantStorageFull:
            nil
        }
    }

    private static func lastContact(_ date: Date?) -> String {
        guard let date else { return "No contact since lifelog started." }
        return "Last contact \(date.formatted(date: .abbreviated, time: .shortened))."
    }
}
