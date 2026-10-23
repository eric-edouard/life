import Foundation
import Timeline

/// A photo or screenshot in the owner's library, taken during a conversation. Only its id is kept: the image is read
/// from PhotoKit when shown and never copied, saved or uploaded.
public struct TranscriptPhoto: Sendable, Identifiable, Hashable {
    /// The PhotoKit local identifier.
    public let id: String
    public let taken: CaptureInstant
    public let isScreenshot: Bool

    public init(id: String, taken: CaptureInstant, isScreenshot: Bool) {
        self.id = id
        self.taken = taken
        self.isScreenshot = isScreenshot
    }
}

/// A run of the transcript as the page shows it: one turn, the photos taken during the turn before it, a chapter's
/// title before the turn it starts at, or "Split here?" before the turn a suggested boundary falls on.
public enum TranscriptBlock: Sendable, Identifiable {
    case passage(CachedTurn)
    case photos([TranscriptPhoto])
    case chapter(CachedChapter, line: CaptureInstant)
    /// The suggestion's own instant, before the turn starting at `line`.
    case splitSuggestion(at: Date, line: CaptureInstant)

    /// ponytail: a photo strip is keyed by its first photo's instant, a chapter title by its turn's start less one
    /// millisecond and a suggestion by it less two; any could only clash with a turn starting at that very millisecond.
    public var id: CaptureInstant {
        switch self {
        case .passage(let turn): turn.start
        case .photos(let photos): photos[0].taken
        case .chapter(_, let line): line.advanced(by: -1)
        case .splitSuggestion(_, let line): line.advanced(by: -2)
        }
    }

    /// `photos` go after the turn they were taken in (`turns(of:at:)`); each chapter's title before the first turn
    /// starting at or after its start, once there are two chapters or more; each split suggestion before the first turn
    /// starting at or after it, never the first turn.
    public static func fold(
        _ turns: [CachedTurn], photos: [CaptureInstant: [TranscriptPhoto]] = [:], chapters: [CachedChapter] = [],
        splits: [Date] = []
    ) -> [TranscriptBlock] {
        var headings: [CaptureInstant: CachedChapter] = [:]
        for chapter in chapters.count > 1 ? chapters : [] {
            let from = chapter.start.advanced(by: -markerToleranceMillis)
            if let turn = turns.first(where: { $0.start >= from }),
                headings[turn.start] == nil
            {
                headings[turn.start] = chapter
            }
        }
        var suggestions: [CaptureInstant: Date] = [:]
        for at in splits {
            if let turn = turns.first(where: { $0.start >= CaptureInstant(at) }), turn.start != turns.first?.start {
                suggestions[turn.start] = suggestions[turn.start] ?? at
            }
        }
        var blocks: [TranscriptBlock] = []
        for turn in turns {
            if let at = suggestions[turn.start] { blocks.append(.splitSuggestion(at: at, line: turn.start)) }
            if let heading = headings[turn.start] { blocks.append(.chapter(heading, line: turn.start)) }
            blocks.append(.passage(turn))
            if let taken = photos[turn.start] { blocks.append(.photos(taken)) }
        }
        return blocks
    }

    /// A chapter may start up to this much before its first turn.
    static let markerToleranceMillis: Int64 = 1_000
}

extension [CachedTurn] {
    /// A turn stays the one being spoken this long after it ends, so a short pause doesn't drop the highlight.
    public static let pauseHoldMillis: Int64 = 1_500

    /// The turn being spoken at `instant`: the last started at or before it, while `instant` is inside it or within
    /// `pauseHoldMillis` after it. `nil` in longer silences and before the first turn. A binary search.
    public func line(at instant: CaptureInstant) -> Int? {
        guard let index = lastStarted(at: instant) else { return nil }
        return instant < self[index].range.upperBound.advanced(by: Self.pauseHoldMillis) ? index : nil
    }

    /// The last turn started at or before `instant`, however long ago; `nil` before the first. A binary search.
    public func lastStarted(at instant: CaptureInstant) -> Int? {
        var low = 0
        var high = count
        while low < high {
            let middle = (low + high) / 2
            if self[middle].start <= instant { low = middle + 1 } else { high = middle }
        }
        return low > 0 ? low - 1 : nil
    }

    /// Things that happened during the conversation (photos taken, in time order), grouped under the turn they
    /// belong to, keyed by its start: the last turn started at or before the first of a group, or the first turn for
    /// anything before it. A burst (each within a minute of the one before) stays one group under its first turn.
    public func turns<Item>(of items: [Item], at instant: (Item) -> CaptureInstant) -> [CaptureInstant: [Item]] {
        guard !isEmpty else { return [:] }
        var groups: [CaptureInstant: [Item]] = [:]
        var turn = self[0].start
        var previous: CaptureInstant?
        for item in items {
            let at = instant(item)
            if previous.map({ $0.distance(to: at) > 60_000 }) ?? true {
                turn = self[lastStarted(at: at) ?? 0].start
            }
            groups[turn, default: []].append(item)
            previous = at
        }
        return groups
    }
}
