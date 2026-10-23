import Capture
import Foundation

extension CaptureStatus {
    /// How much newer a contact, reply or catch-up must be before the screen's copy moves: well under the shortest
    /// window that reads them (75 s on screen), well over the gap between two notifications in a sync.
    public static let screenStep: TimeInterval = 5

    /// The status as screens show it, next to what they show now (`previous`). The counters and the acknowledged
    /// index, which no screen shows, are left out; contact and reply times move in `screenStep`s; sync keeps only
    /// what `SyncSummary` tells apart. Through a routine sync, and between whole percents of a catch-up, it equals
    /// `previous`, so screens observing it stay asleep.
    public func forScreen(previous: CaptureStatus) -> CaptureStatus {
        var shown = self
        shown.saved = SavedPages()
        shown.droppedMessages = 0
        shown.lastAcknowledgedIndex = nil
        shown.lastContact = Self.stepped(lastContact, previous: previous.lastContact)
        shown.lastReply = Self.stepped(lastReply, previous: previous.lastReply)
        shown.sync = Self.shown(sync, previous: previous.sync)
        return shown
    }

    static func stepped(_ new: Date?, previous: Date?) -> Date? {
        guard let new, let previous, new >= previous, new.timeIntervalSince(previous) < screenStep else { return new }
        return previous
    }

    /// A catch-up's progress in whole percents saved, a failure, and otherwise only whether a sync is under way:
    /// when it last caught up is `CaptureStore.lastCaughtUp`'s to say. A catch-up holds through the ACKs between its
    /// batches, so its progress doesn't flicker to "up to date" and back.
    private static func shown(_ phase: DrainPhase, previous: DrainPhase) -> DrainPhase {
        switch phase {
        case .downloading(let progress) where progress.expected >= SyncSummary.catchUpPages,
            .persisting(let progress) where progress.expected >= SyncSummary.catchUpPages:
            guard let shown = catchUp(previous) else { return phase }
            return shown.expected == progress.expected && percent(shown) == percent(progress) ? previous : phase
        case .failed: return phase
        case .idle, .caughtUp: return .idle
        case .requestingStatus, .downloading, .persisting, .acking, .gapRecorded:
            return catchUp(previous) == nil ? .requestingStatus : previous
        }
    }

    private static func catchUp(_ phase: DrainPhase) -> DrainProgress? {
        switch phase {
        case .downloading(let progress) where progress.expected >= SyncSummary.catchUpPages,
            .persisting(let progress) where progress.expected >= SyncSummary.catchUpPages:
            progress
        default: nil
        }
    }

    private static func percent(_ progress: DrainProgress) -> UInt64 {
        progress.settled * 100 / max(progress.expected, 1)
    }
}
