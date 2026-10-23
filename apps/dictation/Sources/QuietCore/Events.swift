import Foundation

/// The socket protocol this helper speaks; the server refuses another (`?protocol=` on the socket's URL).
public let macProtocol = 2

/// A raw fact the helper reports: which processes have the microphone on, whenever that set changes, or that the
/// Mac is going to sleep. The server turns them into quiet ranges (apps/voice/src/dictation.ts); the helper decides
/// nothing about them. `seq` orders them: the server applies only a seq greater than the last it applied.
public struct MacEvent: Codable, Equatable, Sendable {
    public var seq: Int
    public var at: Date
    /// The processes capturing (bundle ids, or names for tools without one), sorted; nil for a sleep.
    public var capturing: [String]?

    /// The socket frame: `{"type":"mic","seq":…,"at":…,"capturing":[…]}` or `{"type":"sleep","seq":…,"at":…}`.
    public func frame(using encoder: JSONEncoder) -> String? {
        struct Frame: Encodable {
            let type: String
            let seq: Int
            let at: Date
            let capturing: [String]?
        }
        let frame = Frame(type: capturing == nil ? "sleep" : "mic", seq: seq, at: at, capturing: capturing)
        return (try? encoder.encode(frame)).map { String(decoding: $0, as: UTF8.self) }
    }
}

/// The events the server hasn't acked, oldest first, mirrored in a file: a sensor never loses one. An event leaves
/// only when the server says it applied it (`{"type":"ack","seq":…}`). Every new socket, and every ping, sends them
/// all again, in order, before anything else.
public struct Outbox: Codable, Equatable, Sendable {
    public private(set) var events: [MacEvent]
    /// The last seq given: the next is one more, or the time in ms if that is greater.
    public private(set) var lastSeq: Int
    /// A welcome has numbered this file since it began. Until one has, its count may be below what the server
    /// applied (the file was lost): nothing in it was sent yet, so the welcome renumbers it all. From then on its
    /// count stays above the server's, and a seq at or below the server's is one it applied (an ack was lost).
    public private(set) var known: Bool

    public init(_ events: [MacEvent] = [], lastSeq: Int = 0, known: Bool = false) {
        self.events = events
        self.lastSeq = max(lastSeq, events.map(\.seq).max() ?? 0)
        self.known = known
    }

    /// A file written before `known` existed reads as not numbered yet: the next welcome numbers it.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        events = try container.decode([MacEvent].self, forKey: .events)
        lastSeq = try container.decode(Int.self, forKey: .lastSeq)
        known = try container.decodeIfPresent(Bool.self, forKey: .known) ?? false
    }

    /// A new event: its names and its list trimmed to what the server takes (200 of each), so only a bug can make
    /// one it refuses.
    @discardableResult public mutating func add(capturing: [String]?, at: Date) -> MacEvent {
        lastSeq = max(lastSeq + 1, Int(at.timeIntervalSince1970 * 1000))
        let names = capturing.map { Array(Set($0.map { String($0.prefix(200)) }).sorted().prefix(200)) }
        let event = MacEvent(seq: lastSeq, at: at, capturing: names)
        events.append(event)
        return event
    }

    /// The server's welcome said the last seq it applied. A file no welcome has numbered yet (new, or the old one
    /// lost) sent nothing, so every event in it goes above that seq, in order, and so does every later one: a lost
    /// file with a clock behind the server's count is never taken for a resend. A file a welcome has numbered keeps
    /// every seq: one at or below the server's is an event it applied whose ack was lost, which it acks again
    /// without applying (applying it again, out of order, could close a later dictation).
    public mutating func rebase(above applied: Int) {
        if !known {
            var next = applied
            for index in events.indices {
                next = max(next + 1, events[index].seq)
                events[index].seq = next
            }
            lastSeq = max(lastSeq, next)
            known = true
        }
        lastSeq = max(lastSeq, applied)
    }

    /// The server closed the socket over an event, saying why. `invalid event`: the oldest goes (returned, for the
    /// log), so the next can apply, and a fresh `mic` with what captures `now` follows it, so the server's quiet
    /// range of unknown source over the lost span ends at the reconnect. `seq behind`: the server applied more than
    /// this file knows (its database replaced, or the clock went back while acks were lost), so the next welcome
    /// renumbers what remains. Anything else: it goes again as it is.
    public mutating func refused(reason: String, capturing: [String], at now: Date) -> MacEvent? {
        switch reason {
        case "invalid event":
            guard !events.isEmpty else { return nil }
            let dropped = events.removeFirst()
            add(capturing: capturing, at: now)
            return dropped
        case "seq behind":
            known = false
            return nil
        default: return nil
        }
    }

    /// The last seq the server applied, from its `{"type":"welcome","lastSeq":…}`; nil for any other message.
    public static func welcome(message: String) -> Int? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
            object["type"] as? String == "welcome"
        else { return nil }
        return object["lastSeq"] as? Int
    }

    /// Every unacked event as a frame, for a socket that just opened or pinged.
    public func frames(using encoder: JSONEncoder) -> [String] { events.compactMap { $0.frame(using: encoder) } }

    /// Forgets the events an `ack` message covers (its seq and before: they apply in order); `false` for any other
    /// message.
    @discardableResult public mutating func ack(message: String) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
            object["type"] as? String == "ack", let seq = object["seq"] as? Int
        else { return false }
        events.removeAll { $0.seq <= seq }
        return true
    }

    /// The outbox file: this one's, or protocol 1's list of ranges not yet acked, sent as the events that make the
    /// same ranges (the dictation app on 1 s after the range's start, off 1.5 s before its end), so the cutover
    /// loses none.
    public static func read(_ data: Data, using decoder: JSONDecoder) throws -> Self {
        if let outbox = try? decoder.decode(Self.self, from: data) { return outbox }
        struct Range: Decodable {
            let startedAt: Date
            let endedAt: Date
            let source: String
        }
        var outbox = Self()
        for range in try decoder.decode([Range].self, from: data) {
            outbox.add(capturing: [range.source], at: range.startedAt.addingTimeInterval(1))
            outbox.add(capturing: [], at: range.endedAt.addingTimeInterval(-1.5))
        }
        return outbox
    }
}

/// The helper's first word on each socket, after its outbox: the engines it can run, and the calls it still runs
/// (from before this socket), which hold the server's slots until they answer. It means the Mac is awake.
public func helloMessage(running: [String]) -> String {
    let object: [String: Any] = [
        "type": "hello", "engines": LLMEngine.allCases.map(\.rawValue), "running": running.sorted(),
    ]
    let data = (try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys)) ?? Data()
    return String(decoding: data, as: UTF8.self)
}

/// How long to wait before opening the socket again: `first`, doubling after each failure up to `limit`. An open
/// socket resets it, so a socket the network or the proxy drops comes back at once.
public struct Backoff: Sendable {
    public var first: TimeInterval = 1
    public var limit: TimeInterval = 60
    private var failures = 0

    public init() {}

    public mutating func next() -> TimeInterval {
        defer { failures = min(failures + 1, 32) }
        return min(limit, first * pow(2, Double(failures)))
    }

    public mutating func reset() { failures = 0 }
}
