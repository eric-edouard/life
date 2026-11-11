import Foundation
import Library

/// One Apple Health measurement; each kind has its own unit and fields on the wire.
public struct AppleHealthMeasurement: Encodable, Sendable {
    public enum Kind: String, UnknownTolerant, Sendable {
        case sleep, workout, steps, weight, unknown
        case restingHeartRate = "resting_heart_rate"
        case heartRateVariability = "heart_rate_variability"
    }

    public enum Stage: String, UnknownTolerant, Encodable, Sendable {
        case awake, core, deep, rem, asleep, unknown
        case inBed = "in_bed"
    }

    public enum Content: Sendable {
        case sleep(Stage)
        case workout(activity: String, kcal: Double?)
        case steps(Double)
        case restingHeartRate(Double)
        case heartRateVariability(Double)
        case weight(Double)
    }

    public let id: String
    public let startAt: Date
    public let endAt: Date
    public let content: Content

    public init(id: String, startAt: Date, endAt: Date, content: Content) {
        self.id = id
        self.startAt = startAt
        self.endAt = endAt
        self.content = content
    }

    public var kind: Kind {
        switch content {
        case .sleep: .sleep
        case .workout: .workout
        case .steps: .steps
        case .restingHeartRate: .restingHeartRate
        case .heartRateVariability: .heartRateVariability
        case .weight: .weight
        }
    }

    enum CodingKeys: CodingKey { case id, kind, startAt, endAt, stage, activity, kcal, value }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind.rawValue, forKey: .kind)
        try container.encode(startAt, forKey: .startAt)
        try container.encode(endAt, forKey: .endAt)
        switch content {
        case .sleep(let stage): try container.encode(stage, forKey: .stage)
        case .workout(let activity, let kcal):
            try container.encode(activity, forKey: .activity)
            try container.encodeIfPresent(kcal, forKey: .kcal)
        case .steps(let value), .restingHeartRate(let value), .heartRateVariability(let value), .weight(let value):
            try container.encode(value, forKey: .value)
        }
    }

    /// Health holds the history; a new reader has no lower bound.
    public static func queryStartOf(syncedThrough: Date?) -> Date? {
        syncedThrough?.addingTimeInterval(-7 * 24 * 60 * 60)
    }

    /// End order makes each acknowledged chunk's last end a resumable cursor, even for overlapping sleeps.
    public static func chunksOf(_ measurements: [AppleHealthMeasurement]) -> [[AppleHealthMeasurement]] {
        let ordered = measurements.sorted { ($0.endAt, $0.id) < ($1.endAt, $1.id) }
        return stride(from: 0, to: ordered.count, by: 1000).map {
            Array(ordered[$0..<min($0 + 1000, ordered.count)])
        }
    }

    public static func stepsOf(startAt: Date, endAt: Date, value: Double) -> AppleHealthMeasurement {
        AppleHealthMeasurement(
            id: "steps:\(Int64(startAt.timeIntervalSince1970 * 1000))", startAt: startAt, endAt: endAt,
            content: .steps(value))
    }
}
