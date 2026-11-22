import Foundation

/// His actions' states by key, within one pairing with Life: another pairing starts it empty, and an event of an action
/// begun under an earlier one applies nothing, so its late end never lands on the new Life's card under the same key.
public struct ActionBook<Key: Hashable & Sendable>: Sendable {
    public private(set) var states: [Key: ActionState<ActionProof>] = [:]
    /// The pairing its states are of (`PairingGeneration.current`).
    public private(set) var pairing = 0
    /// When each action last heard from the Mac: its start, then Life's plan, steps and result (`isFromLife`).
    private var heard: [Key: Date] = [:]

    public init() {}

    public subscript(key: Key) -> ActionState<ActionProof>? { states[key] }

    /// Begins the action under `key`: false, beginning nothing, while one runs there.
    public mutating func begin(_ key: Key, at: Date = Date()) -> Bool {
        guard states[key]?.isRunning != true else { return false }
        (states[key], heard[key]) = (.running(steps: [], limit: nil), at)
        return true
    }

    /// Applies `event` of the action under `key` begun in pairing `begun`: false, applying nothing, once another began.
    public mutating func apply(
        _ event: ActionState<ActionProof>.Event, to key: Key, begunIn begun: Int, at: Date = Date()
    ) -> Bool {
        guard begun == pairing else { return false }
        states[key, default: .idle].apply(event)
        if event.isFromLife { heard[key] = at }
        return true
    }

    /// How long the action under `key` has run with no word from the Mac; nil once it ended.
    public func silence(of key: Key, at now: Date) -> TimeInterval? {
        guard states[key]?.isRunning == true, let heard = heard[key] else { return nil }
        return now.timeIntervalSince(heard)
    }

    /// Ends the action under `key` as not done once the Mac has said nothing for `MacSilence.noAnswerAfter`: true when
    /// it did. Its call may still run; the same tap repeats with the same key, so Life acts once.
    public mutating func endIfSilent(_ key: Key, at now: Date) -> Bool {
        guard let silence = silence(of: key, at: now), silence >= MacSilence.noAnswerAfter else { return false }
        states[key]?.apply(.failed(.noAnswer))
        return true
    }

    /// Forgets a result once the screen has shown it; one still running stays.
    public mutating func forget(_ key: Key) {
        if states[key]?.isRunning != true { (states[key], heard[key]) = (nil, nil) }
    }

    /// Another Life is paired, as pairing `pairing`: nothing of the last one's stays.
    public mutating func startOver(pairing: Int) { (states, heard, self.pairing) = ([:], [:], pairing) }
}
