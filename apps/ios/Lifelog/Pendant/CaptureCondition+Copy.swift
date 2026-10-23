import Capture
import Foundation
import Incidents

/// What the owner can do about a condition, shown as one button.
enum Recovery: Equatable {
    case openSettings
    case pair
    case reconnect
    case syncNow
    case resume

    var title: String {
        switch self {
        case .openSettings: "Open Settings"
        case .pair: "Pair Pendant"
        case .reconnect: "Try again"
        case .syncNow: "Sync now"
        case .resume: "Resume recording"
        }
    }
}

/// The owner-facing words for each condition: the known reason, never a guessed one.
extension CaptureCondition {
    var title: String {
        switch self {
        case .protectedDataUnavailable: "Unlock your iPhone"
        case .archiveUnavailable: "Recordings archive won't open"
        case .bluetoothPermissionNotDetermined: "Bluetooth permission needed"
        case .bluetoothDenied: "Bluetooth is off for lifelog"
        case .bluetoothRestricted: "Bluetooth is restricted"
        case .bluetoothUnsupported: "No Bluetooth on this device"
        case .bluetoothOff: "Bluetooth is off"
        case .neverConfigured: "No Pendant set up yet"
        case .noPendantFound: "No Pendant found nearby"
        case .pairingPending: "Waiting for pairing"
        case .busyElsewhere: "Pendant busy with another app"
        case .checking: "Checking the Pendant"
        case .notReady: "Connected, not ready yet"
        case .outOfReach: "Pendant out of reach"
        case .staleTelemetry: "Pendant hasn't reported recently"
        case .transferIncomplete: "Sync stopped at a missing page"
        case .noReply: "Pendant didn't answer"
        case .storageWriteFailed: "Can't save recordings on this iPhone"
        case .phoneStorageLow: "iPhone storage almost full"
        case .pendantStorageLow: "Pendant storage almost full"
        case .recordingStopped: "Pendant stopped recording"
        case .recordingControlFailed(let failure): "\(failure.intent == .pause ? "Pause" : "Resume") didn't take effect"
        }
    }

    var detail: String {
        switch self {
        case .protectedDataUnavailable:
            "This iPhone restarted and hasn't been unlocked yet, so lifelog can't open its recordings. The Pendant keeps recording meanwhile."
        case .archiveUnavailable:
            "Capture is off so nothing goes into a new, empty archive. Your recordings are untouched."
        case .bluetoothPermissionNotDetermined:
            "Allow Bluetooth when iOS asks, so lifelog can reach your Pendant."
        case .bluetoothDenied:
            "lifelog can't reach your Pendant. Turn on Bluetooth for lifelog in Settings. The Pendant keeps recording."
        case .bluetoothRestricted:
            "Screen Time or a device profile blocks Bluetooth for apps. Change it there to let lifelog reach your Pendant."
        case .bluetoothUnsupported:
            "This device can't talk to a Pendant."
        case .bluetoothOff:
            "Turn it on in Control Center or Settings. The Pendant keeps recording, and lifelog syncs when Bluetooth is back."
        case .neverConfigured:
            "Pair your Pendant to save its recordings on this iPhone. lifelog is also scanning for one nearby."
        case .noPendantFound(let since):
            "Searching since \(since.formatted(date: .omitted, time: .shortened)). Keep the Pendant close and charged. A Pendant paired to another phone doesn't show up."
        case .pairingPending:
            "Accept the pairing request on this iPhone. If the Pendant is paired to another phone, unpair it there first."
        case .busyElsewhere:
            "Another app, probably the Limitless app, holds the Pendant. lifelog let go so it doesn't fight it. Close that connection, then try again."
        case .checking(let since):
            "Waiting since \(since.formatted(date: .omitted, time: .shortened)) for the Pendant's first report. Nothing is confirmed until it answers."
        case .notReady(let since):
            "Connected since \(since.formatted(date: .omitted, time: .shortened)), but the Pendant hasn't finished setting up."
        case .outOfReach(let lastContact):
            "\(Self.lastContact(lastContact)) The Pendant keeps recording; its recordings wait on it and sync when it's back near this iPhone."
        case .staleTelemetry(let lastContact):
            "\(Self.lastContact(lastContact)) What's shown below is last known, not current."
        case .transferIncomplete(let index):
            "Page \(index) didn't arrive. Nothing past it is cleared from the Pendant; the next sync asks for it again."
        case .noReply:
            "The Pendant didn't answer a status request. lifelog tries again on the next sync."
        case .storageWriteFailed(let detail):
            "Nothing is deleted from the Pendant until it's saved here. If storage is full, free some space. Details: \(detail)"
        case .phoneStorageLow(let free):
            "\(free.formatted(.byteCount(style: .file))) free. lifelog needs space to save new recordings."
        case .pendantStorageLow(let fraction):
            "\(fraction.formatted(.percent.precision(.fractionLength(0)))) free. It stops recording when full; keep it near this iPhone so it can sync."
        case .recordingStopped:
            "It reported it isn't recording, and nobody paused it from lifelog or with a long press."
        case .recordingControlFailed(.rejected(_, let message)):
            "The Pendant refused the command: \(message)"
        case .recordingControlFailed(.unconfirmed):
            "The Pendant never confirmed the change, so it may or may not have happened. Sync to ask what it's doing."
        }
    }

