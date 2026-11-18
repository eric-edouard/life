import Foundation
import Library

/// What a check is, for counting and for the card's look (`CheckGroup`, `memory/checks.ts`).
public enum CheckGroup: String, UnknownTolerant, Sendable {
    case decision, ending, card, name, voice
    case guessedPerson = "guessed person"
    case newMatter = "new matter"
    case unknown
}

/// One thing waiting on the owner's word, the same shape for every kind (`Check`, `memory/checks.ts`). Only what a
/// screen draws or answers with is read; a field Life adds is ignored, one it takes away that is listed here is a
/// failing fixture test.
public struct Check: Decodable, Sendable, Equatable, Identifiable {
    public struct Option: Decodable, Sendable, Equatable {
        public let id: String
        public let label: String
        /// Choosing it sends, pays, books, deletes or changes something.
        public let outgoing: Bool?
    }

    public struct Clip: Decodable, Sendable, Equatable {
        public struct Audio: Decodable, Sendable, Equatable {
            public let jobId: String
            public let start: Double
            public let end: Double
        }
        public let at: Date?
        public let until: Date?
        public let text: String
        public let audio: Audio?
    }

    public struct Person: Decodable, Sendable, Equatable {
        public let name: String
        public let person: String
    }

    public struct MatterRef: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
    }

    public struct Evidence: Decodable, Sendable, Equatable {
        public let from: String
        public let quote: String
    }

    /// The exact message he approves.
    public struct Draft: Decodable, Sendable, Equatable {
        public struct File: Decodable, Sendable, Equatable {
            public let name: String
            public let size: Int
            public let mime: String?
        }
        public struct Quoted: Decodable, Sendable, Equatable {
            public let sender: String
            public let subject: String?
            public let text: String
        }
        public struct Mention: Decodable, Sendable, Equatable {
            public let name: String
        }
        public let to: String
        public let channel: String?
        public let text: String?
        public let reaction: String?
        public let file: File?
        public let quoted: Quoted?
        public let mentions: [Mention]?
        public let from: String?
        public let cc: String?
        public let subject: String?
    }

    /// What a card's answer changes: the facts, matters and pages that rest on it.
    public struct RidesOn: Decodable, Sendable, Equatable {
        public let observations: Int
        public let matters: Int
        public let pages: Int
    }

    public var id: String { ref }
    public let ref: String
    /// An opaque id of this card that a push carries (never its `ref`).
    public let pushId: String?
    public let group: CheckGroup
    public let title: String
    public let question: String
    public let asker: String
    public let at: Date?
    public let deadline: Date?
    public let onSilence: String?
    public let context: String?
    public let evidence: Evidence?
    public let draft: Draft?
    public let options: [Option]
    public let clips: [Clip]
    public let likelyPeople: [Person]
    public let links: [String]
    public let matter: MatterRef?
    public let subject: String?
    public let ridesOn: RidesOn?
}
