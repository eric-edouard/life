import Foundation

/// "Am I recording?" in a few facts, for the surface that can't read the Pendant's status itself: the Watch. The phone decides how long the evidence stays current (`currentUntil`) when it builds a
/// glance; a surface only compares that with its clock, so it never says more than the phone knew.
public struct RecordingGlance: Codable, Hashable, Sendable {
    public enum Microphone: String, Codable, Sendable {
        case recording
        case paused
        case unrecognized
    }

    /// A pause or resume asked for in Life.
    public enum Request: String, Codable, Sendable {
        case pause
        case resume
    }

    /// What the Pendant's sound detector last said, with when.
    public enum Sound: String, Codable, Sendable {
        case hearing
        case quiet
    }

    public struct Pending: Codable, Hashable, Sendable {
        public var request: Request
        /// After this the request no longer counts as waiting: the app never heard back.
        public var until: Date

        public init(_ request: Request, until: Date) {
            self.request = request
            self.until = until
        }
    }

    public struct Heard: Codable, Hashable, Sendable {
        public var sound: Sound
        public var at: Date

        public init(_ sound: Sound, at: Date) {
            self.sound = sound
            self.at = at
        }
    }

    public var connected: Bool
    /// The Pendant's last report and when it made it; `nil` before the first.
    public var microphone: Microphone?
    public var reportedAt: Date?
    /// Until when the report counts as current. `nil` when it already doesn't (old, or not connected); `distantFuture`
    /// for a pause the link holds, which only the phone saying the link dropped ends.
    public var currentUntil: Date?
    public var pending: Pending?
    /// The last pause or resume was refused or never confirmed.
    public var failed: Request?
    /// The last level the Pendant reported, current or not: paused, off and out of reach look the same from the phone.
    public var battery: Int?
    /// Until when `battery` counts as current, like `currentUntil`; `nil` when it already doesn't.
    public var batteryCurrentUntil: Date?
    /// At or below the owner's low-battery threshold and not charging, when it was read.
    public var batteryLow: Bool
    /// Only while recording.
    public var heard: Heard?

    public init(
        connected: Bool, microphone: Microphone? = nil, reportedAt: Date? = nil, currentUntil: Date? = nil,
        pending: Pending? = nil, failed: Request? = nil, battery: Int? = nil, batteryCurrentUntil: Date? = nil,
        batteryLow: Bool = false, heard: Heard? = nil
    ) {
        self.connected = connected
        self.microphone = microphone
        self.reportedAt = reportedAt
        self.currentUntil = currentUntil
        self.pending = pending
        self.failed = failed
        self.battery = battery
        self.batteryCurrentUntil = batteryCurrentUntil
        self.batteryLow = batteryLow
        self.heard = heard
    }

    public enum Reading: Sendable, Equatable {
        /// Reported by a connected Pendant, recently enough to say it's so now.
        case confirmed(Microphone, at: Date)
        /// True when reported, maybe not now: the report is old or the Pendant isn't connected.
        case lastKnown(Microphone, at: Date)
        case unknown

        public var microphone: Microphone? {
            switch self {
            case .confirmed(let microphone, _), .lastKnown(let microphone, _): microphone
            case .unknown: nil
            }
        }
    }

    public func reading(now: Date) -> Reading {
        guard let microphone, let reportedAt else { return .unknown }
        let current = connected && currentUntil.map { now < $0 } == true
        return current ? .confirmed(microphone, at: reportedAt) : .lastKnown(microphone, at: reportedAt)
    }

    public func pendingRequest(now: Date) -> Request? {
        pending.flatMap { now < $0.until ? $0.request : nil }
    }

    public func batteryIsCurrent(now: Date) -> Bool { batteryCurrentUntil.map { now < $0 } == true }

    /// Low only while the level is current: an old low reading may have been charged since.
    public func batteryIsLow(now: Date) -> Bool { batteryLow && batteryIsCurrent(now: now) }

    /// When what this says turns out of date: the reading or the battery goes "last known", a request stops waiting.
    public var changeDates: [Date] { [currentUntil, pending?.until, batteryCurrentUntil].compactMap(\.self) }

    /// The Pendant reported recording, recently, and is connected.
    public func isRecording(now: Date) -> Bool {
        if case .confirmed(.recording, _) = reading(now: now) { true } else { false }
    }

    // MARK: Changes

    public enum Change: Sendable, Equatable {
        case none
        /// The same state, with evidence newer than the shown one by `refreshAfter`.
        case evidence
        /// Only the sound detector changed: hearing and quiet can alternate every few seconds.
        case sound
        /// Recording, connection, a request or low battery changed.
        case state
    }

    /// A sound-only change waits this long after the last send: speech and silence alternate every few seconds.
    public static let soundStep: TimeInterval = 60

    /// Newer evidence of an unchanged state is worth sending once the shown evidence is this old: half the phone's
    /// freshness window, so a refresh lands before the shown one goes stale, and at most one per window half.
    public static let refreshAfter: TimeInterval = 180

    /// What changed since `shown`, by what a surface shows. The battery and sound times move with every report and
    /// count only as evidence.
    public func change(from shown: RecordingGlance) -> Change {
        var same = self
        same.heard = shown.heard
        same.battery = shown.battery
        same.batteryCurrentUntil = shown.batteryCurrentUntil
        same.reportedAt = shown.reportedAt
        same.currentUntil = shown.currentUntil
        same.pending = shown.pending
        guard same == shown, pending?.request == shown.pending?.request else { return .state }
        if heard?.sound != shown.heard?.sound { return .sound }
        guard let reportedAt, let shownAt = shown.reportedAt, reportedAt.timeIntervalSince(shownAt) >= Self.refreshAfter
        else { return .none }
        return .evidence
    }
}
