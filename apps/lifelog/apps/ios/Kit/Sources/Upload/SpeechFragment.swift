import Timeline

/// The kept speech of a run of whole Pendant pages: what one `PUT /sources/{id}/speech/{firstPage}` carries. The server
/// joins fragments into blocks and decides when one closes (docs/timeline.md, "Fragments and blocks"); the phone only
/// says where a fragment ends.
public struct SpeechFragment: Sendable, Equatable {
    /// Kept capture intervals in upload order: its map. Empty when the pages through `last` hold nothing worth sending.
    public var segments: [Range<CaptureInstant>]
    /// The pages its audio comes from: inclusive, sorted and disjoint.
    public var pages: [ClosedRange<UInt64>]
    /// The last page it covers: the uploader's cursor moves past it.
    public var last: UInt64
}

extension SpeechFragment {
    /// Shorter kept stretches are left out: they hold no word, and the provider refuses a near-empty file as corrupt.
    public static let minSegmentMillis: Int64 = 500
    /// Speech waiting this long with no pause is cut inside a second the analyzers call non-speech.
    public static let waitingMillis: Int64 = 60_000
    /// A fragment holds at most this much speech: past it, it ends at any page's end.
    public static let forcedMillis: Int64 = 90_000

    /// The fragment that starts with the first of `runs`; `nil` while its speech may still grow.
    ///
    /// `kept` is kept audio (`SpeechPolicy.keptAudio`, quiet ranges left out) and `runs` the placed runs of whole
    /// pages in time order, both as `unheld` leaves them; `speech` is the analyzers' speech
    /// (`ActivityWindow.speech()`). A fragment ends at a page's end, within `forcedMillis` of kept speech:
    /// 1. at the last pause: outside kept audio, with kept audio after it or `heardThrough` past it (the Pendant
    ///    vouches for the quiet). Kept stretches are 3 s or more apart, so seams fall in silence, and speech still
    ///    going on never ends one;
    /// 2. with no pause and `waitingMillis` of speech waiting, inside the latest second the analyzers call non-speech;
    /// 3. with neither, once `forcedMillis` waits.
    public static func next(
        kept: [Range<CaptureInstant>], runs: [PlacedRun], speech: [Range<CaptureInstant>], heardThrough: CaptureInstant?
    ) -> SpeechFragment? {
        var pause: Int?
        var quiet: Int?
        var full: Int?
        var waiting: Int64 = 0
        // Each page's end: its last run.
        for index in runs.indices where index + 1 == runs.count || runs[index + 1].page != runs[index].page {
            let end = runs[index].end
            waiting = kept.reduce(0) { $0 + max(0, $1.lowerBound.distance(to: min($1.upperBound, end))) }
            guard waiting > 0 else { continue }
            if !kept.contains(where: { $0.lowerBound < end && end < $0.upperBound }),
                kept.contains(where: { $0.lowerBound >= end }) || heardThrough.map({ end <= $0 }) == true
            {
                pause = index
            }
            // Strictly inside a non-speech second, never at the edge of speech.
            if !speech.contains(where: { $0.lowerBound <= end && end <= $0.upperBound }) { quiet = index }
            if waiting >= forcedMillis {
                full = index
                break
            }
        }
        guard let cut = pause ?? (waiting >= waitingMillis ? quiet : nil) ?? full else { return nil }
        let end = runs[cut].end
        let segments = kept.filter { $0.lowerBound < end }.map { $0.lowerBound..<min($0.upperBound, end) }
            .filter { $0.millis >= minSegmentMillis }
        return SpeechFragment(
            segments: segments, pages: pages(of: segments, runs: Array(runs[...cut])), last: runs[cut].page)
    }

    /// `kept` and `runs` with every `held` page taken out, its audio too: the server holds it (a job or a fragment), or
    /// it is behind the cursor. A fragment made from what is left never shares a page with what is held, and never
    /// carries a held page's audio, so nothing the server has is bought twice. Kept time left where no free page plays
    /// goes too: a silence under a second between two held pages is inside their span, so it survives their removal
    /// (Oct 15, the old flash session's shredded jobs). So does a stretch under `minSegmentMillis`: what is left waits.
    public static func unheld(
        kept: [Range<CaptureInstant>], runs: [PlacedRun], held: (UInt64) -> Bool
    ) -> (kept: [Range<CaptureInstant>], runs: [PlacedRun]) {
        let taken = runs.filter { held($0.page) }.map { $0.start..<$0.end }.unioned()
        let free = runs.filter { !held($0.page) }
        let left = kept.unioned().subtracting(taken).filter { piece in
            piece.millis >= minSegmentMillis && free.contains { piece.overlaps($0.start..<$0.end) }
        }
        return (left, free)
    }

    /// The pages whose packets play inside `segments`, as inclusive ranges.
    public static func pages(of segments: [Range<CaptureInstant>], runs: [PlacedRun]) -> [ClosedRange<UInt64>] {
        let indices = Set(
            runs.filter { run in segments.contains { $0.overlaps(run.start..<run.end) } }.map(\.page)
        ).sorted()
        var ranges: [ClosedRange<UInt64>] = []
        for index in indices {
            if let last = ranges.last, last.upperBound + 1 == index {
                ranges[ranges.count - 1] = last.lowerBound...index
            } else {
                ranges.append(index...index)
            }
        }
        return ranges
    }
}
