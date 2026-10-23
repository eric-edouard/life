import Foundation

/// The feed's `mac.subscriptions`: the server validated both windows on the way in and out.
public struct SubscriptionUsageSnapshot: Decodable, Equatable, Sendable {
    public var claude: SubscriptionUsage?
    public var codex: SubscriptionUsage?
}

/// Account-wide quota evidence from a provider, not the app's own token count. Wire times are Unix seconds.
public struct SubscriptionUsage: Codable, Equatable, Sendable {
    public struct Window: Codable, Equatable, Sendable {
        public var usedPercent: Double
        public var resetsAt: TimeInterval

        public init(usedPercent: Double, resetsAt: TimeInterval) {
            self.usedPercent = usedPercent
            self.resetsAt = resetsAt
        }

        public func hasReset(now: Date) -> Bool { now.timeIntervalSince1970 >= resetsAt }

        /// Small enough for a circular Lock Screen widget. Never a negative countdown or an invented next window.
        public func countdown(now: Date) -> String {
            let remaining = resetsAt - now.timeIntervalSince1970
            guard remaining > 0 else { return "↻" }
            if remaining >= 86_400 { return "\(Int(remaining / 86_400))D" }
            let minutes = max(1, Int(ceil(remaining / 60)))
            return minutes >= 60 ? "\(minutes / 60)H \(minutes % 60)M" : "\(minutes)M"
        }
    }

    public var observedAt: TimeInterval
    public var fiveHour: Window?
    public var sevenDay: Window?

    public init(observedAt: TimeInterval, fiveHour: Window? = nil, sevenDay: Window? = nil) {
        self.observedAt = observedAt
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
    }

    /// How long a dial's timeline runs before it reads the app group again.
    public static let refreshInterval: TimeInterval = 30 * 60
    public static let staleAfter: TimeInterval = 60 * 60

    public func isStale(now: Date) -> Bool { now.timeIntervalSince1970 - observedAt >= Self.staleAfter }
}
