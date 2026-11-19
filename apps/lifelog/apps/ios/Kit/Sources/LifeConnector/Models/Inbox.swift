import Foundation

/// `read_inbox`: every open ask, what blocks first then most urgent, with the counts the badge and the tabs show.
public struct Inbox: Decodable, Sendable, Equatable {
    public let checks: [Check]
    public let counts: [String: Int]
    public let total: Int
    public let deadlinesToday: Int
    /// How many block him (the badge); absent in a read kept before Life sent it.
    public let blocking: Int?
    /// The badge: the cards that block him (every card in a read kept before Life sent `blocking`).
    public var badge: Int { blocking ?? total }
}

/// The card a tapped push opens.
public struct InboxOpening: Sendable, Equatable {
    public let check: Check?
    /// The push's card is no longer open: `check` is the first one waiting instead, and the screen says so.
    public let wasAnswered: Bool
}

extension Inbox {
    /// This inbox with a card read alone (`read_inbox` by `pushId`) in front, until the whole inbox is read.
    public func adding(_ card: Check) -> Inbox {
        guard !checks.contains(where: { $0.ref == card.ref }) else { return self }
        var counts = counts
        counts[card.group.rawValue, default: 0] += 1
        return Inbox(
            checks: [card] + checks, counts: counts, total: total + 1, deadlinesToday: deadlinesToday,
            blocking: blocking.map { $0 + (card.urgency == .improves ? 0 : 1) })
    }

    public func opening(pushId: String) -> InboxOpening {
        guard let check = checks.first(where: { $0.pushId == pushId }) else {
            return InboxOpening(check: checks.first, wasAnswered: true)
        }
        return InboxOpening(check: check, wasAnswered: false)
    }
}

/// One page of the inbox pager: an ask, or the boundary panel that says the rest can wait.
public enum InboxPage: Equatable, Sendable {
    case ask(Check)
    case boundary

    /// What the pager scrolls to: the ask's ref, or the boundary's own id.
    public var id: String {
        switch self {
        case .ask(let check): check.ref
        case .boundary: Self.boundaryId
        }
    }

    public static let boundaryId = "inbox-boundary"
}

extension Inbox {
    /// The pages in the order he swipes them: what blocks, the boundary, what only improves. An ask he kept for later
    /// (`deferred`) goes after the others of its own kind, so the boundary stays where the blocking group ends. The
    /// boundary is there only when something improves; with nothing blocking it comes first.
    public func pages(deferred: [String]) -> [InboxPage] {
        func ordered(_ kind: [Check]) -> [InboxPage] {
            (kind.filter { !deferred.contains($0.ref) } + kind.filter { deferred.contains($0.ref) }).map(InboxPage.ask)
        }
        let improves = ordered(checks.filter { $0.urgency == .improves })
        return ordered(checks.filter { $0.urgency != .improves }) + (improves.isEmpty ? [] : [.boundary] + improves)
    }
}

extension [InboxPage] {
    /// The page on show: the one he is on, else the first.
    public func page(on id: String?) -> InboxPage? { first { $0.id == id } ?? first }

    /// The ask on show; on the boundary, the ask after it (its context stays until he swipes on).
    public func check(on id: String?) -> Check? {
        guard let page = page(on: id), let at = firstIndex(of: page) else { return nil }
        return self[at...].lazy.compactMap { if case .ask(let check) = $0 { check } else { nil } }.first
    }

    /// The id of the page after the ask `ref`, where his answer leaves him.
    public func id(after ref: String) -> String? {
        firstIndex { $0.id == ref }.flatMap { dropFirst($0 + 1).first?.id }
    }

    public var checks: [Check] { compactMap { if case .ask(let check) = $0 { check } else { nil } } }
}
