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
    public let version: String?
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
    /// when nothing was read), unless his answer took it out since the tap (`answeredSinceTap`): a read cut off by its
    /// limit never puts an answered card back.
    public func shown(in read: Inbox?, answeredSinceTap: Set<String>) -> Inbox? {
        guard let check, !answeredSinceTap.contains(check.ref),
            read?.checks.contains(where: { $0.ref == check.ref }) != true
        else { return read }
        let read = read ?? Inbox(checks: [], counts: [:], total: 0, deadlinesToday: 0, blocking: 0, version: nil)
        var counts = read.counts
        counts[check.group.rawValue, default: 0] += 1
        return Inbox(
            checks: [check] + read.checks, counts: counts, total: read.total + 1,
            deadlinesToday: read.deadlinesToday,
            blocking: read.blocking.map { $0 + (check.urgency == .blocks ? 1 : 0) },
            version: nil)
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
    /// A kind answered in bulk, by the ref of the ask that stands for it (`folded`): every open ask of that kind.
    public let bulk: [String: [Check]]

    public init(checks: [Check] = [], canWaitFrom: Int? = nil, bulk: [String: [Check]] = [:]) {
        (self.checks, self.canWaitFrom, self.bulk) = (checks, canWaitFrom, bulk)
    }

    /// The ask on show: the one he is on (or the bulk ask that holds it), else the first.
    public func check(on ref: String?) -> Check? {
        checks.first { $0.ref == ref } ?? checks.first { bulk[$0.ref]?.contains { $0.ref == ref } == true }
            ?? checks.first
    }

    /// The voices to name fold into the first, whatever Life guesses: it is the way into the voice run, nothing is ticked
    /// or dismissed in bulk. Each other kind with 2 or more asks Life pre-ticks (`preTicked`) folds into its first ask,
    /// which stands for all of them (`bulk`), unless he chose to go through it one by one (`unfolded`). A kind he is answering row by row
    /// (`working`, by the ask its card was first shown under) stays one card down to its last row, never turning into
    /// a single ask under his finger, and keeps that ask as its page even once it was answered: the card never leaves
    /// and comes back under a new ref.
    public func folded(except unfolded: Set<CheckGroup> = [], working: [CheckGroup: Check] = [:]) -> InboxOrder {
        let inBulk = kinds.filter { kind in
            if kind == .voice { return true }
            let pre = checks.count(where: { $0.bulkKind == kind && $0.preTicked != nil })
            return !unfolded.contains(kind) && (pre > 1 || (pre > 0 && working[kind] != nil))
        }
        let heads = Dictionary(
            uniqueKeysWithValues: inBulk.compactMap { kind in
                (working[kind] ?? checks.first { $0.bulkKind == kind }).map { (kind, $0) }
            })
        let bulk = Dictionary(
            uniqueKeysWithValues: heads.values.map { head in (head.ref, checks.filter { $0.bulkKind == head.bulkKind })
            })
        let kept = checks.compactMap { check -> Check? in
            guard let head = heads[check.bulkKind] else { return check }
            return checks.first { $0.bulkKind == check.bulkKind }?.ref == check.ref ? head : nil
        }
        return InboxOrder(checks: kept, canWaitFrom: kept.canWaitFrom, bulk: bulk)
    }

    /// Where his answer leaves him: the first of the asks that were after it when he tapped (`later`) still on show,
    /// or the bulk ask now holding it; nil when none is left (the first ask then shows). An ask his answer took away
    /// too (a fold of two people) is passed over, never a jump back to the top.
    public func next(of later: [String]) -> String? {
        later.lazy.compactMap { ref in
            checks.first { $0.ref == ref || bulk[$0.ref]?.contains { $0.ref == ref } == true }?.ref
        }.first
    }

    /// Where the pager stays when a read changes the asks under it (`was`, the refs on show before): on the ask he is on
    /// (or the bulk ask now holding it), whatever came, went or moved around it; that ask gone, on the first one after it
    /// still there, else the last one before it; nil when none is left. A read in the background never moves him.
    public func staying(on ref: String, was: [String]) -> String? {
        let at = was.firstIndex(of: ref) ?? was.endIndex
        return next(of: [ref] + was[min(at + 1, was.endIndex)...] + was[..<at].reversed())
    }

    /// The kinds of ask that wait, in the order they first appear: what the list's filter offers.
    public var kinds: [CheckGroup] { checks.map(\.bulkKind).reduce(into: []) { if !$0.contains($1) { $0.append($1) } } }

    /// Only the asks of one kind, in the same order, with the heading where its own can-wait part starts. Nil, or a kind
    /// with none waiting, is the whole order: a filter never leaves him an empty list.
    public func only(_ kind: CheckGroup?) -> InboxOrder {
        guard let kind, kinds.contains(kind) else { return self }
        let kept = checks.filter { $0.bulkKind == kind }
        return InboxOrder(checks: kept, canWaitFrom: kept.canWaitFrom)
    }

    /// Only the asks Ask Life named (`ShownList.refs`), in this order (what blocks first), with their own can-wait
    /// heading; nil is the whole order. Unlike a kind, it may leave nothing: the list says so under its words.
    public func cut(to cut: ShownList?) -> InboxOrder {
        guard let cut else { return self }
        let kept = checks.filter { cut.refs.contains($0.ref) }
        return InboxOrder(checks: kept, canWaitFrom: kept.canWaitFrom)
    }
}

extension [Check] {
    /// Where what only improves starts, in checks already put in order; nil when nothing improves.
    var canWaitFrom: Int? { firstIndex { $0.urgency == .improves } }

    /// The ask after `ref`, where his answer leaves him.
    public func ref(after ref: String) -> String? { refs(after: ref).first }

    /// The asks after `ref`, in order: where his answer may leave him (`InboxOrder.next(of:)`).
    public func refs(after ref: String) -> [String] {
        firstIndex { $0.ref == ref }.map { dropFirst($0 + 1).map(\.ref) } ?? []
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

/// Where one row of the guesses' card stands: both answers on offer, its answer going to Life, or answered.
public enum GuessState: Equatable, Sendable {
    case rest
    case sending(yes: Bool)
    case answered(yes: Bool)
}

extension ActionState {
    /// A guesses' row's state, from his answer's own state first (`words`, his answer on it here, "Yes" or "No"):
    /// working, then answered as soon as Life confirmed, never back at rest while the read that drops it is under way.
    /// A row whose answer ended elsewhere (a read without it, after his answer) stays answered; a refused one is at rest.
    public func guessState(words: String?, isOpen: Bool) -> GuessState {
        let yes = words == "Yes"
        switch self {
        case .running: return .sending(yes: yes)
        case .succeeded: return .answered(yes: yes)
        case .failed: return .rest
        case .idle: return !isOpen && words != nil ? .answered(yes: yes) : .rest
        }
    }
}

extension [Check] {
    /// The guesses' card's rows: those he met (`met`, in their order) that are still open or that he answered here
    /// (`answered`), then the open ones new to him. A row another answer took away (his "Same person" folding a guess
    /// with its own rows) leaves, never staying with answers Life would refuse.
    public static func guessRows(met: [Check], open: [Check], answered: Set<String>) -> [Check] {
        met.filter { row in answered.contains(row.ref) || open.contains { $0.ref == row.ref } }
            + open.filter { row in !met.contains { $0.ref == row.ref } }
    }
}
