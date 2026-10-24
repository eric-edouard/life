/// Layout of prepared (uploaded) audio: kept capture intervals played back to back, with a short separator between
/// them so words from different spans are never spliced together. Maps prepared time to capture time and back. The server
/// reads it the same way (`captureMillis`); both read the cases in `fixtures/time-map.json`.
public struct TimeMap: Sendable, Equatable {
    /// Sent with each part when it is registered (`separatorMs`), so the server maps turns the same way.
    public static let separatorMillis: Int64 = 400

    /// Kept capture intervals in prepared order: sorted, disjoint, never empty.
    public let segments: [Range<CaptureInstant>]
    /// Where each segment starts in the prepared audio, in milliseconds.
    public let preparedStarts: [Int64]

    /// `nil` when there is nothing to upload.
    public init?(segments: [Range<CaptureInstant>]) {
        let segments = segments.unioned()
        guard !segments.isEmpty else { return nil }
        var cursor: Int64 = 0
        preparedStarts = segments.map { segment in
            defer { cursor += segment.millis + Self.separatorMillis }
            return cursor
        }
        self.segments = segments
    }

    /// Total length of the prepared audio, in milliseconds.
    public var preparedMillis: Int64 { preparedEnd(segments.count - 1) }

    /// Prepared position of a captured instant; `nil` when that moment was cut out.
    public func preparedMillis(at instant: CaptureInstant) -> Int64? {
        guard let index = segments.firstIndex(where: { $0.contains(instant) }) else { return nil }
        return preparedStarts[index] + segments[index].lowerBound.distance(to: instant)
    }

    /// Capture instant of a prepared position; `nil` inside a separator. Exact inverse of `preparedMillis(at:)`.
    public func capture(atPreparedMillis position: Int64) -> CaptureInstant? {
        guard
            let index = segments.indices.first(where: { preparedStarts[$0] <= position && position < preparedEnd($0) })
        else { return nil }
        return segments[index].lowerBound.advanced(by: position - preparedStarts[index])
    }

    private func preparedEnd(_ index: Int) -> Int64 { preparedStarts[index] + segments[index].millis }
}
