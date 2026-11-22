extension ActionState where Proof == ActionProof {
    /// What an answer on a row of Life's own questions says back when it ends, its card gone by then: Life's reason when it
    /// failed or did not end its step as asked, the day a Not now brings its card back, else `label` once Life took it
    /// (green only on Life's word). Nil: still running.
    public func heldAnswerWords(as label: String) -> (words: String, isDone: Bool)? {
        switch self {
        case .failed(let failure, _): return (failure.reason, false)
        case .succeeded(.answered(let result), _):
            if let error = result.changed?.ended?.error { return ("Your answer was recorded. \(error)", false) }
            return (result.changed?.snoozed() ?? label, true)
        case .succeeded: return (label, true)
        default: return nil
        }
    }
}
