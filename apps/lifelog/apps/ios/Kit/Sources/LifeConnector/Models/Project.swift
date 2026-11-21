import Foundation
import Library

/// `read_projects`: the Projects tab's chip row, in the order the server gives (the phone does not sort). The list under a
/// chip is `read_matters` (`project`, or `area` with `noProject`).
public struct ProjectChips: Decodable, Sendable, Equatable {
    public struct Counts: Decodable, Sendable, Equatable {
        public let needYou: Int
        public let open: Int
    }

    public struct Chip: Decodable, Sendable, Equatable {
        public enum Kind: String, UnknownTolerant, Sendable {
            case project, area
            case unknown
        }

        public let kind: Kind
        /// The id a request names; an area's and a project's can be the same word, so a list keys on `identity`.
        public let id: String
        public let name: String
        /// A project's, as stored; an area has none.
        public let status: ProjectStatus?
        /// A project's area id (the phone shows its icon); an area has none.
        public let area: String?
        public let needYou: Int
        public let agentAtWork: Bool
        public var identity: String { Self.identity(kind, id) }
        public static func identity(_ kind: Kind, _ id: String) -> String { "\(kind.rawValue):\(id)" }
        /// What the list under the chip holds.
        public let matters: Int
    }

    public let all: Counts
    public let chips: [Chip]
    public let version: String?

    /// How many projects are underway: the tab's state word ("3 underway").
    public var underway: Int { chips.filter { $0.kind == .project && $0.status?.isUnderway == true }.count }
}

/// `read_project`: a project chip's header and its Details.
public struct ProjectHeader: Decodable, Sendable, Equatable {
    public struct Head: Decodable, Sendable, Equatable {
        public struct Agent: Decodable, Sendable, Equatable, Identifiable {
            public let id: String
            public let title: String
            /// `running` or `waiting`.
            public let status: String
            public let line: String
        }

        /// The question that waits on him, as a card (`ref`): the phone opens it as a sheet.
        public struct Ask: Decodable, Sendable, Equatable {
            public let ref: String
            public let question: String
            public let deadline: Date?
            public let matter: Check.MatterRef?
        }

        public struct Chat: Decodable, Sendable, Equatable {
            public let key: String
            public let name: String
        }

        /// His goal naming the project: its place among his goals.
        public struct Goal: Decodable, Sendable, Equatable {
            public let text: String
            public let rank: Int
            public let of: Int
        }

        /// One line of where it stands: Life's reading of its matters, with the matter steps it cites (`cites`).
        public struct SituationLine: Decodable, Sendable, Equatable {
            public let text: String
            public let cites: [String]
        }

        public struct Repo: Decodable, Sendable, Equatable {
            public let name: String
            /// The main worktree on the Mac; none for a repo only on GitHub.
            public let folder: String?
        }

        public let id: String
        public let name: String
        public let status: ProjectStatus
        public let goal: Goal?
        public let situation: [SituationLine]
        public let ask: Ask?
        public let agents: [Agent]
        public let people: [Party]
        public let chats: [Chat]
        public let repos: [Repo]
    }

    public let project: Head
    public let version: String?
}

extension ProjectHeader: NamesParties, ParsedRead {
    public var parties: [Party] { project.people }
}

extension ProjectChips: NamesParties, ParsedRead {
    public var parties: [Party] { [] }
}
