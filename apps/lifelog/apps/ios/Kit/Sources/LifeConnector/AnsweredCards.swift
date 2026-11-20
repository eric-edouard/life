import Foundation

/// Whether what was read, held or answered under the Life at `origin` (nil: no pairing) belongs to the phone's pairing
/// now (`paired`): the one test, for a read that lands, an answer Life confirms, and a card a notification kept.
public func belongsToPairing(_ origin: URL?, now paired: URL?) -> Bool {
    origin?.absoluteString == paired?.absoluteString
}

/// The cards his answers took out, with when Life confirmed each. A read asked before an answer was confirmed may still
/// list its card, however late it lands: every screen leaves such a card out of it (`newer(than:)`). A read asked after
/// wins, even one that still lists the card (Life keeps it open). Kept with the reads (`ReadCache`), so a cold start from
/// a cached read leaves it out too. One pairing's: a new pairing starts with none, and an answer begun under another
/// is never added (`belongsToPairing`).
public struct AnsweredCards: Codable, Sendable, Equatable {
    private var confirmed: [String: Date] = [:]

    public init() {}

    /// His answer, confirmed at `time`.
    public mutating func answered(_ ref: String, at time: Date) { confirmed[ref] = time }

    /// The cards answered after a read was asked (`asked`, nil for none read yet): that read may still list them.
    public func newer(than asked: Date?) -> Set<String> {
        Set(confirmed.filter { $0.value > asked ?? .distantPast }.keys)
    }

    /// Forgets the answers every read the phone could still show was asked after (`asked`, the oldest kept read; nil:
    /// none is kept). Done at launch, when no read is under way.
    public mutating func forget(confirmedBy asked: Date?) {
        confirmed = confirmed.filter { $0.value > asked ?? .distantFuture }
    }
}

extension Inbox {
    /// The inbox less these cards, its counts and badge with them.
    public func without(_ refs: Set<String>) -> Inbox {
        let gone = checks.filter { refs.contains($0.ref) }
        guard !gone.isEmpty else { return self }
        var counts = self.counts
        for check in gone { counts[check.group.rawValue]? -= 1 }
        return Inbox(
            checks: checks.filter { !refs.contains($0.ref) }, counts: counts, total: total - gone.count,
            deadlinesToday: deadlinesToday, blocking: blocking.map { $0 - gone.count { $0.urgency == .blocks } })
    }
}
