import Foundation
import Library

/// What `change_registered_agent` returns (`host/change-registered-agent.ts`): a start's stages and how it ended,
/// another change's `done` / `unconfirmed`, or a move's `asked` (its phase is then read on `read_matter`).
public struct AgentChangeResult: Decodable, Sendable, Equatable {
    public enum State: String, UnknownTolerant, Sendable {
        case started, done, unconfirmed, asked
        case notStarted = "not_started"
        case unknown
    }

    public struct Stage: Decodable, Sendable, Equatable {
        public let stage: String
        public let at: Date?
        public let session: String?
        public let link: String?
    }

    public struct Failure: Decodable, Sendable, Equatable {
        public let stage: String
        public let reason: String
    }

    public let action: String
    public let state: State
    public let agent: String?
    /// The runtime the desk took for a start: the one he picked, else its default.
    public let runtime: String?
    public let stages: [Stage]?
    public let failed: Failure?
    /// A start that did not happen left nothing running.
    public let nothingRunning: Bool?
    /// A move's id (`hand_over`, answered `asked`): his receipt, which the reads' move of that id then shows.
    public let move: String?

    public init(action: String, state: State, agent: String?, move: String? = nil) {
        (self.action, self.state, self.agent, self.move) = (action, state, agent, move)
        (runtime, stages, failed, nothingRunning) = (nil, nil, nil, nil)
    }
}
