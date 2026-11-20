import Observation

/// His taps that change one item each (a matter's mark, a project's status): shown at once, from the tap until Life's
/// reads after the write, then those reads alone. One tap per item at a time: a tap while that item's runs shows and
/// sends nothing, so nothing is shown that never reached Life.
@MainActor @Observable
public final class PendingTaps<Value: Sendable> {
    private var shown: [String: Value] = [:]

    public init() {}

    /// What the tap on `id` under way shows; nil when none is.
    public subscript(id: String) -> Value? { shown[id] }

    /// Shows `value` on `id` while `write` runs (the call, then the reads again); false, with nothing shown or run,
    /// while a tap on `id` runs.
    public func run(_ id: String, showing value: Value, _ write: @MainActor () async -> Void) async -> Bool {
        guard shown[id] == nil else { return false }
        shown[id] = value
        await write()
        shown[id] = nil
        return true
    }
}
