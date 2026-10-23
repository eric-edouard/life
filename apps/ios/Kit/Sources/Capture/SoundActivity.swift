import Foundation
import PendantProtocol

/// Whether the Pendant's sound detector is storing audio, from the Pendant's own evidence only, never the phone's.
/// In `CaptureStatus` it is an `Observed` value whose `at` is when the evidence last held (docs/voice/pendant.md,
/// "Sound activity").
public enum SoundActivity: Sendable, Equatable {
    /// The detector fired at `since` and audio is being stored.
    case hearing(since: Date)
    /// Nothing stored since `since`. While recording is on the microphones keep listening.
    case quiet(since: Date)

    /// While the Pendant screen watches, pages arrive every 1.5 s during sound and a status every 5 s
    /// (`DrainCoordinator.liveRefresh`), so evidence older than three of those is no longer "now".
    public static let freshFor: TimeInterval = 15
}

extension Observed where Value == SoundActivity {
    /// Still says what the Pendant is doing now, rather than what it last did.
    public func isFresh(now: Date) -> Bool { now.timeIntervalSince(at) <= SoundActivity.freshFor }
}

/// Derives `SoundActivity` from what arrives: storage-session markers and audio in pages, and the newest page index
/// moving between status replies. Observe mode re-sends every page on each download, so a page event older than
/// `liveWindow` by the Pendant's clock is history and never counts.
struct SoundEvidence {
    /// The Pendant's clock is set on every cycle, so a live event is within seconds of the phone's clock.
    static let liveWindow: TimeInterval = 30
    /// While it stores audio the Pendant opens a page about every 1.5 s (verified rate), so a reply this long after the
    /// last with no new page means nothing was stored in between. ponytail: tune on hardware with the live tail.
    static let pageFill: TimeInterval = 4
    /// Replies further apart than this (a reconnect, the screen away) say nothing about now.
    static let replyGap: TimeInterval = 20

    private(set) var activity: Observed<SoundActivity>?
    private var newestEvent: Date?
    /// The newest page whose content arrived, live or replayed.
    private var newestPageSeen: UInt64?
    private var lastReply: (newest: Int64, session: UInt64, at: Date)?

    mutating func observe(_ page: FlashPage, index: UInt64, now: Date) {
        newestPageSeen = max(newestPageSeen ?? index, index)
        guard let opened = page.timestampMillis, opened > FlashPage.earliestPlausibleMillis else { return }
        for chunk in page.chunks {
            let millis = Double(opened) + Double(max(chunk.timeOffsetMillis ?? 0, 0))
            let at = Date(timeIntervalSince1970: millis / 1000)
            guard abs(now.timeIntervalSince(at)) <= Self.liveWindow, newestEvent.map({ at >= $0 }) ?? true else {
                continue
            }
            // Pre-roll audio comes just before the start marker; the stop marker follows the last packet.
            if chunk.audio?.opusPackets.isEmpty == false || chunk.storage?.didStartSession == true {
                hear(at: min(at, now), startedAt: min(at, now))
                newestEvent = at
            }
            if chunk.storage?.didStopSession == true {
                activity = Observed(.quiet(since: min(at, now)), at: min(at, now))
                newestEvent = at
            }
        }
    }

    mutating func observe(_ storage: StorageState, now: Date) {
        guard let last = lastReply else {
            lastReply = (storage.newestPage, storage.session, now)
            return
        }
        let elapsed = now.timeIntervalSince(last.at)
        // Too soon after the last to tell: keep the older reply as the baseline.
        guard elapsed >= Self.pageFill else { return }
        lastReply = (storage.newestPage, storage.session, now)
        guard elapsed <= Self.replyGap else { return }
        let opened = storage.newestPage - last.newest
        if opened < 0 {
            // A new flash life: indices restarted.
            newestPageSeen = nil
        } else if opened == 0 {
            let since: Date =
                switch activity?.value {
                case .quiet(let since)?: since
                case .hearing?: activity?.at ?? last.at
                case nil: last.at
                }
            activity = Observed(.quiet(since: since), at: now)
            // A page from before this reply, arriving late, must not say "hearing" again.
            newestEvent = now
        } else if let seen = newestPageSeen, Int64(clamping: seen) >= storage.newestPage - 1 {
            // `newestPage` is the page being written; the content of every sealed one already spoke.
        } else if opened >= 2 || storage.session != last.session {
            // Pages fill this fast only with audio, and a recording start seals the quiet page and opens a session.
            hear(at: now, startedAt: last.at)
        }
        // Otherwise one page in the same session: a quiet page filling up looks the same, so the last word stands.
    }

    private mutating func hear(at: Date, startedAt: Date) {
        let since: Date =
            if case .hearing(let since)? = activity?.value, let previous = activity?.at,
                at.timeIntervalSince(previous) <= Self.liveWindow
            {
                since
            } else {
                startedAt
            }
        activity = Observed(.hearing(since: since), at: at)
    }
}
