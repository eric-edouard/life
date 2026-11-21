import Foundation

/// Whether Life can be reached now, the one rule: the phone's network path, and how the newest settled read of Life
/// ended. Out of reach, the app is read-only: no tap acts, and every read screen says why. One per pairing.
public struct LifeConnection: Sendable, Equatable {
    /// How the newest settled read found no way to Life (`.offline` or `.unreachable`); nil once Life answered one.
    public private(set) var lost: MCPError?
    /// When that read was asked: reads of different kinds overlap, so an older one landing late changes nothing.
    private var asked = Date.distantPast

    public init() {}

    /// A read's event, the read asked at `asked`. Only a value or Life's refusal says Life answered; a start, a cancel,
    /// "not paired", a 5xx (a tunnel's, with the Mac asleep), a timeout or a dropped stream say nothing about it, so
    /// what the last read found holds.
    public mutating func note<V>(_ event: ReadState<V>.Event, asked: Date) {
        guard !(asked < self.asked) else { return }
        switch event {
        case .failed(.unreachable): lost = .unreachable
        case .failed(.offline): lost = .offline
        case .succeeded, .failed(.refused): lost = nil
        default: return
        }
        self.asked = asked
    }

    /// Why Life cannot be reached now, in words for a screen; nil when it can.
    public func whyNot(hasPath: Bool) -> String? {
        if !hasPath || lost == .offline { return MCPError.offline.reason }
        return lost == .unreachable ? MCPError.unreachable.reason : nil
    }
}
