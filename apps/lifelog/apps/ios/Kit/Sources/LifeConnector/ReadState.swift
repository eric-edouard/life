import Foundation

/// Where one read of Life stands, as every screen shows it. A store holds the last good value, when it was read, and
/// what the latest try is doing; `shown` is the one thing a screen switches on, so a read that failed after a good one
/// shows that one as stale, never a blank. One reducer, `apply`; reads of one kind run one at a time (`ReadFlights`), so
/// each that applies was asked after the one before.
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
        /// The value, with when its read was asked.
        case succeeded(Value, Date)
        case failed(MCPError)
    }

    public private(set) var value: Value?
    /// When the read of `value` was asked (a cached value: when it was kept).
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
        case .succeeded(let new, let asked):
            value = new
            loadedAt = asked
            phase = .loaded
        case .failed(.unreachable): phase = .unreachable
        case .failed(.notPaired): phase = .notPaired
        case .failed(let error): phase = .failed(error.reason)
        }
    }

    /// This read showing `shown` in place of its value (what it holds, with a card in hand added), its phase as it is: as
    /// of `at` when nothing was read, so a failed read shows the card in hand as stale, never a blank.
    public func showing(_ shown: Value, at: Date) -> ReadState {
        var read = self
        (read.value, read.loadedAt) = (shown, loadedAt ?? at)
        return read
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

extension ReadState.Shown {
    /// The value on screen, loaded or stale; nil when the screen shows none (loading, empty, failed, not paired). What a
    /// screen says about its read (a title's count) reads this, never `ReadState.value`, which outlives a lost pairing.
    public var onScreen: Value? {
        switch self {
        case .loaded(let value), .stale(let value, _, _): value
        case .loading, .empty, .unreachable, .failed, .notPaired: nil
        }
    }
}

extension ReadState where Value == Inbox {
    /// How many asks wait, as the inbox read last said (`total`) less his answers, while a read is on screen: nil before
    /// any read said (a pushed card alone, whose one-card inbox counts only itself) and once the pairing is lost.
    public func waiting(less answered: Set<String>) -> Int? {
        shown().onScreen.map { $0.without(answered).total }
    }
}

/// One read of each kind at a time, plus one more pass: a read asked while one of its kind runs never runs beside it
/// (the later of two would not always land last, and an older read would win). It joins the pass queued after the
/// running one, or queues it, and returns once that pass ended: several asks during one read make one more pass.
@MainActor
public final class ReadFlights {
    /// Each kind's last pass, running or queued.
    private var last: [String: Task<Void, Never>] = [:]
    /// The kinds whose last pass has not started yet.
    private var queued: Set<String> = []

    public init() {}

    public func run(_ key: String, _ read: @escaping @MainActor () async -> Void) async {
        if queued.contains(key), let pass = last[key] { return await pass.value }
        let before = last[key]
        queued.insert(key)
        // Its own task: a screen that leaves cancels its wait, never the read that others wait on too.
        let pass = Task {
            await before?.value
            queued.remove(key)
            await read()
        }
        last[key] = pass
        await pass.value
        if last[key] == pass { last[key] = nil }
    }
}

/// The wait before retry number `attempt` (from 0) of a first read: 1, 2, 4, 8, 16 seconds, then every 30.
public func firstReadRetryDelay(attempt: Int) -> Duration {
    .seconds(attempt < 5 ? 1 << attempt : 30)
}
