import Foundation

/// A person or a chat the agent wakes on, for a message or a call.
public struct Waker: Equatable, Sendable {
    public enum Who: Equatable, Sendable {
        /// `party` nil: someone who no longer resolves, by the words the agent wrote.
        case person(name: String, party: Party?)
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
    /// Why it can never fire, in the app's words: the clause stays in place, muted.
    public let brokenReason: String?

    public var text: String { pieces.map(\.text).joined() }

    init(
        pieces: [Piece], glyph: Glyph, apps: [String] = [], source: String? = nil, aside: String? = nil,
        check: String? = nil, brokenReason: String? = nil
    ) {
        self.pieces = pieces
        self.glyph = glyph
        self.apps = apps
        self.source = source
        self.aside = aside
        self.check = check
        self.brokenReason = brokenReason
    }
}

/// A wake line as a row of the sheet.
public enum WakeRow: Equatable, Sendable {
    case waker(Waker)
    case clause(WakeClause)
}

extension WakeLine {
    /// Broken lines stay in place, muted, with their reason, and are left out of the row line.
    public var isBroken: Bool {
        if case .message(let line) = self { return line.broken != nil }
        return false
    }

    /// Only a message line that covers calls is a person or a chat row; every other line is a clause.
    public func row(locale: Locale = .current, timeZone: TimeZone = .current) -> WakeRow {
        switch self {
        case .message(let line):
            line.calls && (line.chat != nil || line.person != nil) ? .waker(line.waker) : .clause(line.clause)
        case .payments(let line): .clause(line.clause(locale: locale))
        case .answer(let line): .clause(line.clause(locale: locale, timeZone: timeZone))
        case .wideNet: .clause(.init(pieces: [.plain("Something new touches this matter")], glyph: .nearby))
        case .unknown(let kind):
            .clause(
                .init(
                    pieces: [.plain("Something new in "), .figure(kind.replacingOccurrences(of: "_", with: " "))],
                    glyph: .ring))
        }
    }
}

extension WakeLine.Message {
    private var brokenReason: String? {
        broken.map { $0 == .unknownPerson ? "No longer in your people" : "It can never wake the agent" }
    }

    var waker: Waker {
        let apps = apps ?? chat?.app.map { [$0] } ?? []
        if let chat {
            return .init(
                who: .chat(name: chat.name, isGroup: chat.group == true), apps: apps, brokenReason: brokenReason)
        }
        return .init(who: .person(name: person ?? "", party: party), apps: apps, brokenReason: brokenReason)
    }

