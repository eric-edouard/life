import Foundation
import Library

/// What a check is, for counting and for the card's look (`CheckGroup`, `core/names.ts`).
public enum CheckGroup: String, UnknownTolerant, Sendable {
    case decision, ending, name, voice
    case contactsCard = "contacts card"
    case guessedPerson = "guessed person"
    case newMatter = "new matter"
    case unknown
}

/// Whether a check blocks (a worker waits on him, or Life cannot answer at all) or only improves (Life already uses its guess, or asks whether a step is done): `urgencyOf`, `memory/check-urgency.ts`. Kept for the inbox screen, which draws the line between what blocks and what can wait from it.
public enum Urgency: String, UnknownTolerant, Sendable {
    case blocks, improves
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
        /// His pick of it, alone and with no words, is his word that the card's step or matter is done: Life writes an
        /// `outdated` correction no code unsays, so the phone holds it for Undo wherever the card is shown.
        public let ends: Ends?

        public enum Ends: String, UnknownTolerant, Sendable {
            case step, matter
            case unknown
        }
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
        /// Its words as lifelog times them (contract `TimedWords`), lit while it plays through `words.spokenIndex(at:)` and `words.ranges(in:)`.
        public let words: [[Int64]]?

        /// How long it plays, "0:08": from its recording's span; nil when the clip holds no audio.
        public var lengthText: String? {
            audio.map { audio in
                let seconds = Int((audio.end - audio.start).rounded())
                return "\(seconds / 60):" + String(format: "%02d", seconds % 60)
            }
        }
    }

    public struct Person: Decodable, Sendable, Equatable {
        /// Who they are to him, one line (a relation), when Life knows it.
        public let line: String?
        public let name: String
        public let person: String
    }

    /// One line said: who, to whom, when, where, verbatim.
    public struct Said: Decodable, Sendable, Equatable {
        /// An instant, or a day (`2026-10-12`) when only the day is known.
        public let at: String?
        public let by: String?
        public let channel: String?
        public let text: String
        public let to: String?
    }

    /// The lines of its conversation just before and after the sentence.
    public struct Around: Decodable, Sendable, Equatable {
        public let after: [Said]
        public let before: [Said]
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

    /// A Contacts card as Life holds it (`contactsCard`, `memory/check-asks.ts`): never a network identity, a card has no chat.
    public struct ContactsCard: Decodable, Sendable, Equatable {
        public let name: String
        public let handles: [String]
    }

    /// Who a person check is about, or the chat a decision's draft goes into, as the network shows it (`NetworkIdentity`, `memory/network-identity.ts`).
    public struct NetworkIdentity: Decodable, Sendable, Equatable {
        public struct Newest: Decodable, Sendable, Equatable {
            public let at: Date?
            public let by: String?
            public let text: String?
        }
        /// WhatsApp, iMessage, LINE…
        public let network: String?
        /// The number or id on that network.
        public let handle: String?
        /// The name the network shows for the contact or chat.
        public let shownName: String?
        /// The chat, as `read_chats` takes it.
        public let chat: String?
        public let newest: Newest?
        /// The network's own link that opens the chat (`wa.me` for WhatsApp); nil when it has none.
        public let openUrl: URL?

        /// Field by field: one Life sends in a shape this build doesn't know is nil, never a failed inbox.
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            network = try? c.decodeIfPresent(String.self, forKey: .network)
            handle = try? c.decodeIfPresent(String.self, forKey: .handle)
            shownName = try? c.decodeIfPresent(String.self, forKey: .shownName)
            chat = try? c.decodeIfPresent(String.self, forKey: .chat)
            newest = try? c.decodeIfPresent(Newest.self, forKey: .newest)
            openUrl = (try? c.decodeIfPresent(String.self, forKey: .openUrl)).flatMap { $0.flatMap(URL.init(string:)) }
        }

        private enum CodingKeys: String, CodingKey {
            case network, handle, shownName, chat, newest, openUrl
        }
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
    /// Absent in a fixture or a read kept before Life sent it.
    public let urgency: Urgency?
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
    /// The names a name check asks about, as they were said: shown in bold in `said`.
    public let about: [String]?
    /// The sentence the question is about (a name's line, a step's own sentence), verbatim.
    public let said: Said?
    /// An ending: what came since the open step.
    public let since: Said?
    /// A name: lines of its conversation before and after the sentence.
    public let around: Around?
    /// The matters the answer rides on, by name.
    public let onMatters: [MatterRef]?
    public let options: [Option]
    public let clips: [Clip]
    public let likelyPeople: [Person]
    public let links: [String]
    public let matter: MatterRef?
    public let subject: String?
    public let ridesOn: RidesOn?
    /// Who a person check is about, or the chat a decision's draft goes into, as the network shows it; nil for other kinds,
    /// when none was found, or from a Life that predates it.
    public let networkIdentity: NetworkIdentity?
    /// A Contacts card's own name and handles; nil for every other kind, or from a Life that predates it.
    public let contactsCard: ContactsCard?
    /// A decision whose draft goes to someone Life only guesses: that guess, asked beside it. A check holding one is a Check itself, so it is an array.
    public let confirm: [Check]?
    /// What he needs in hand to do the step, each drawn as rows (`Need`); nil from a Life that predates it.
    public let needs: [Need]?
    /// Life's outcome when it sees the step done itself (a payment it looks for); nil when it does not.
    public let doneSeen: DoneSeen?

    /// Life's outcome on a step it sees done itself (`doneSeen`, the asks contract): never his answer.
    public struct DoneSeen: Decodable, Sendable, Equatable {
        public enum State: String, UnknownTolerant, Sendable {
            case looking, seen
            case notFound = "not_found"
            case unknown
        }
        public let state: State
        /// Life's words for it, which win over the phone's.
        public let line: String?
    }
}

