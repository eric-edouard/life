import Foundation

/// His actions' states by key, within one pairing with Life: another pairing starts it empty, and an event of an action
/// begun under an earlier one applies nothing, so its late end never lands on the new Life's card under the same key.
public struct ActionBook<Key: Hashable & Sendable>: Sendable {
    public private(set) var states: [Key: ActionState<ActionProof>] = [:]
    /// The pairing its states are of (`PairingGeneration.current`).
    public private(set) var pairing = 0

    public init() {}

    public subscript(key: Key) -> ActionState<ActionProof>? { states[key] }

    /// Begins the action under `key`: false, beginning nothing, while one runs there.
    public mutating func begin(_ key: Key) -> Bool {
        guard states[key]?.isRunning != true else { return false }
        states[key] = .running(steps: [], limit: nil)
        return true
    }

    /// Applies `event` of the action under `key` begun in pairing `begun`: false, applying nothing, once another began.
    public mutating func apply(_ event: ActionState<ActionProof>.Event, to key: Key, begunIn begun: Int) -> Bool {
        guard begun == pairing else { return false }
        states[key, default: .idle].apply(event)
        return true
    }

    /// Forgets a result once the screen has shown it; one still running stays.
    public mutating func forget(_ key: Key) {
        if states[key]?.isRunning != true { states[key] = nil }
    }

    /// Another Life is paired, as pairing `pairing`: nothing of the last one's stays.
    public mutating func startOver(pairing: Int) { (states, self.pairing) = ([:], pairing) }
}
