import Foundation
import Timeline

/// The feed's rows as screens read them (contract "The feed"). Each decodes the row the server sent, kept in
/// `library.sqlite` (`LibraryCache.swift`); nothing here is computed on the phone.
public struct CachedConversation: Sendable, Equatable, Decodable, Identifiable {
    /// Why its words or summary wait (`waiting.reason`).
    public struct Waiting: Sendable, Equatable, Decodable {
        public var reason: WaitingReason
        public var since: Date?
    }

    public struct Retired: Sendable, Equatable, Decodable {
        public var successorId: UUID?
    }

    /// A boundary the summary run was unsure of: the owner splits there or dismisses it.
    public struct SplitSuggestion: Sendable, Equatable, Decodable {
        public var at: Date

        public init(at: Date) {
            self.at = at
        }
    }

    public var id: UUID
    public var startAt: Date
    public var endAt: Date
    public var kind: ConversationKind
    /// Where its words and summary stand; `nil` from a row cached before the feed sent it.
    public var state: ConversationState?
    /// The summary run its title, summary and chapters come from: what Generate says the owner saw.
    public var runId: UUID?
    public var title: String?
    public var ownerTitle: String?
    public var tldr: String?
    public var place: String?
    public var waiting: Waiting?
    public var retired: Retired?
    /// Medium-confidence boundaries, dismissed ones left out (contract "Split suggestions").
    public var splitSuggestions: [SplitSuggestion]?
    /// The grouping edits that made its start and its end, when an edit did (a split, or a merge it holds).
    public var startEdit: UUID?
    public var endEdit: UUID?

    public init(
        id: UUID, startAt: Date, endAt: Date, kind: ConversationKind = .conversation, state: ConversationState? = nil,
        runId: UUID? = nil,
        title: String? = nil, ownerTitle: String? = nil, tldr: String? = nil, place: String? = nil,
        waiting: Waiting? = nil, splitSuggestions: [SplitSuggestion]? = nil, startEdit: UUID? = nil,
        endEdit: UUID? = nil
    ) {
        self.id = id
        self.startAt = startAt
        self.endAt = endAt
        self.kind = kind
        self.state = state
        self.runId = runId
        self.title = title
        self.ownerTitle = ownerTitle
        self.tldr = tldr
        self.place = place
        self.waiting = waiting
        self.splitSuggestions = splitSuggestions
        self.startEdit = startEdit
        self.endEdit = endEdit
    }

    public var range: Range<CaptureInstant> {
        CaptureInstant(startAt)..<max(CaptureInstant(startAt), CaptureInstant(endAt))
    }
    /// A recording from the old app: its edges are fixed, so it is never split or merged.
    public var isImported: Bool { kind == .imported }
    /// The owner's title always wins over a generated one.
    public var shownTitle: String? { ownerTitle ?? title }
}

public enum ConversationKind: String, Sendable, UnknownTolerant {
    case conversation, dictation, silent, imported
    case unknown
}

/// Why a conversation's words or summary wait (`waiting.reason`).
public enum WaitingReason: String, Sendable, UnknownTolerant {
    /// The Mac is away: summaries, or audio past its dictation watermark.
    case macAway
    case creditsOut, transcriptionOff
    /// Heard-through stalled while the Pendant records.
    case phoneQuiet
    case unknown
}

/// One turn of words, in capture time (contract `turns[]`). Already without dictation and media.
public struct CachedTurn: Sendable, Equatable, Decodable {
    public struct Speaker: Sendable, Equatable, Decodable {
        public var label: String?
        public var personId: UUID?
        public var personName: String?
        public var isOwner: Bool?
        /// The name every screen, export and summary shows for this voice, the server's ("Dave", "Marie-Jo",
        /// "Speaker 2").
        public var displayName: String

        public init(
            label: String?, displayName: String, personId: UUID? = nil, personName: String? = nil,
            isOwner: Bool? = nil
        ) {
            self.label = label
            self.personId = personId
            self.personName = personName
            self.isOwner = isOwner
            self.displayName = displayName
        }
    }

    public var jobId: UUID
    public var turnIndex: Int
    public var startAt: Date
    public var endAt: Date
    public var text: String
    public var language: String?
    public var speaker: Speaker
    /// When each word is said (`spoken(at:in:)`); `nil` from a row cached before the feed sent them.
    public var words: [[Int64]]?

    public init(
        jobId: UUID, turnIndex: Int, startAt: Date, endAt: Date, text: String, language: String? = nil,
        speaker: Speaker, words: [[Int64]]? = nil
    ) {
        self.jobId = jobId
        self.turnIndex = turnIndex
        self.startAt = startAt
        self.endAt = endAt
        self.text = text
        self.language = language
        self.speaker = speaker
        self.words = words
    }

    public var start: CaptureInstant { CaptureInstant(startAt) }
    public var range: Range<CaptureInstant> { start..<max(start, CaptureInstant(endAt)) }
}

