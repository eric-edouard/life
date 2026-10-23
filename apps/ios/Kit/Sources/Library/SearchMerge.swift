import Foundation
import Timeline

/// A passage the server found by meaning, in this library's conversation.
public struct MeaningHit: Sendable, Equatable {
    public var conversation: UUID
    /// Capture range of its turns; `nil` when the server has no time map for it yet.
    public var passage: Range<CaptureInstant>?
    public var text: String

    public init(conversation: UUID, passage: Range<CaptureInstant>?, text: String) {
        self.conversation = conversation
        self.passage = passage
        self.text = text
    }
}

/// One search result: a conversation, where it opens and why it matched.
public struct SearchMatch: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        /// The on-device index found the words.
        case words
        /// Only the server's meaning search found it.
        case meaning
    }

    public var conversation: UUID
    /// Start of the matching passage; `nil` opens at the top (it matched a title, a person...).
    public var passage: CaptureInstant?
    public var snippet: String
    public var source: Source

    public init(conversation: UUID, passage: CaptureInstant?, snippet: String, source: Source) {
        self.conversation = conversation
        self.passage = passage
        self.snippet = snippet
        self.source = source
    }
}

public enum SearchMerge {
    /// Word matches first, in the index's order, then meaning hits (best first) for the conversations words didn't
    /// find, one row per conversation. The same passage is never listed twice: a meaning hit in a conversation words
    /// already found is that row's passage when words found no passage of their own, and is dropped otherwise.
    public static func merge(words: [SearchMatch], meaning: [MeaningHit]) -> [SearchMatch] {
        var best: [UUID: MeaningHit] = [:]
        var order: [UUID] = []
        for hit in meaning where best[hit.conversation] == nil {
            best[hit.conversation] = hit
            order.append(hit.conversation)
        }
        var merged = words.map { match in
            guard match.passage == nil, let hit = best[match.conversation] else { return match }
            var match = match
            match.passage = hit.passage?.lowerBound
            return match
        }
        let found = Set(words.map(\.conversation))
        for id in order where !found.contains(id) {
            guard let hit = best[id] else { continue }
            merged.append(
                SearchMatch(conversation: id, passage: hit.passage?.lowerBound, snippet: hit.text, source: .meaning))
        }
        return merged
    }
}
