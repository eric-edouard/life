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
    public func opening(pushId: String) -> InboxOpening {
        guard let check = checks.first(where: { $0.pushId == pushId }) else {
            return InboxOpening(check: checks.first, wasAnswered: true)
        }
        return InboxOpening(check: check, wasAnswered: false)
    }
}

/// The asks in the order he meets them, for the list, the pager and where an answer leads.
public struct InboxOrder: Equatable, Sendable {
    public let checks: [Check]
    /// Where what only improves starts (the list's heading "The rest can wait"); nil when nothing improves.
    public let canWaitFrom: Int?

    public init(checks: [Check] = [], canWaitFrom: Int? = nil) { (self.checks, self.canWaitFrom) = (checks, canWaitFrom) }

    /// The ask on show: the one he is on, else the first.
    public func check(on ref: String?) -> Check? { checks.first { $0.ref == ref } ?? checks.first }
}

extension [Check] {
    /// The ask after `ref`, where his answer leaves him.
    public func ref(after ref: String) -> String? {
        firstIndex { $0.ref == ref }.flatMap { dropFirst($0 + 1).first?.ref }
    }
}

extension Inbox {
    /// What blocks, then what only improves. An ask he kept for later (`deferred`) goes after the others of its own kind,
    /// so the heading stays where the blocking group ends. `except` are the refs not to show: an answer held for Undo
    /// or in flight, so a list never flashes it back during a send.
    public func ordered(deferred: [String], except: Set<String> = []) -> InboxOrder {
        func later(_ kind: [Check]) -> [Check] {
            kind.filter { !deferred.contains($0.ref) } + kind.filter { deferred.contains($0.ref) }
        }
        let open = checks.filter { !except.contains($0.ref) }
        let blocking = later(open.filter { $0.urgency != .improves })
        let improving = later(open.filter { $0.urgency == .improves })
        return InboxOrder(checks: blocking + improving, canWaitFrom: improving.isEmpty ? nil : blocking.count)
    }
}
