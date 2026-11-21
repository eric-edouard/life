import Foundation

/// Where one read of Life stands, as every screen shows it. A store holds the last good value, when it was read, and
/// what the latest try is doing; `shown` is the one thing a screen switches on, so a read that failed after a good one
/// shows that one as stale, never a blank. One reducer, `apply`.
public struct ReadState<Value: Sendable>: Sendable {
    public enum Phase: Sendable, Equatable {
        case idle, loading, loaded, unreachable, notPaired
        case failed(String)
    }

    /// Why a value is stale.
    public enum Why: Sendable, Equatable {
        case unreachable
        case failed(String)
    }

    public enum Shown: Sendable {
        case loading
        case loaded(Value)
        case empty
        case stale(Value, since: Date, why: Why)
        /// The Mac cannot be reached from here, and nothing was ever read.
        case unreachable
        case failed(String)
        case notPaired
    }

    public enum Event: Sendable {
        case started
        case succeeded(Value, Date)
        case failed(MCPError)
    }

    public private(set) var value: Value?
    public private(set) var loadedAt: Date?
    public private(set) var phase = Phase.idle
    /// Where the last try ended, which a cancelled one goes back to.
    private var settled = Phase.idle

    public init() {}

    public mutating func apply(_ event: Event) {
        switch event {
        case .started:
            if phase != .loading { settled = phase }
            phase = .loading
        // Cancelled (the screen left, the app went to the background): nothing was learned, so the read stands as it was.
        case .failed(.cancelled): phase = settled
        case .succeeded(let new, let at):
            value = new
            loadedAt = at
            phase = .loaded
        case .failed(.unreachable): phase = .unreachable
        case .failed(.notPaired): phase = .notPaired
        case .failed(let error): phase = .failed(error.reason)
        }
    }

    /// A read with nothing to show and a last try that was cancelled, failed or unreachable must be tried again; a
    /// loaded one (even an empty one) and an unpaired one never.
    public var needsRetry: Bool {
        guard value == nil else { return false }
        switch phase {
        case .idle, .unreachable, .failed: return true
        case .loading, .loaded, .notPaired: return false
        }
    }

    /// A read tried, with nothing to show: it failed or the Mac was out of reach (never one not tried yet).
    public var hasFailed: Bool {
        guard value == nil else { return false }
        switch phase {
        case .unreachable, .failed: return true
        case .idle, .loading, .loaded, .notPaired: return false
        }
    }

    /// What to show; `isEmpty` says when a loaded value has nothing in it.
    public func shown(isEmpty: (Value) -> Bool = { _ in false }) -> Shown {
        guard let value else {
            switch phase {
            case .idle, .loading, .loaded: return .loading
            case .unreachable: return .unreachable
            case .failed(let reason): return .failed(reason)
            case .notPaired: return .notPaired
            }
        }
        let since = loadedAt ?? .distantPast
        switch phase {
        case .idle, .loading, .loaded: return isEmpty(value) ? .empty : .loaded(value)
        case .unreachable: return .stale(value, since: since, why: .unreachable)
        case .failed(let reason): return .stale(value, since: since, why: .failed(reason))
        case .notPaired: return .notPaired
        }
    }
}

/// The wait before retry number `attempt` (from 0) of a first read: 1, 2, 4, 8, 16 seconds, then every 30.
public func firstReadRetryDelay(attempt: Int) -> Duration {
    .seconds(attempt < 5 ? 1 << attempt : 30)
}
