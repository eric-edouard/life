import Foundation
import Library

// The thread's asks as `read_thread` gives them (`host/life-thread.ts`). Life works out each one's state; the phone
// stores none and adds only `queued`, the answer it holds for when Life is back.

/// An ask in the thread: an open card, or one closed (answered, sent, withdrawn) that his Undo may still reach.
public struct ThreadAsk: Decodable, Sendable, Equatable, Identifiable {
    public enum State: String, UnknownTolerant, Sendable {
        case needsYou = "needs_you"
        case later
        case underWay = "under_way"
        case waitingOnSomeone = "waiting_on_someone"
        case settled
        case outdated
        case unknown
    }

    /// A closed card: what it was, and what his Undo does.
    public struct Closed: Decodable, Sendable, Equatable {
        public struct Undo: Decodable, Sendable, Equatable {
            /// What the other side will see when it deletes a sent message, else nil.
            public let line: String?
        }
        public struct Withdrawn: Decodable, Sendable, Equatable {
            public let why: String?
            public let replacedBy: String?
        }
        /// That it was sent, and when.
        public struct Sent: Decodable, Sendable, Equatable {
            public let at: Date?
        }
        /// His answer: what he picked, his words and when.
        public struct Answer: Decodable, Sendable, Equatable {
            public let at: Date?
            public let note: String?
            public let options: [String]
        }
        /// "How am I doing?" on a closed card: his mark so far (nil: none yet). Absent when Life did not ask.
        public struct Rate: Decodable, Sendable, Equatable {
            public let mark: RatingMark?
        }
        public let title: String?
        public let ask: String?
        public let question: String?
        public let answer: Answer?
        public let rate: Rate?
        public let sent: Sent?
        public let undo: Undo?
        public let withdrawn: Withdrawn?
    }

    public let ref: String
    public let at: Date?
    public let state: State
    /// Until when his Later holds it.
    public let later: Date?
    /// The open card, while it can be answered.
    public let check: Check?
    public let closed: Closed?

    public var id: String { ref }

    private enum CodingKeys: String, CodingKey { case ref, at, state, later, card }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = try c.decode(String.self, forKey: .ref)
        at = try? c.decodeIfPresent(Date.self, forKey: .at)
        state = (try? c.decode(State.self, forKey: .state)) ?? .unknown
        later = try? c.decodeIfPresent(Date.self, forKey: .later)
        // An open card is a whole `Check`; a closed one has no `ref` of its own.
        let open = try? c.decodeIfPresent(Check.self, forKey: .card)
        check = open
        closed = open == nil ? try? c.decodeIfPresent(Closed.self, forKey: .card) : nil
    }

    /// The words of the ask: the card's title, open or closed.
    public var title: String { check?.title ?? closed?.title ?? "" }
    public var question: String { check?.question ?? closed?.question ?? "" }
    /// Whether he can answer it now.
    public var isAnswerable: Bool { state == .needsYou && check != nil }
    /// What his Undo does, when it has one.
    public var undoLine: String? { closed?.undo.map { $0.line ?? "" } }
}

/// An entry of the thread as Life keeps it (`read_thread`'s `entry` items): his words and Life's answer, or a late reply of an
/// agent (no words of his; `follows` the entry of his ask it answers). The one source the thread is drawn from.
public struct ThreadWireEntry: Codable, Sendable, Equatable, Identifiable {
    /// A reaction on it: Life's on his words (`by` `life`), his on the answer (`by` `owner`).
    public struct Reaction: Codable, Sendable, Equatable {
        public let by: String
        public let with: String
        public let at: Date?
    }

    /// Work handed on from it: what kind, since when, and how long that kind takes (a median of the last, ms).
    public struct Handed: Codable, Sendable, Equatable {
        /// `HANDED_KINDS` (`desk/desk-turn-reads.ts`).
        public enum Kind: String, UnknownTolerant, Codable, Sendable {
            case booking, lookup, other, redraft, reply, research
            case unknown
        }
        public let kind: Kind
        public let since: Date?
        public let estimateMs: Int?
        /// `under_way` while an agent's turn runs on it, else `settled`.
        public let state: ThreadAsk.State
    }

    /// Life's number for the entry: what a reaction names.
    public let id: Int
    public let at: Date
    public let words: String?
    public let answer: String?
    public let answeredAt: Date?
    public let error: String?
    public let follows: Int?
    public let handed: [Handed]
    public let reactions: [Reaction]
    public let refs: [String]
}

extension ThreadAsk.State: Encodable {
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// One page of `read_thread`: its asks and its entries.
public struct ThreadRead: Decodable, Sendable, Equatable, ParsedRead, NamesParties, VersionedRead {
    public let asks: [ThreadAsk]
    public let entries: [ThreadWireEntry]
    public let earlier: String?
    public let version: String?

    private enum CodingKeys: String, CodingKey { case items, earlier, version }
    private struct Kind: Decodable { let kind: String }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        earlier = try c.decodeIfPresent(String.self, forKey: .earlier)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        var items = try c.nestedUnkeyedContainer(forKey: .items)
        var asks: [ThreadAsk] = []
        var entries: [ThreadWireEntry] = []
        while !items.isAtEnd {
            let item = try items.superDecoder()
            switch (try? Kind(from: item))?.kind {
            case "ask": if let ask = try? ThreadAsk(from: item) { asks.append(ask) }
            case "entry": if let entry = try? ThreadWireEntry(from: item) { entries.append(entry) }
            default: break
            }
        }
        (self.asks, self.entries) = (asks, entries)
    }

    public var parties: [Party] { asks.flatMap { $0.check?.parties ?? [] } }
    public func ask(_ ref: String) -> ThreadAsk? { asks.first { $0.ref == ref } }
    /// How many wait on him: the round button's count.
    public var waiting: Int { asks.filter(\.isAnswerable).count }
}

/// His answers taken while Life was out of reach, kept to go in order when it is back: each with the key of its tap and
/// the Life it was decided for, so none is sent twice or to another Life. Persisted by the store.
public struct QueuedAnswers: Codable, Sendable, Equatable {
    public struct Entry: Codable, Sendable, Equatable {
        public let request: AnswerRequest
        public let key: String
        public let origin: URL
        public let at: Date
    }

    public private(set) var entries: [Entry] = []

    public init() {}

    public func holds(_ ref: String) -> Bool { entries.contains { $0.request.ref == ref } }

    /// One answer per ask: a later one replaces the earlier.
    public mutating func add(_ request: AnswerRequest, key: String, origin: URL, at: Date) {
        entries.removeAll { $0.request.ref == request.ref }
        entries.append(Entry(request: request, key: key, origin: origin, at: at))
    }

    public mutating func remove(_ ref: String) { entries.removeAll { $0.request.ref == ref } }

    /// Forgets every answer: another Life.
    public mutating func clear() { entries = [] }
}

extension AnswerRequest: Decodable {
    private enum Key: String, CodingKey { case ref, options, note, person, name, undo, rate }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        self.init(
            ref: try c.decode(String.self, forKey: .ref), options: try c.decode([String].self, forKey: .options),
            note: try c.decodeIfPresent(String.self, forKey: .note),
            person: try c.decodeIfPresent(String.self, forKey: .person),
            name: try c.decodeIfPresent(String.self, forKey: .name),
            undo: try c.decodeIfPresent(Bool.self, forKey: .undo),
            rate: try c.decodeIfPresent(RatingMark.self, forKey: .rate))
    }
}
