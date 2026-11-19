import Foundation
import Library

/// What a check is, for counting and for the card's look (`CheckGroup`, `memory/checks.ts`).
public enum CheckGroup: String, UnknownTolerant, Sendable {
    case decision, ending, name, voice
    case contactsCard = "contacts card"
    case guessedPerson = "guessed person"
    case newMatter = "new matter"
    case unknown
}

/// One thing waiting on the owner's word, the same shape for every kind (`Check`, `memory/checks.ts`). Only what a
/// screen draws or answers with is read; a field Life adds is ignored, one it takes away that is listed here is a
/// failing fixture test.
public struct Check: Decodable, Sendable, Equatable, Identifiable {
    public struct Option: Decodable, Sendable, Equatable {
        /// What his answer must carry besides the option (`CheckOption.takes`, `memory/life-checks.ts`).
        public enum Takes: String, UnknownTolerant, Sendable {
            case person, note
            case personOrName = "person or name"
            case unknown
        }

        public let id: String
        /// His button's words.
        public let label: String
        /// Choosing it sends, pays, books, deletes or changes something.
        public let outgoing: Bool?
        public let takes: Takes?
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
    /// A new matter's goal, the one Start hands the agent.
    public let goal: String?
    public let evidence: Evidence?
    public let draft: Draft?
    public let options: [Option]
    public let clips: [Clip]
    public let likelyPeople: [Person]
    public let links: [String]
    public let matter: MatterRef?
    public let subject: String?
    public let ridesOn: RidesOn?
    /// A decision whose draft goes to someone Life only guesses: that guess, asked beside it. A check holding one is a Check itself, so it is an array.
    public let confirm: [Check]?
}

extension Check {
    /// Who asks, in his words: the agent's runtime, else Life (a voice from the pendant), else the asker's own name.
    public func askerName(runtime: RuntimeName?) -> String {
        if let runtime { return runtime.name }
        guard asker.caseInsensitiveCompare("life") == .orderedSame else { return asker }
        return group == .voice ? "Life, from the pendant" : "Life"
    }

    /// The option he picks by naming someone (`takes` a person, or a person or a name), when the card has one.
    public var namingOption: Option? { options.first { $0.takes == .person || $0.takes == .personOrName } }

    /// His answer by one tap on `option`: nil when that option needs more than the tap (a person, a name or his words).
    public func answer(_ option: Option) -> AnswerRequest? {
        option.takes == nil ? AnswerRequest(ref: ref, options: [option.id]) : nil
    }

    /// His answer naming who it is, through the option that takes it: a person Life knows, or a typed name, which is a
    /// new person where the option takes a name (a voice) and someone Life knows by it otherwise.
    public func answer(naming choice: Naming) -> AnswerRequest? {
        guard let option = namingOption else { return nil }
        switch choice {
        case .person(let id): return AnswerRequest(ref: ref, options: [option.id], person: id)
        case .name(let name) where option.takes == .personOrName:
            return AnswerRequest(ref: ref, options: [option.id], name: name)
        case .name(let name): return AnswerRequest(ref: ref, options: [option.id], person: name)
        }
    }

    /// His own words: a decision's note (no option), or the option that takes them (a new matter's goal).
    public func answer(words: String) -> AnswerRequest? {
        if let option = options.first(where: { $0.takes == .note }) {
            return AnswerRequest(ref: ref, options: [option.id], note: words)
        }
        return group == .decision ? AnswerRequest(ref: ref, options: [], note: words) : nil
    }

    /// Whether "Something else" is offered: an agent reads a decision's own words; Life's own checks take only their
    /// options (a new matter's goal comes through its option that takes a note).
    public var takesOwnWords: Bool { group == .decision }
}

/// Who he says it is: someone Life knows, or a new name.
public enum Naming: Sendable, Equatable {
    case person(String)
    case name(String)
}
