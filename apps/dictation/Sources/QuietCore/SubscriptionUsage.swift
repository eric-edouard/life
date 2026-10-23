import Foundation

/// Only percentages and reset times leave the Mac. No session payload, identity or credential is retained here.
public struct SubscriptionReading: Codable, Equatable, Sendable {
    public struct Window: Codable, Equatable, Sendable {
        public var usedPercent: Double
        public var resetsAt: Double

        public init?(usedPercent: Double, resetsAt: Double) {
            guard usedPercent.isFinite, (0...100).contains(usedPercent), resetsAt.isFinite,
                (0...253_402_300_799).contains(resetsAt)
            else { return nil }
            self.usedPercent = usedPercent
            self.resetsAt = resetsAt
        }
    }

    public var fiveHour: Window?
    public var sevenDay: Window?
    public var observedAt: Double

    /// Claude Code's documented statusLine input. Missing limits are unknown, not an unused subscription.
    public static func claude(_ data: Data, now: Date = .now) -> Self? {
        struct Input: Decodable {
            struct Limits: Decodable {
                struct Reading: Decodable {
                    var used_percentage: Double
                    var resets_at: Double
                    var window: Window? { Window(usedPercent: used_percentage, resetsAt: resets_at) }
                }
                var five_hour: Reading?
                var seven_day: Reading?
            }
            var rate_limits: Limits?
        }
        guard let input = try? JSONDecoder().decode(Input.self, from: data), let limits = input.rate_limits else {
            return nil
        }
        let reading = Self(
            fiveHour: limits.five_hour?.window, sevenDay: limits.seven_day?.window,
            observedAt: now.timeIntervalSince1970)
        return reading.fiveHour != nil || reading.sevenDay != nil ? reading : nil
    }

    /// The documented account/rateLimits/read response. Select Codex's bucket, and identify windows by duration.
    public static func codex(_ data: Data, now: Date = .now) -> Self? {
        struct Reply: Decodable {
            struct Result: Decodable {
                struct Limits: Decodable {
                    struct Reading: Decodable {
                        var usedPercent: Double
                        var resetsAt: Double
                        var windowDurationMins: Int
                        var window: Window? { Window(usedPercent: usedPercent, resetsAt: resetsAt) }
                    }
                    var limitId: String?
                    var primary: Reading?
                    var secondary: Reading?
                }
                var rateLimits: Limits?
                var rateLimitsByLimitId: [String: Limits]?
            }
            var result: Result?
        }
        guard let result = try? JSONDecoder().decode(Reply.self, from: data).result else { return nil }
        let limits =
            result.rateLimitsByLimitId?["codex"]
            ?? result.rateLimits.flatMap {
                $0.limitId == nil || $0.limitId == "codex" ? $0 : nil
            }
        guard let limits else { return nil }
        let windows = [limits.primary, limits.secondary].compactMap { $0 }
        let reading = Self(
            fiveHour: windows.first { $0.windowDurationMins == 300 }?.window,
            sevenDay: windows.first { $0.windowDurationMins == 10_080 }?.window,
            observedAt: now.timeIntervalSince1970)
        return reading.fiveHour != nil || reading.sevenDay != nil ? reading : nil
    }

    public func message(engine: String) -> String? {
        struct Message: Encodable {
            var type = "subscription.usage"
            var engine: String
            var reading: SubscriptionReading
        }
        return (try? JSONEncoder().encode(Message(engine: engine, reading: self)))
            .map { String(decoding: $0, as: UTF8.self) }
    }
}
