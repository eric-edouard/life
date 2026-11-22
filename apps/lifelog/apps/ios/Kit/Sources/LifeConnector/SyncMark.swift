import Foundation

/// How what a page shows stands against Life on the Mac, as its one toast says it (the sync mark, the design of 22 Nov):
/// one form at a time, the most pressing first; nil when all is well, or when the page shows no value (its notice says
/// why). Worked out when drawn, never stored.
public enum SyncMark: Sendable, Equatable {
    /// The phone has no internet; what shows was read at `since`.
    case offline(since: Date?)
    /// The newest read found no way to the Mac.
    case macAway(since: Date?)
    /// Reach was lost, and a read is running.
    case reconnecting
    /// The page's own read failed with Life's reason (a 5xx, a timeout, an answer this app can't read).
    case failed(String, since: Date?)
    /// Nothing read for `oldAfter`, and no read running.
    case old(since: Date)
    /// A read runs over what shows.
    case updating
    /// Life answers, but its agents don't run as they should.
    case agents(AgentsTrouble)

    public enum AgentsTrouble: Sendable, Equatable {
        case off, notRunning, unreadable
        case stalled(Int)
    }

    /// A value shown and not read again for this long is out of date.
    public static let oldAfter: TimeInterval = 600
    /// How often the main reads are read again while the app is in front.
    public static let readEvery: Duration = .seconds(60)

    /// The mark over `shown`, whose read was asked at `stamp.at` and may be running; `agents`, the desk's trouble, only
    /// where the page tells it (home).
    public static func of<V>(
        _ shown: ReadState<V>.Shown, stamp: ReadStamp?, hasPath: Bool, lost: MCPError?, agents: AgentsTrouble?,
        now: Date
    ) -> SyncMark? {
        let since: Date?
        var failed: String?
        switch shown {
        case .loaded, .empty: since = stamp?.at
        case .stale(_, let at, .unreachable): since = at
        case .stale(_, let at, .failed(let reason)): (since, failed) = (at, reason)
        case .loading, .unreachable, .failed, .notPaired: return nil
        }
        let isReading = stamp?.isReading == true
        if !hasPath { return .offline(since: since) }
        if let lost {
            return isReading ? .reconnecting : lost == .offline ? .offline(since: since) : .macAway(since: since)
        }
        if isReading { return .updating }
        if let failed { return .failed(failed, since: since) }
        if case .stale = shown { return .macAway(since: since) }
        if let since, now.timeIntervalSince(since) > oldAfter { return .old(since: since) }
        return agents.map(SyncMark.agents)
    }
}

/// When a read was asked, and whether it is running again: what a page's mark needs beyond what it shows.
public struct ReadStamp: Sendable, Equatable {
    public let at: Date?
    public let isReading: Bool

    public init(at: Date?, isReading: Bool) { (self.at, self.isReading) = (at, isReading) }
}

extension ReadState {
    public var stamp: ReadStamp { ReadStamp(at: loadedAt, isReading: phase == .loading) }
}

extension RegisteredAgents {
    /// What keeps his agents from running, the most pressing first: the desk off or unreadable, its helper not running,
    /// then how many agents stalled (any amber but the default wait: a late deadline, a silent or failed turn, dropped
    /// events; `agents-now.ts`'s `amberOf` words).
    public var trouble: SyncMark.AgentsTrouble? {
        switch desk {
        case .off: return .off
        case .unreadable: return .unreadable
        case .ok, .unknown: break
        }
        if helper == .notRunning { return .notRunning }
        let stalled = agents.filter { !$0.isOver && $0.amber.contains { $0 != "default wait" } }.count
        return stalled > 0 ? .stalled(stalled) : nil
    }
}
