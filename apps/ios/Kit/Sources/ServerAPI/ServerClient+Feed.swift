import Foundation
import Glance
import Library
import Timeline

extension ServerClient {
    /// Whether the Mac can run language-model calls on the owner's subscription, and why not.
    public struct MacLLM: Sendable, Decodable, Equatable {
        public enum Reason: String, Sendable, UnknownTolerant {
            /// The Mac's login is missing or expired.
            case auth
            /// The subscription's usage limit is reached until it resets.
            case limit
            case unknown
        }

        public var able: Bool
        public var reason: Reason?

        public init(able: Bool, reason: Reason? = nil) {
            self.able = able
            self.reason = reason
        }
    }

    /// The feed's single values from the last complete pull (`LibraryStore.feedState`).
    public struct FeedState: Sendable, Equatable, Decodable {
        public struct Mac: Sendable, Equatable, Decodable {
            /// Since when the owner has been dictating to the Mac; `nil` when not.
            public var dictatingSince: Date?
            public var llm: MacLLM?
            /// The subscription limits the Mac last observed, for the Lock Screen dials.
            public var subscriptions: SubscriptionUsageSnapshot?

            public init(
                dictatingSince: Date? = nil, llm: MacLLM? = nil, subscriptions: SubscriptionUsageSnapshot? = nil
            ) {
                self.dictatingSince = dictatingSince
                self.llm = llm
                self.subscriptions = subscriptions
            }
        }

        public var mac: Mac?
        public var switches: Switches?
        /// The owner's words for transcription (people's names are the server's own).
        public var vocabulary: [String]?
        /// When the last complete pull ended; `nil` before the first.
        public var pulledAt: Date?

        public init(
            mac: Mac? = nil, switches: Switches? = nil, vocabulary: [String]? = nil, pulledAt: Date? = nil
        ) {
            self.mac = mac
            self.switches = switches
            self.vocabulary = vocabulary
            self.pulledAt = pulledAt
        }
    }
}

extension LibraryStore {
    /// The feed's single values; empty before the first pull.
    public func feed() throws -> ServerClient.FeedState {
        guard let data = try feedState() else { return ServerClient.FeedState() }
        return try LibraryStore.feedDecoder.decode(ServerClient.FeedState.self, from: data)
    }
}

extension ServerClient {
    /// One page of the feed after `cursor` (from the start without one), raw for `LibraryStore.apply`. `wait`:
    /// seconds the server may hold the request while nothing is newer. The cursor always goes: without it the server
    /// answers in its form from before the cutover.
    public func feed(since cursor: String?, wait: Int = 0) async throws -> Data {
        var request = try request("changes")
        request.url?.append(queryItems: [
            URLQueryItem(name: "since", value: cursor ?? "0"), URLQueryItem(name: "wait", value: "\(wait)"),
        ])
        if wait > 0 { request.timeoutInterval = TimeInterval(wait + 30) }
        return try await send(request)
    }
}