extension Check {
    /// The agent that asks, in his words: its runtime, else the asker's own name; nil when Life asks itself.
    public func agentName(runtime: RuntimeName?) -> String? {
        if let runtime { return runtime.name }
        return asker.caseInsensitiveCompare("life") == .orderedSame ? nil : asker
    }

    /// The option the card fills (the first): the one answer it asks for, the others sit quieter.
    public var filled: Option? { options.first }

    /// The option he picks by naming someone (`takes` a person, or a person or a name), when the card has one.
    public var namingOption: Option? { options.first { $0.takes == .person || $0.takes == .personOrName } }

    /// Whether the card's own answer is the naming one: then its candidates are drawn as people.
    public var isNamingFilled: Bool { namingOption != nil && filled?.id == namingOption?.id }

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
    /// Whether `request` is his word that the step or matter is done: one option that `ends`, alone, with no words.
    public func isEnding(_ request: AnswerRequest) -> Bool {
        guard request.note == nil, request.options.count == 1 else { return false }
        return options.contains { $0.id == request.options[0] && $0.ends != nil }
    }

    /// Its draft goes to someone Life only guesses: the guess is asked beside it (`confirm`).
    public var isRecipientGuessed: Bool { !(confirm ?? []).isEmpty }
}

extension String {
    /// Where `names` stand in these words as whole words, whatever their case or accents.
    public func ranges(ofNames names: [String]) -> [Range<String.Index>] {
        names.filter { !$0.isEmpty }.flatMap { name in
            var found: [Range<String.Index>] = []
            var from = startIndex
            while let range = range(
                of: name, options: [.caseInsensitive, .diacriticInsensitive], range: from..<endIndex)
            {
                let before = range.lowerBound > startIndex ? self[index(before: range.lowerBound)] : nil
                let after = range.upperBound < endIndex ? self[range.upperBound] : nil
                if !(before?.isLetter ?? false) && !(after?.isLetter ?? false) { found.append(range) }
                from = range.upperBound
            }
            return found
        }
    }
}

/// Who he says it is: someone Life knows, or a new name.
public enum Naming: Sendable, Equatable {
    case person(String)
    case name(String)
}
