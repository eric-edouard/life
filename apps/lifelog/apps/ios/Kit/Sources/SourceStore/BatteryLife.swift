import Foundation

/// The Pendant's battery level as the app saw it, and what the Pendant was doing. Stored only when either changes.
public struct BatteryReading: Sendable, Equatable {
    public enum State: String, Sendable {
        case recording
        case paused
        /// Charging, not connected, between a request and its answer, or the app was away: nothing to learn from.
        case unobserved
    }

    public var at: Date
    public var percent: Int
    public var state: State

    public init(at: Date, percent: Int, state: State) {
        self.at = at
        self.percent = percent
        self.state = state
    }

    /// What to store for a reading just seen, or `nil` when nothing changed. The first of a launch is stored as
    /// unobserved: nothing says what the Pendant did while the app was away.
    public func toStore(after last: BatteryReading?) -> BatteryReading? {
        guard let last else { return BatteryReading(at: at, percent: percent, state: .unobserved) }
        return last.percent == percent && last.state == state ? nil : self
    }
}

/// How fast the Pendant's battery drains while recording and while paused, learned from its readings.
///
/// Only whole steps count: the time from one drop of the level to the next, watched throughout in one state. A step
/// that spans a pause, a charge, a disconnection or a relaunch is dropped, since part of it happened unseen. Steps
/// weigh less with age, by half each week, so the estimate follows the last week as the Pendant ages.
public struct BatteryLife: Sendable, Equatable {
    /// Percent per hour; `nil` until enough was seen.
    public var recording: Double?
    public var paused: Double?

    /// A step a week old counts half.
    public static let halfLife: TimeInterval = 7 * 86_400
    /// Readings older than this weigh too little to read.
    public static let window: TimeInterval = 8 * 7 * 86_400
    /// ponytail: points of drop seen in a state before saying anything; the level moves in whole percents, so fewer
    /// is mostly rounding. Lower it if the paused estimate takes too long to show.
    public static let enoughDrop = 5

    public init(recording: Double? = nil, paused: Double? = nil) {
        self.recording = recording
        self.paused = paused
    }

    /// `readings` oldest first.
    public init(readings: [BatteryReading], now: Date) {
        var drop: [BatteryReading.State: Double] = [:]
        var hours: [BatteryReading.State: Double] = [:]
        var seen: [BatteryReading.State: Int] = [:]
        var anchor: BatteryReading?
        var previous: BatteryReading?
        for reading in readings {
            defer { previous = reading }
            // Watched in one state since the last reading, and not charged.
            guard reading.state != .unobserved, let previous, previous.state == reading.state,
                reading.percent <= previous.percent
            else {
                anchor = nil
                continue
            }
            guard reading.percent < previous.percent else { continue }
            if let anchor {
                let points = anchor.percent - reading.percent
                let weight = pow(0.5, now.timeIntervalSince(reading.at) / Self.halfLife)
                drop[reading.state, default: 0] += weight * Double(points)
                hours[reading.state, default: 0] += weight * reading.at.timeIntervalSince(anchor.at) / 3_600
                seen[reading.state, default: 0] += points
            }
            anchor = reading
        }
        func rate(_ state: BatteryReading.State) -> Double? {
            guard seen[state, default: 0] >= Self.enoughDrop, let hours = hours[state], hours > 0 else { return nil }
            return drop[state, default: 0] / hours
        }
        self.init(recording: rate(.recording), paused: rate(.paused))
    }

    /// How long `percent` lasts in that state, or `nil` without enough data.
    public func timeLeft(recording isRecording: Bool, from percent: Int) -> Duration? {
        guard let rate = isRecording ? recording : paused, rate > 0 else { return nil }
        return .seconds(Double(percent) / rate * 3_600)
    }
}
