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
        public let title: String?
        public let question: String?
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

/// One page of `read_thread`: only its asks matter here (the entries are `LifeThread`'s).
public struct ThreadRead: Decodable, Sendable, Equatable, ParsedRead, NamesParties, VersionedRead {
    public let asks: [ThreadAsk]
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
        while !items.isAtEnd {
            let item = try items.superDecoder()
            if (try? Kind(from: item))?.kind == "ask", let ask = try? ThreadAsk(from: item) { asks.append(ask) }
        }
        self.asks = asks
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
    private enum Key: String, CodingKey { case ref, options, note, person, name, undo }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        self.init(
            ref: try c.decode(String.self, forKey: .ref), options: try c.decode([String].self, forKey: .options),
            note: try c.decodeIfPresent(String.self, forKey: .note),
            person: try c.decodeIfPresent(String.self, forKey: .person),
            name: try c.decodeIfPresent(String.self, forKey: .name),
            undo: try c.decodeIfPresent(Bool.self, forKey: .undo))
    }
}
