import Foundation

/// Whether the server answers, as the pulls say it: a problem is shown once established (it survived a re-check, or the
/// owner's own check failed) and goes only on a success. Work called off, a request in flight, a refusal to start never
/// change it, so the status never blinks while a check runs.
public struct PullHealth: Equatable, Sendable {
    public private(set) var failures = 0
    public init() {}

    /// The last result was a failure, shown or not: what a Shortcut says.
    public var hasFailed: Bool { failures > 0 }
    /// What the screens show: a failure that persisted across a re-check.
    public var isEstablished: Bool { failures >= 2 }

    public mutating func succeeded() { failures = 0 }

    /// `isAsked`: the owner pressed Check, so one failure is the answer.
    public mutating func failed(_ error: any Error, isAsked: Bool = false) {
        if error is CancellationError { return }
        if let error = error as? URLError, !error.isTransient { return }
        failures = isAsked ? max(failures + 1, 2) : failures + 1
    }
}
