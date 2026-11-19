import Foundation
import Library

/// One line of what will wake a waiting agent (`wakesOn` of `RegisteredAgent`), in the agent's own order. A kind the app
/// does not know yet (`places`, `calendar`...) decodes as `unknown` and reads "Something new in <its name>".
public enum WakeLine: Decodable, Sendable, Equatable {
    case message(Message)
    case payments(Payments)
    case answer(Answer)
    /// Anything new close to the agent's matter.
    case wideNet
    case unknown(kind: String)

    /// Why a line can never fire, as a code the app words.
    public enum Broken: String, UnknownTolerant, Sendable {
        case unknownPerson = "unknown_person"
        case unknown
    }

    public struct Message: Decodable, Sendable, Equatable {
        public struct Chat: Decodable, Sendable, Equatable {
            /// Nil: no message was seen in this chat yet.
            public let name: String?
            public let app: String?
            public let group: Bool?
        }

        public let person: String?
        public let chat: Chat?
        /// Absent: any app.
        public let apps: [String]?
        public let words: String?
        public let fromHim: Bool?
        /// The line also covers a call (a call has no words and is never his own).
        public let calls: Bool
        public let broken: Broken?
    }

    public struct Payments: Decodable, Sendable, Equatable {
        public let quantity: String?
        public let above: Double?
        public let below: Double?
        public let words: String?
    }

    public struct Answer: Decodable, Sendable, Equatable {
        /// The open ask's question.
        public let card: String
        /// The ask's check ref.
        public let check: String
        public let deadline: Date
    }

    private enum Key: String, CodingKey { case kind }

    public init(from decoder: any Decoder) throws {
        let kind = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .kind)
        switch kind {
        case "message": self = .message(try Message(from: decoder))
        case "payments": self = .payments(try Payments(from: decoder))
        case "answer": self = .answer(try Answer(from: decoder))
        case "wide_net": self = .wideNet
        default: self = .unknown(kind: kind)
        }
    }
}

/// How the wake list and the glance write a date: injected so the wording is testable.
public struct WakeFormat: Sendable {
    /// "Fri 18:00"
    public var weekdayTime: @Sendable (Date) -> String
    /// "14:02"
    public var time: @Sendable (Date) -> String
    /// "Thu 19 Nov, 14:02"
    public var full: @Sendable (Date) -> String

    public static let current = WakeFormat(
        weekdayTime: { written($0, "EEEHHmm") }, time: { written($0, "HHmm") }, full: { written($0, "EEEdMMMHHmm") })

    /// The phone's own wording of a date from a template ("Fri 18:00": the 24-hour clock the design uses).
    private static func written(_ date: Date, _ template: String) -> String {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }
}

/// A person or a chat the agent wakes on, for a message or a call.
public struct Waker: Equatable, Sendable {
    public enum Who: Equatable, Sendable {
        case person(String)
        /// `name` nil: no message seen there yet.
        case chat(name: String?, isGroup: Bool)
    }

    public let who: Who
    /// The apps it listens on; empty: any app for a person, none known for a chat.
    public let apps: [String]
    /// Why it can never fire, in the app's words.
    public let brokenReason: String?
}

/// A condition from any source, as one short clause.
public struct WakeClause: Equatable, Sendable {
    public enum Glyph: Equatable, Sendable { case person, bubble, mail, payments, answer, nearby, ring }

    public struct Piece: Equatable, Sendable {
        public let text: String
        /// A figure or quoted words: drawn in the normal weight.
        public let isFigure: Bool
    }

    public let pieces: [Piece]
    public let glyph: Glyph
    /// The networks at the right.
    public let apps: [String]
    /// The source's name at the right (when there are no networks).
    public let source: String?
    /// A small muted line under it: "or Thu 18:00 passes".
    public let aside: String?
    /// The ask it opens, by check ref.
    public let check: String?

    public var text: String { pieces.map(\.text).joined() }

    init(
        pieces: [Piece], glyph: Glyph, apps: [String] = [], source: String? = nil, aside: String? = nil,
        check: String? = nil
    ) {
        self.pieces = pieces
        self.glyph = glyph
        self.apps = apps
        self.source = source
        self.aside = aside
        self.check = check
    }
}

/// A wake line as a row of the sheet.
public enum WakeRow: Equatable, Sendable {
    case waker(Waker)
    case clause(WakeClause)
}

extension WakeLine {
    /// Broken lines stay in place, muted, with their reason, and are left out of the glance.
    public var isBroken: Bool {
        if case .message(let line) = self { return line.broken != nil }
        return false
    }

