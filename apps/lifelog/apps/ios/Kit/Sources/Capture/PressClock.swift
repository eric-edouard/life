import PendantProtocol
import Timeline

/// The one clock reading the Pendant gives: a live short press carries its RTC time
/// (`button_event_absolute_timestamp_ms`) and the phone receives it a moment later. Status replies carry no time.
///
/// A reading is kept only when it can be trusted: a short press (a hold adds its ~2 s duration), proven fresh by
/// the since-boot press counter rising within this connection (a status replayed at connect may carry an old press),
/// with a plausible RTC value, an offset of at least a second (below that it is press and Bluetooth latency, not
/// drift) and at most 7 days (Omi's bound; beyond it the RTC was never set).
///
/// It measures the clock's error since the last set, so it closes that epoch at the next set. Drift that grows while
/// the Pendant is disconnected is still unmeasured: every connection sets the clock first, before any press.
enum PressClock {
    static let floorMillis: Int64 = 1_000
    static let ceilingMillis: Int64 = 7 * 24 * 3_600_000
    /// A press stamped this close to its receipt was just made. ponytail: generous for Bluetooth latency and the
    /// drift since the last set; tune if a real press ever misses it.
    static let liveMillis: Int64 = 10_000

    /// A press made just now, not one replayed at connect: the since-boot counter rose on this connection, or its RTC
    /// time is within `liveMillis` of receipt (every connection sets the clock before anything else).
    static func isLive(_ press: ButtonStatus, previousPresses: UInt64?, receivedAtMillis: Int64) -> Bool {
        if let previousPresses, press.shortPressesSinceBoot > previousPresses { return true }
        guard let stamp = press.eventTimestampMillis.flatMap({ Int64(exactly: $0) }) else { return false }
        return abs(stamp - receivedAtMillis) <= liveMillis
    }

    /// When the press was made, in Unix milliseconds: the Pendant's own time when it is within the minute before
    /// receipt (every cycle sets the clock), else receipt. A press can reach the phone seconds late, with the pages
    /// held back alongside it (Oct 15: 11 s, while the app was suspended), and its window must still end at the press.
    static func pressedAt(_ press: ButtonStatus, receivedAtMillis: Int64) -> Int64 {
        guard let stamp = press.eventTimestampMillis.flatMap({ Int64(exactly: $0) }),
            (receivedAtMillis - 60_000...receivedAtMillis + liveMillis).contains(stamp)
        else { return receivedAtMillis }
        return min(stamp, receivedAtMillis)
    }

    /// RTC minus phone time, or `nil` when the press can't be trusted as a clock reading.
    static func offset(_ press: ButtonStatus, previousPresses: UInt64?, receivedAtMillis: Int64) -> Int64? {
        guard press.event == .short, let previousPresses, press.shortPressesSinceBoot > previousPresses,
            let stamp = press.eventTimestampMillis.flatMap({ Int64(exactly: $0) }),
            stamp > ClockModel.earliestPlausibleMillis
        else { return nil }
        let offset = stamp - receivedAtMillis
        return (floorMillis...ceilingMillis).contains(abs(offset)) ? offset : nil
    }
}