    var clause: WakeClause {
        var pieces: [WakeClause.Piece]
        if fromHim == true {
            pieces = [.plain("You write")]
            if let name = chat?.name {
                pieces.append(.plain(" in \(name)"))
            } else if let person {
                pieces.append(.plain(" to \(person)"))
            }
            if let words { pieces += [.plain(" "), .figure("“\(words)”")] }
        } else if let person {
            pieces = [.plain("\(person) writes")]
            if let words { pieces += [.plain(" "), .figure("“\(words)”")] }
        } else {
            let head = apps == ["mail"] ? "A mail" : chat?.name.map { "A message in \($0)" } ?? "A message"
            pieces = words.map { [.plain("\(head) contains "), .figure("“\($0)”")] } ?? [.plain("Any message")]
        }
        let glyph: WakeClause.Glyph = fromHim == true ? .person : apps == ["mail"] ? .mail : .bubble
        // Mail's glyph already says it: no network mark beside it.
        return .init(
            pieces: pieces, glyph: glyph, apps: apps == ["mail"] ? [] : apps ?? [], brokenReason: brokenReason)
    }
}

extension WakeLine.Payments {
    func clause(locale: Locale) -> WakeClause {
        func euros(_ amount: Double) -> String {
            amount.formatted(
                .currency(code: "EUR").precision(.fractionLength(amount == amount.rounded() ? 0 : 2)).locale(locale))
        }
        var pieces: [WakeClause.Piece] = []
        let isIn = quantity == "eur_in"
        // A non-breaking space keeps the amount with its word on one line.
        let head = isIn ? "You receive" : "A payment is"
        let amounts: [WakeClause.Piece]? =
            switch (above, below) {
            case (let low?, let high?): [.figure(euros(low)), .plain(" and "), .figure(euros(high))]
            case (let low?, nil): [.figure(euros(low))]
            case (nil, let high?): [.figure(euros(high))]
            case (nil, nil): nil
            }
        let bound = above != nil ? (below != nil ? "between" : "over") : "under"
        if let amounts {
            pieces = [.plain("\(head) \(bound)\u{00A0}")] + amounts
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
    func clause(locale: Locale, timeZone: TimeZone) -> WakeClause {
        .init(
            pieces: [.plain("You answer "), .figure("“\(card)”")], glyph: .answer,
            aside: "or \(DeadlineWords.when(deadline, locale: locale, timeZone: timeZone)) passes", check: check)
    }
}

extension WakeClause.Piece {
    fileprivate static func plain(_ text: String) -> Self { .init(text: text, isFigure: false) }
    fileprivate static func figure(_ text: String) -> Self { .init(text: text, isFigure: true) }
}

extension RegisteredAgent {
    /// The one word for where an agent stands, on its row and on its sheet; nil while it waits (its wake list says it).
    public var stateWord: String? {
        if notStarted != nil { return AgentWords.notStarted }
        return switch status {
        case .running: "Working"
        case .stopped: "Stopped"
        case .ended: "Finished"
        case .handedOver: "Handed over"
        case .waiting, .unknown: nil
        }
    }

    /// While its session is open outside the desk: where, and since when ("Paused: open in your Claude app since 09:12"). Its wakes
    /// wait until that lets go.
    public func sessionOpenLine(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let sessionOpenIn else { return nil }
        let place = sessionOpenIn == .claudeApp ? "your Claude app" : "Claude Code"
        let since = sessionOpenSince.map { " since \(SaidWords.time($0, locale: locale, timeZone: timeZone))" } ?? ""
        return "Paused: open in \(place)\(since)"
    }

    /// The line under the agent's name on its row: waiting, the first two people or chats it listens for, "+N" for every
    /// other line that can fire, then its deadline ("Idris, Camille +5, or Fri 18:00"); working, since when; stopped,
    /// "Stopped"; not started, why; open outside the desk, where. Finished and the rest have none.
    public func rowLine(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        if let notStarted { return "\(AgentWords.notStarted): \(notStarted)" }
        switch status {
        case .running:
            return statusSince.map { "Working since \(SaidWords.time($0, locale: locale, timeZone: timeZone))" }
                ?? stateWord
        case .stopped: return stateWord
        case .waiting:
            if let open = sessionOpenLine(locale: locale, timeZone: timeZone) { return open }
            let live = wakesOn.filter { !$0.isBroken }
            let first = live.compactMap { line -> String? in
                guard case .waker(let waker) = line.row(locale: locale, timeZone: timeZone) else { return nil }
                switch waker.who {
                case .person(let name, _): return name.split(separator: " ").first.map(String.init)
                case .chat(let name, _): return name
                }
            }.prefix(2)
            let rest = live.count - first.count
            let head = first.isEmpty ? "" : first.joined(separator: ", ") + (rest > 0 ? " +\(rest)" : "")
            let tail = wait.map { DeadlineWords.when($0.until, locale: locale, timeZone: timeZone) }
            let line = [head, tail.map { head.isEmpty ? $0 : "or \($0)" } ?? ""].filter { !$0.isEmpty }
            return line.isEmpty ? nil : line.joined(separator: ", ")
        case .ended, .handedOver, .unknown: return nil
        }
    }
}

/// Words about an agent the start flow and the sheet both say.
public enum AgentWords {
    public static let notStarted = "Not started"
}
