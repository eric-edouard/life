import Foundation

/// A small rolling record of background wakes for the hardware test: when the app ran in the background, for how
/// long, and what it saved. Counts and times only, never audio or content. Kept on the phone.
public struct WakeLog: Codable, Sendable, Equatable {
    public struct Wake: Codable, Sendable, Equatable {
        public var start: Date
        /// The last capture status update of the wake: its length is a lower bound of the time the app ran.
        public var end: Date
        public var saved = SavedPages()
    }

    /// Updates closer than this belong to one wake. iOS gives a Bluetooth wake about 10 s.
    public static let gap: TimeInterval = 10
    public static let limit = 200

    public private(set) var wakes: [Wake] = []

    public init() {}

    /// Notes a capture status update made in the background. Returns whether it opened a new wake.
    @discardableResult
    public mutating func record(saved: SavedPages, previous: SavedPages, at: Date) -> Bool {
        let opened = wakes.last.map { at.timeIntervalSince($0.end) > Self.gap } ?? true
        if opened { wakes = Array((wakes + [Wake(start: at, end: at)]).suffix(Self.limit)) }
        wakes[wakes.count - 1].end = at
        wakes[wakes.count - 1].saved.pushed += saved.pushed - previous.pushed
        wakes[wakes.count - 1].saved.pulled += saved.pulled - previous.pulled
        wakes[wakes.count - 1].saved.duplicates += saved.duplicates - previous.duplicates
        wakes[wakes.count - 1].saved.bytes += saved.bytes - previous.bytes
        return opened
    }
}
