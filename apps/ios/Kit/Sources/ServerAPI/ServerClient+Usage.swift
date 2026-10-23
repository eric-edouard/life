import Foundation
import Library
import Timeline

extension ServerClient {
    /// What was spent, from the server's own ledgers at list prices (openapi `UsageSummary`). Days are local to
    /// `timeZone`.
    public struct UsageSummary: Sendable, Decodable, Equatable {
        public struct Period: Sendable, Decodable, Equatable {
            public struct Transcription: Sendable, Decodable, Equatable {
                /// Billable hours at the base rate.
                public var hours: Double
                public var usd: Double
            }

            public struct Intelligence: Sendable, Decodable, Equatable {
                /// "claude-code", and "openai" or "anthropic" for older runs.
                public var byProvider: [String: Double]
                /// Runs on a model with no known price, not in `usd`.
                public var unpricedRuns: Int
                public var usd: Double
            }

            public struct Search: Sendable, Decodable, Equatable {
                /// Embedding tokens: passages indexed and queries.
                public var tokens: Int
                public var usd: Double
            }

            public var transcription: Transcription
            public var intelligence: Intelligence
            public var search: Search
            public var totalUsd: Double
        }

        public struct Day: Sendable, Decodable, Equatable {
            /// "2026-10-08".
            public var date: String
            public var spent: Period

            public init(from decoder: any Decoder) throws {
                enum Keys: String, CodingKey { case date }
                date = try decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .date)
                spent = try Period(from: decoder)
            }
        }

        /// ElevenLabs' own figure for its whole workspace, every key and app.
        public struct ProviderReport: Sendable, Decodable, Equatable {
            public var hours: Double
            public var usd: Double
        }

        public var timeZone: String
        public var today: Period
        public var last30Days: Period
        public var thisMonth: Period
        /// The last 30 days, oldest first, today last.
        public var days: [Day]
        /// Nil when ElevenLabs didn't answer.
        public var elevenLabsThisMonth: ProviderReport?
    }

    // MARK: Cost

    public func usageSummary() async throws -> UsageSummary {
        try decode(UsageSummary.self, try await send(try request("usage/summary")))
    }
}
