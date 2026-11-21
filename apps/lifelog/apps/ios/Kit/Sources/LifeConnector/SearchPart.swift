/// One source the search asks (the running matters, the people and organizations) as it stands for what is on
/// screen: its rows once read (a stale read too), or still reading, or failed (Try again reads it again). Each source
/// stands alone, so one that failed never hides another's rows.
public enum SearchPart<Rows: Collection & Sendable>: Sendable {
    case reading
    case failed
    case found(Rows)

    /// The part of a read: what `rows` takes from its value once read, else failed or still reading (a read not
    /// asked yet, or of another query, is reading).
    public init<Value>(_ state: ReadState<Value>?, rows: (Value) -> Rows) {
        if let value = state?.value {
            self = .found(rows(value))
        } else {
            self = state?.hasFailed == true ? .failed : .reading
        }
    }

    /// Its rows, once read.
    public var found: Rows? {
        if case .found(let rows) = self { rows } else { nil }
    }

    /// Read and holding nothing: only then may the search say nothing holds what he typed.
    public var isNothing: Bool { found?.isEmpty == true }
}