    /// Only a message line that covers calls is a person or a chat row; every other line is a clause.
    public func row(format: WakeFormat = .current) -> WakeRow {
        switch self {
        case .message(let line): line.calls && (line.chat != nil || line.person != nil) ? .waker(line.waker) : .clause(line.clause)
        case .payments(let line): .clause(line.clause)
        case .answer(let line): .clause(line.clause(format: format))
        case .wideNet: .clause(.init(pieces: [.plain("Something new touches this matter")], glyph: .nearby))
        case .unknown(let kind):
            .clause(.init(pieces: [.plain("Something new in "), .figure(kind.replacingOccurrences(of: "_", with: " "))], glyph: .ring))
        }
    }
}

extension WakeLine.Message {
    var waker: Waker {
        let apps = apps ?? chat?.app.map { [$0] } ?? []
        let reason = broken.map { $0 == .unknownPerson ? "No longer in your people" : "It can never wake the agent" }
        if let chat { return .init(who: .chat(name: chat.name, isGroup: chat.group == true), apps: apps, brokenReason: reason) }
        return .init(who: .person(person ?? ""), apps: apps, brokenReason: reason)
    }

    var clause: WakeClause {
        var pieces: [WakeClause.Piece]
        if fromHim == true {
            pieces = [.plain("You write")]
            if let name = chat?.name { pieces.append(.plain(" in \(name)")) } else if let person { pieces.append(.plain(" to \(person)")) }
            if let words { pieces += [.plain(" "), .figure("“\(words)”")] }
        } else if let person {
            pieces = [.plain("\(person) writes")]
            if let words { pieces += [.plain(" "), .figure("“\(words)”")] }
        } else {
            let head = apps == ["mail"] ? "A mail" : chat?.name.map { "A message in \($0)" } ?? "A message"
            pieces = words.map { [.plain("\(head) contains "), .figure("“\($0)”")] } ?? [.plain("Any message")]
        }
        let glyph: WakeClause.Glyph = fromHim == true ? .person : apps == ["mail"] ? .mail : .bubble
        return .init(pieces: pieces, glyph: glyph, apps: apps ?? [])
    }
}

extension WakeLine.Payments {
    var clause: WakeClause {
        func euros(_ amount: Double) -> String {
            (amount == amount.rounded() ? String(Int(amount)) : String(format: "%.2f", amount)) + " €"
        }
        var pieces: [WakeClause.Piece] = []
        let isIn = quantity == "eur_in"
        let (bound, amount) = above.map { ("over", $0) } ?? below.map { ("under", $0) } ?? ("", 0)
        if !bound.isEmpty {
            pieces = [.plain(isIn ? "You receive \(bound) " : "A payment is \(bound) "), .figure(euros(amount))]
            if let words { pieces += [.plain(" and mentions "), .figure("“\(words)”")] }
        } else if let words {
            pieces = [.plain("A payment mentions "), .figure("“\(words)”")]
        } else {
            pieces = [.plain("Any payment")]
        }
        return .init(pieces: pieces, glyph: .payments, source: "Payments")
    }
}

extension WakeLine.Answer {
    func clause(format: WakeFormat) -> WakeClause {
        .init(
            pieces: [.plain("You answer "), .figure("“\(card)”")], glyph: .answer,
            aside: "or \(format.weekdayTime(deadline)) passes", check: check)
    }
}

extension WakeClause.Piece {
    fileprivate static func plain(_ text: String) -> Self { .init(text: text, isFigure: false) }
    fileprivate static func figure(_ text: String) -> Self { .init(text: text, isFigure: true) }
}

extension RegisteredAgent {
    /// The line under the agent's name on its row: waiting, the first two people or chats it listens for, "+N" for every
    /// other line that can fire, then its deadline ("Idris, Camille +5, or Fri 18:00"); working, since when; stopped, "Stopped".
    /// Finished and the rest have none.
    public func glance(format: WakeFormat = .current) -> String? {
        switch status {
        case .running: return (statusSince ?? lastTurn?.startedAt).map { "Working since \(format.time($0))" } ?? "Working"
        case .stopped: return "Stopped"
        case .waiting:
            let live = wakesOn.filter { !$0.isBroken }
            let first = live.compactMap { line -> String? in
                guard case .waker(let waker) = line.row(format: format) else { return nil }
                switch waker.who {
                case .person(let name): return name.split(separator: " ").first.map(String.init)
                case .chat(let name, _): return name
                }
            }.prefix(2)
            let rest = live.count - first.count
            let head = first.isEmpty ? "" : first.joined(separator: ", ") + (rest > 0 ? " +\(rest)" : "")
            let tail = wait.map { format.weekdayTime($0.until) }
            return [head, tail.map { head.isEmpty ? $0 : "or \($0)" } ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")
                .nilIfEmpty
        case .ended, .handedOver, .unknown: return nil
        }
    }
}

extension String {
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