    var systemImage: String {
        switch self {
        case .protectedDataUnavailable: "lock"
        case .archiveUnavailable, .storageWriteFailed: "externaldrive.badge.exclamationmark"
        case .bluetoothPermissionNotDetermined, .bluetoothDenied, .bluetoothRestricted, .bluetoothUnsupported,
            .bluetoothOff:
            "antenna.radiowaves.left.and.right.slash"
        case .neverConfigured, .noPendantFound, .pairingPending: "link.badge.plus"
        case .busyElsewhere: "person.2"
        case .notReady, .noReply, .staleTelemetry: "clock.badge.exclamationmark"
        case .checking: "hourglass"
        case .outOfReach: "wifi.slash"
        case .transferIncomplete: "exclamationmark.arrow.circlepath"
        case .phoneStorageLow, .pendantStorageLow: "internaldrive"
        case .recordingStopped, .recordingControlFailed: "mic.slash"
        }
    }

    var recovery: Recovery? {
        switch self {
        case .bluetoothDenied, .bluetoothRestricted, .bluetoothOff, .phoneStorageLow: .openSettings
        case .neverConfigured, .noPendantFound: .pair
        case .pairingPending, .busyElsewhere, .notReady, .outOfReach: .reconnect
        case .staleTelemetry, .transferIncomplete, .noReply, .storageWriteFailed, .pendantStorageLow,
            .recordingControlFailed:
            .syncNow
        case .recordingStopped: .resume
        case .protectedDataUnavailable, .archiveUnavailable, .bluetoothPermissionNotDetermined,
            .bluetoothUnsupported, .checking:
            nil
        }
    }

    /// Conditions that keep lifelog from the Pendant altogether: the status sentence says them instead of a
    /// recording state. Checking says "Checking…" and out of reach "Not connected.", each with the last known state;
    /// the rest are cards.
    var blocksLink: Bool {
        switch self {
        case .protectedDataUnavailable, .archiveUnavailable, .bluetoothPermissionNotDetermined, .bluetoothDenied,
            .bluetoothRestricted, .bluetoothUnsupported, .bluetoothOff, .neverConfigured, .noPendantFound,
            .pairingPending, .busyElsewhere, .notReady:
            true
        case .checking, .outOfReach, .staleTelemetry, .transferIncomplete, .noReply, .storageWriteFailed,
            .phoneStorageLow, .pendantStorageLow, .recordingStopped, .recordingControlFailed:
            false
        }
    }

    private static func lastContact(_ date: Date?) -> String {
        guard let date else { return "No contact since lifelog started." }
        return "Last contact \(date.formatted(date: .abbreviated, time: .shortened))."
    }
}
