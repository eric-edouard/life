import Foundation
import Library

/// An agent's session on pi, read-only (`read_agent_session`, the owner's decision 2 of 22 Nov 2026): pi has no app of
/// its own, so his app is where he reads one. Its newest lines, oldest first.
public struct AgentSession: Decodable, Sendable, Equatable, ParsedRead, NamesParties {
    public struct Line: Decodable, Sendable, Equatable {
        /// What a line is (`SessionLine.kind`, `host/agent-session-read.ts`; checked by `ContractTests`).
        public enum Kind: String, UnknownTolerant, Sendable {
            /// What Life sent it: its brief, a wake.
            case asked
            /// Its words.
            case said
            /// A tool it called: `tool` its name, `text` its arguments.
            case tool
            /// That tool's answer.
            case result
            /// Its session compacted.
            case summary
            case unknown
        }

        public let at: Date
        public let kind: Kind
        public let text: String
        public let tool: String?
        public let isError: Bool?
    }

    public let agent: String
    public let lines: [Line]

    public var parties: [Party] { [] }
}