extension [[Int64]] {
    /// Of a passage's timed words (contract `TimedWords`: each `[start, end, length]`, in milliseconds from the
    /// passage's start and UTF-16 units of its text with the spacing before it), the one spoken `millis` in, the last
    /// begun, as its range in `text` without that spacing; `nil` before the first, or when the words don't fit the text.
    public func spoken(at millis: Int64, in text: String) -> NSRange? {
        guard let index = lastIndex(where: { $0.first ?? .max <= millis }), self[index].count == 3 else { return nil }
        let from = Int(self[..<index].reduce(0) { $0 + ($1.last ?? 0) })
        let length = Int(self[index][2])
        guard from + length <= text.utf16.count else { return nil }
        let spacing = text.utf16.dropFirst(from).prefix(length)
            .prefix { Unicode.Scalar($0)?.properties.isWhitespace == true }.count
        return NSRange(location: from + spacing, length: length - spacing)
    }
}

public struct CachedChapter: Sendable, Equatable, Decodable, Identifiable {
    public var id: UUID
    public var startAt: Date
    public var endAt: Date
    public var title: String?
    public var summary: String?

    public init(id: UUID, startAt: Date, endAt: Date, title: String?, summary: String? = nil) {
        self.id = id
        self.startAt = startAt
        self.endAt = endAt
        self.title = title
        self.summary = summary
    }

    public var start: CaptureInstant { CaptureInstant(startAt) }
}

public struct CachedPerson: Sendable, Equatable, Decodable, Identifiable {
    public var id: UUID
    public var name: String
    public var isOwner: Bool
    public var aliases: [String]?

    public init(id: UUID, name: String, isOwner: Bool = false, aliases: [String]? = nil) {
        self.id = id
        self.name = name
        self.isOwner = isOwner
        self.aliases = aliases
    }
}

/// A grouping edit as the server keeps it (`owner_edits`): the owner's, or the summary run's (`source` `ai`).
public struct CachedEdit: Sendable, Equatable, Decodable, Identifiable {
    public enum Kind: String, Sendable, UnknownTolerant {
        case split, merge, undo, dismissSplit, unknown
    }

    public enum Source: String, Sendable, UnknownTolerant {
        case owner, ai, unknown
    }

    public var id: UUID
    public var kind: Kind
    /// A split's instant.
    public var at: Date?
    /// A merge's stretch.
    public var from: Date?
    public var to: Date?
    public var source: Source
    public var undoneAt: Date?

    public init(
        id: UUID, kind: Kind, at: Date? = nil, from: Date? = nil, to: Date? = nil, source: Source,
        undoneAt: Date? = nil
    ) {
        self.id = id
        self.kind = kind
        self.at = at
        self.from = from
        self.to = to
        self.source = source
        self.undoneAt = undoneAt
    }
}

/// What the library list shows of a conversation beyond its row, read with it (`LibraryStore.facts`).
public struct ConversationFacts: Sendable, Equatable {
    /// Named people who spoke, in order of first words.
    public var people: [String]
    /// The first words said, up to 200 characters.
    public var opening: String?
    public var hasWords: Bool

    public init(people: [String] = [], opening: String? = nil, hasWords: Bool = false) {
        self.people = people
        self.opening = opening
        self.hasWords = hasWords
    }
}

/// Where a conversation stands (contract "App states"): the feed's `state`, or "Not uploaded yet" while audio of it on
/// this phone isn't in a fragment the server has. Nothing else is decided here.
public enum ConversationState: String, Sendable, UnknownTolerant {
    /// Audio on this phone the server doesn't have yet; it plays from here.
    case notUploaded
    case uploaded
    case transcribing
    case transcribed
    case summarized
    /// Transcription gave up on its audio (the server's job `failed` after its retries).
    case failed

    /// A state this app doesn't know reads as transcribed.
    public static var unknown: Self { .transcribed }

    /// `unsent`: audio of it is still only on this phone (`Uploader.unsent`). A row cached before the feed sent a
    /// state reads as transcribed.
    public init(_ conversation: CachedConversation, unsent: Bool) {
        self = unsent ? .notUploaded : conversation.state ?? .transcribed
    }
}

extension ConversationState {
    /// The Library's "Not uploaded yet" rows: one per stretch between the server's conversations that holds audio not
    /// uploaded yet, from its first such second to its last, cut at local midnight so a row stays in its day.
    public static func notUploaded(
        _ unsent: [Range<CaptureInstant>], between conversations: [Range<CaptureInstant>], calendar: Calendar = .current
    ) -> [Range<CaptureInstant>] {
        let covered = conversations.unioned()
        var rows: [Range<CaptureInstant>] = []
        for piece in unsent.unioned().subtracting(covered) {
            if let last = rows.last,
                !covered.contains(where: { $0.lowerBound >= last.upperBound && $0.lowerBound < piece.lowerBound })
            {
                rows[rows.count - 1] = last.lowerBound..<piece.upperBound
            } else {
                rows.append(piece)
            }
        }
        return rows.flatMap { row in
            var days: [Range<CaptureInstant>] = []
            var start = row.lowerBound
            while let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: start.date))
                .map(CaptureInstant.init), midnight < row.upperBound
            {
                days.append(start..<midnight)
                start = midnight
            }
            return days + [start..<row.upperBound]
        }
    }
}
