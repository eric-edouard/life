import Foundation

/// The key of each card's answer in flight: made at his tap, kept while the same tap repeats after a failed connection
/// (the call may have run, and Life then returns its first result), and new after any result Life gave.
public struct AnswerTaps: Sendable, Equatable {
    private var keys: [String: String] = [:]

    public init() {}

    /// The key for his tap on `ref`: the held one when the last try ended on a failed connection, else a new one.
    public mutating func key(for ref: String, make: () -> String = { UUID().uuidString }) -> String {
        if let held = keys[ref] { return held }
        let key = make()
        keys[ref] = key
        return key
    }

    /// The tap ended as `state`: only a failure of the connection keeps its key.
    public mutating func ended(_ ref: String, as state: ActionState<ActionProof>) {
        if case .failed(let failure, _) = state, failure.isSameTap { return }
        keys[ref] = nil
    }
}
