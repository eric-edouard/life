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
    /// Every open card is in it, none cut off by the read's limit: only then does a card it lacks no longer wait.
    public var isWhole: Bool { checks.count >= total }
}

/// The card a tapped push opens.
public struct InboxOpening: Sendable, Equatable {
    public let check: Check?
    /// The push's card is no longer open: `check` is the first one waiting instead, and the screen says so.
    public let wasAnswered: Bool
}

/// A tapped push, from the tap until a whole read asked after it lands: its card as the phone holds it (the cached
/// inbox's, else the one its notification kept), on show at once while that read checks it.
public struct PushedCard: Sendable, Equatable {
    public let pushId: String
    /// Nil when neither the cache nor the notification held it: the read opens it.
    public let check: Check?
    public let tappedAt: Date

    public init(pushId: String, in read: Inbox?, notified: Check?, at tappedAt: Date) {
        self.pushId = pushId
        check = read?.checks.first { $0.pushId == pushId } ?? notified
        self.tappedAt = tappedAt
    }

    /// Where it opens before any read: its card, when one is in hand.
    public var opening: InboxOpening? { check.map { InboxOpening(check: $0, wasAnswered: false) } }

    /// The inbox while it is checked: the read, with the card first when the read does not list it (a one-card inbox
    /// when nothing was read).
    public func shown(in read: Inbox?) -> Inbox? {
        guard let check, read?.checks.contains(where: { $0.ref == check.ref }) != true else { return read }
        let read = read ?? Inbox(checks: [], counts: [:], total: 0, deadlinesToday: 0, blocking: 0)
        var counts = read.counts
        counts[check.group.rawValue, default: 0] += 1
        return Inbox(
            checks: [check] + read.checks, counts: counts, total: read.total + 1,
            deadlinesToday: read.deadlinesToday, blocking: read.blocking.map { $0 + (check.urgency == .blocks ? 1 : 0) }
        )
    }

    /// What a read asked at `asked` makes of it: nil while it says nothing yet (asked before the tap, or cut off by its
    /// limit before the card), else where the push opens: its card, or the first one waiting when it was answered
    /// elsewhere.
    public func checked(by read: Inbox, askedAt asked: Date) -> InboxOpening? {
        let opening = read.opening(pushId: pushId)
        return asked > tappedAt && (read.isWhole || !opening.wasAnswered) ? opening : nil
    }
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

    public init(checks: [Check] = [], canWaitFrom: Int? = nil) {
        (self.checks, self.canWaitFrom) = (checks, canWaitFrom)
    }

    /// The ask on show: the one he is on, else the first.
    public func check(on ref: String?) -> Check? { checks.first { $0.ref == ref } ?? checks.first }

    /// The kinds of ask that wait, in the order they first appear: what the list's filter offers.
    public var kinds: [CheckGroup] { checks.map(\.group).reduce(into: []) { if !$0.contains($1) { $0.append($1) } } }

    /// Only the asks of one kind, in the same order, with the heading where its own can-wait part starts. Nil, or a kind
    /// with none waiting, is the whole order: a filter never leaves him an empty list.
    public func only(_ kind: CheckGroup?) -> InboxOrder {
        guard let kind, kinds.contains(kind) else { return self }
        let kept = checks.filter { $0.group == kind }
        return InboxOrder(checks: kept, canWaitFrom: kept.canWaitFrom)
    }
}

extension [Check] {
    /// Where what only improves starts, in checks already put in order; nil when nothing improves.
    var canWaitFrom: Int? { firstIndex { $0.urgency == .improves } }

    /// The ask after `ref`, where his answer leaves him.
    public func ref(after ref: String) -> String? {
        firstIndex { $0.ref == ref }.flatMap { dropFirst($0 + 1).first?.ref }
    }
}

extension Inbox {
    /// What blocks, then what only improves. An ask he kept for later (`deferred`) goes after the others of its own kind,
    /// so the heading stays where the blocking group ends. `except` are the refs not to show: the ask whose result is on
    /// show in its place.
    public func ordered(deferred: [String], except: Set<String> = []) -> InboxOrder {
        func later(_ kind: [Check]) -> [Check] {
            kind.filter { !deferred.contains($0.ref) } + kind.filter { deferred.contains($0.ref) }
        }
        let open = checks.filter { !except.contains($0.ref) }
        let ordered = later(open.filter { $0.urgency != .improves }) + later(open.filter { $0.urgency == .improves })
        return InboxOrder(checks: ordered, canWaitFrom: ordered.canWaitFrom)
    }
}
