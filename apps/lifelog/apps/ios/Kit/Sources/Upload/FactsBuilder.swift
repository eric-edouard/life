import Capture
import Foundation
import Timeline

/// What the server's grouping reads of the phone's timeline: the body of `PUT /sources/{sourceId}/timeline`.
public struct TimelineFacts: Sendable, Encodable, Equatable {
    /// One continuous stretch of capture, keyed by its first page. Intervals are capture time.
    public struct Span: Sendable, Encodable, Equatable {
        public struct Break: Sendable, Encodable, Equatable {
            public var at: Date
            /// `BreakReason`: why this span doesn't continue the one before.
            public var kind: String
        }

        public struct Pause: Sendable, Encodable, Equatable {
            public var at: Date
        }

        public var firstPage: UInt64
        public var startAt: Date
        public var endAt: Date
        public var speech: [[Date]]
        public var audible: [[Date]]
        public var unanalyzed: [[Date]]
        public var breaks: [Break]
        public var pauses: [Pause]
    }

    public var heardThrough: Date
    /// Every kept second before it is in a fragment the server holds (`Uploader`); the server closes blocks on it.
    public var sentThrough: Date?
    public var spans: [Span]
}

/// Builds timeline facts from the spans and labels `TimelineScanner.scan()` keeps, by the rules the server groups by: speech
/// is `ActivityWindow.speech()`, audible is `audible`, unanalyzed audio is `unanalyzed(_:)`.
public enum FactsBuilder {
    /// The facts of `spans` (in order, as `TimelineSnapshot.spans` gives them). A pause goes with the first span
    /// ending after it, so one in the quiet before a span travels with that span; `after` is where the audio before
    /// the first span ends (`nil`: none before it). Pauses after the last span wait for the span that follows them.
    public static func spans(
        _ spans: [CaptureSpan], windows: [ActivityWindow], pauses: [CaptureInstant], after: CaptureInstant?
    ) -> [TimelineFacts.Span] {
        var previousEnd = after ?? CaptureInstant(millis: .min)
        return spans.map { span in
            let range = span.interval
            let near = windows.filter { $0.interval.overlaps(range) }
            defer { previousEnd = range.upperBound }
            return TimelineFacts.Span(
                firstPage: span.pages.lowerBound, startAt: range.lowerBound.date, endAt: range.upperBound.date,
                speech: dates(near.speech(orUncertain: true), within: range),
                audible: dates(near.audible, within: range),
                unanalyzed: dates(near.unanalyzed([range]), within: range),
                breaks: span.breaks.map(\.rawValue).sorted().map { .init(at: range.lowerBound.date, kind: $0) },
                pauses: pauses.filter { $0 >= previousEnd && $0 < range.upperBound }.map { .init(at: $0.date) })
        }
    }

    /// All audio the Pendant captured before this is on the phone, from its status: a reply whose backlog, read from
    /// that same reply, was only the page being written, less `savedMarginMillis`. `nil` from any other reply.
    public static func savedThrough(_ status: CaptureStatus) -> Date? {
        guard let storage = status.storage, let backlog = status.backlog, backlog.at == storage.at,
            backlog.value.pages <= 1
        else { return nil }
        return storage.at.addingTimeInterval(-Double(savedMarginMillis) / 1000)
    }

    /// The page being written while the Pendant records (1.5 s of audio, 1.64 s at the 99th percentile) and the
    /// clock between the Pendant and the phone (a sealed page reaches the phone 77 ms to 0.5 s after the next one
    /// opens, never before; Oct 15, 44k pages). So speech still going on always reaches heard-through and never
    /// ends a fragment (`SpeechFragment`), and the status the Pendant pushes when its detector stops, 4.5 to 5 s after
    /// the last sound, already passes the last kept second (speech padded 1 s).
    public static let savedMarginMillis: Int64 = 3_000

    /// How far heard-through may run past the newest stored audio. The Pendant stores nothing in silence, so a quiet
    /// stretch still counts as heard, and a fragment or a conversation before it closes; but a phone clock that jumps
    /// forward can't carry heard-through, which never moves back, further than this.
    public static let quietAllowanceMillis: Int64 = 10 * 60_000

    /// The capture time of the durable, analyzed, contiguous prefix: everything the Pendant captured before
    /// `savedThrough` is stored (`savedThrough(_:)`), capped `quietAllowanceMillis` past `newestStored` (the end of the
    /// newest stored page), and the analyzers reached `unanalyzedFrom`. Never moves back from `sent`.
    public static func heardThrough(
        savedThrough: CaptureInstant?, newestStored: CaptureInstant?, unanalyzedFrom: CaptureInstant?,
        sent: CaptureInstant?
    ) -> CaptureInstant? {
        var now: CaptureInstant?
        if let savedThrough, let newestStored {
            now = min(savedThrough, newestStored.advanced(by: quietAllowanceMillis), unanalyzedFrom ?? savedThrough)
        }
        guard let sent else { return now }
        return max(sent, now ?? sent)
    }

    private static func dates(_ ranges: [Range<CaptureInstant>], within range: Range<CaptureInstant>) -> [[Date]] {
        [range].subtracting([range].subtracting(ranges.unioned())).map { [$0.lowerBound.date, $0.upperBound.date] }
    }
}
