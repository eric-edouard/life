import Foundation

/// The key of each card's answer in flight: made at his tap, kept while the same tap repeats after a failed connection
/// (the call may have run, and Life then returns its first result), and new after any result Life gave or for any other
/// answer to the same card, since Life returns the first result to whatever answer carries a key it knows.
public struct AnswerTaps: Sendable {
    private var held: [String: (request: AnswerRequest, key: String)] = [:]

    public init() {}

    /// The key for his answer `request`: the held one when that same answer's last try ended on a failed connection,
    /// else a new one.
    public mutating func key(for request: AnswerRequest, make: () -> String = { UUID().uuidString }) -> String {
        if let tap = held[request.ref], tap.request == request { return tap.key }
        let key = make()
        held[request.ref] = (request, key)
        return key
    }

    /// The tap ended as `state`: only a failure of the connection keeps its key.
    public mutating func ended(_ request: AnswerRequest, as state: ActionState<ActionProof>) {
        if case .failed(let failure, _) = state, failure.isSameTap { return }
        held[request.ref] = nil
    }
}
