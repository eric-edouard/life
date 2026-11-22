import Foundation

/// One touch on a field's microphone, as the dictation spec of 22 Nov reads it: a tap starts a run and keeps it going (a
/// tap on a run stops it), a hold talks while held, a slide up while holding arms Send, and a touch the system takes
/// away drops the run it started. Pure: the field feeds it the touch, `Dictation` does what it says.
public struct DictationPress: Equatable, Sendable {
    /// What the touch asks of the run.
    public enum Act: Equatable, Sendable { case start, stop, send, cancel }

    /// A touch still down this long is a hold.
    public static let holdAfter = 0.3
    /// How far up the thumb arms Send, and under which it disarms again (no chatter at the edge).
    public static let armAt = 56.0
    public static let disarmUnder = 44.0

    /// Whether the field has a Send: without one a slide arms nothing.
    public let canSend: Bool
    /// Since when the finger is down (seconds on any one clock), and whether a run was going then; nil when up.
    private var down: (at: Double, wasRunning: Bool)?
    public private(set) var isHolding = false
    /// How far up the thumb is from where it went down, 0 or more.
    public private(set) var rise = 0.0
    public private(set) var isArmed = false

    public init(canSend: Bool) { self.canSend = canSend }

    public var isDown: Bool { down != nil }

    /// How far the microphone follows the thumb: one to one up to `armAt`, then a third (it resists).
    public var lift: Double { rise < Self.armAt ? rise : Self.armAt + (rise - Self.armAt) / 3 }

    /// The finger went down; a run at rest starts at once (a hold talks from its first word).
    public mutating func press(at time: Double, isRunning: Bool) -> Act? {
        guard down == nil else { return nil }
        down = (time, isRunning)
        (isHolding, rise, isArmed) = (false, 0, false)
        return isRunning ? nil : .start
    }

    /// Called once `holdAfter` has passed since the press at `since`: the touch is a hold if it is still that one.
    public mutating func held(since time: Double) {
        if down?.at == time { isHolding = true }
    }

    /// The thumb moved: `up` is how far above where it went down. Only a hold with a Send arms.
    public mutating func move(up: Double) {
        guard down != nil else { return }
        rise = max(0, up)
        guard canSend, isHolding else { return }
        if rise >= Self.armAt { isArmed = true } else if rise < Self.disarmUnder { isArmed = false }
    }

    /// The finger is up.
    public mutating func release(at time: Double) -> Act? {
        guard let down else { return nil }
        let wasHold = isHolding || time - down.at >= Self.holdAfter
        let armed = isArmed
        reset()
        if armed { return .send }
        // A tap that started the run keeps it going; a tap on a run, or the end of a hold, stops it.
        return down.wasRunning || wasHold ? .stop : nil
    }

    /// The system took the touch (a scroll, an alert): the run it started is dropped, a run going or held stops.
    public mutating func takenAway() -> Act? {
        guard let down else { return nil }
        let wasHold = isHolding
        reset()
        return down.wasRunning || wasHold ? .stop : .cancel
    }

    private mutating func reset() {
        (down, isHolding, rise, isArmed) = (nil, false, 0, false)
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.canSend == rhs.canSend && lhs.down?.at == rhs.down?.at && lhs.down?.wasRunning == rhs.down?.wasRunning
            && lhs.isHolding == rhs.isHolding && lhs.rise == rhs.rise && lhs.isArmed == rhs.isArmed
    }
}
