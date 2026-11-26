import Foundation
import Library

/// What a check is, for counting and for the card's look (`CheckGroup`, `core/names.ts`).
public enum CheckGroup: String, UnknownTolerant, Sendable {
    case decision, ending, name, voice, fix
    case contactsCard = "contacts card"
    case guessedPerson = "guessed person"
    case newMatter = "new matter"
    case samePerson = "same person"
    /// Someone of his directory whose Contacts card names an organization of it: "Is X at <organization>?"
    case atOrganization = "at organization"
    /// A matter's open step that is his: it stays in his inbox until done, handed over or put off.
    case yourMove = "your move"
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
        /// His pick of it alone writes the card's `event` need into his calendar, once (`adds`, "Add to calendar").
        public let adds: Bool?
        /// His pick of it alone starts the card's Apify run, once (`runs`, "Run it").
        public let runs: Bool?
        /// His pick of it alone is his word that he did the step: Life looks for it done (`looks`, "I've paid").
        public let looks: Bool?
        public let takes: Takes?
        /// A fix card's sign-in: the network whose sign-in sheet his tap opens, never an answer (`sign_in_to_network`).
        public let signsIn: String?
        /// His pick of it, alone and with no words, is his word that the card's step or matter is done: Life writes an
        /// `outdated` correction no code unsays, so the phone holds it for Undo wherever the card is shown.
        public let ends: Ends?

        public enum Ends: String, UnknownTolerant, Sendable {
            case step, matter
            case unknown
        }

        /// What a plan card's option is to his app (`role`): the start of the plan, or its decline.
        public let role: Role?

        /// Its answer icon (`answerIconOf`, `records/answer-icon.ts`): Life's act where Life acts, else the asker's pick.
        public let icon: AnswerIcon?

        public enum Role: String, UnknownTolerant, Sendable {
            case start, decline
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

    /// One line said: who, to whom, when, where, verbatim.
    public struct Said: Decodable, Sendable, Equatable {
        /// An instant, or a day (`2026-10-12`) when only the day is known.
        public let at: String?
        public let by: String?
        public let channel: String?
        public let text: String
        public let to: String?
    }

    public struct MatterRef: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        /// His mark on the matter: its pill carries a small flag.
        public let important: Bool?
    }

    /// A `life:` link in `context`: exactly the ref `fetch` opens, and what it names, for its glyph.
    public struct LifeLink: Decodable, Sendable, Equatable {
        /// What a ref names (`RefKind`, `memory/refs.ts`).
        public enum Kind: String, UnknownTolerant, Sendable {
            case appointment, ask, card, conversation, episode, file, matter, message, observation, person, turn, unit
            case unknown
        }
        public let ref: String
        public let kind: Kind
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
        /// The chat's last messages when the card was asked, oldest first (`[]` for a new chat; a mail's: the one it
        /// answers); nil on a card asked before Life stamped them, which then shows the draft alone.
        public let recent: [Recent]?
        /// How many people the chat holds, when it is a group (the head says "N people"); absent for one person.
        public let people: Int?
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
        /// Who Life holds the account to be: a person check's person, or whoever a draft's chat resolves to.
        public let party: Party?

        /// Field by field: one Life sends in a shape this build doesn't know is nil, never a failed inbox.
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            network = try? c.decodeIfPresent(String.self, forKey: .network)
            handle = try? c.decodeIfPresent(String.self, forKey: .handle)
            shownName = try? c.decodeIfPresent(String.self, forKey: .shownName)
            chat = try? c.decodeIfPresent(String.self, forKey: .chat)
            newest = try? c.decodeIfPresent(Newest.self, forKey: .newest)
            openUrl = (try? c.decodeIfPresent(String.self, forKey: .openUrl)).flatMap { $0.flatMap(URL.init(string:)) }
            party = try? c.decodeIfPresent(Party.self, forKey: .party)
        }

        private enum CodingKeys: String, CodingKey {
            case network, handle, shownName, chat, newest, openUrl, party
        }
    }

    /// What a card's answer changes: the facts, matters and pages that rest on it.
    public struct RidesOn: Decodable, Sendable, Equatable {
        public let observations: Int
        public let matters: Int
        public let pages: Int
        /// The matters it rides on, by id; nil from a Life that predates it.
        public let matterIds: [String]?
    }

    /// The matter this ask is on: its own, else the first it rides on.
    public var matterID: String? { matter?.id ?? ridesOn?.matterIds?.first }

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
    /// The registered agent that asked a decision (its `RegisteredAgent.id`); nil for Life's own checks, an agent
    /// asking through its own pairing, or from a Life that predates it.
    public let agent: String?
    public let at: Date?
    public let deadline: Date?
    public let onSilence: String?
    /// Why it asks, in Markdown (the context sheet), with `life:` links to Life's own things (`lifeLinks`).
    public let context: String?
    /// A new matter's goal, the one Start hands the agent.
    public let goal: String?
    public let draft: Draft?
    /// A draft card's chat as the card heads it; nil for other cards.
    public let head: Head?
    /// The older draft card into the same chat that this one replaces (his Send withdraws it); nil for most cards.
    public let replaces: String?
    /// A decision that is a plan card: it gives `plan`, its steps; nil on other kinds, or from a Life that predates
    /// it.
    public let isPlan: Bool?
    /// A plan card's steps, in order; nil on an older plan card, which shows as any decision.
    public let plan: [PlanStep]?
    /// A plan card's one line on what its plan rests on: the source chip that opens `context`.
    public let gathered: Gathered?

    /// One step of a plan (`PlanStep`, `memory/card-request.ts`): who does it, its words, when (a muted second line),
    /// and where it happens: a source as a draft's `channel`, or `payment`, `place`, `file`.
    public struct PlanStep: Decodable, Sendable, Equatable {
        public enum By: String, UnknownTolerant, Sendable {
            case agent, owner
            case unknown
        }
        public let text: String
        public let by: By
        public let when: String?
        public let channel: String?

        /// The row as VoiceOver reads it: who does it, when known, its words, when and where.
        public var spoken: String {
            let who: String? =
                switch by {
                case .owner: "You"
                case .agent: "The agent"
                case .unknown: nil
                }
            return ([who.map { "\($0): \(text)" } ?? text] + [when, channel].compactMap(\.self)).joined(separator: ", ")
        }
    }

    public struct Gathered: Decodable, Sendable, Equatable {
        public let text: String
    }

    /// The steps the card draws, whenever it holds them; a card with no steps (an older plan card too) draws as any
    /// decision.
    public var planSteps: [PlanStep] { plan ?? [] }
    /// The names a name check asks about, as they were said: shown in bold in `said`.
    public let about: [String]?
    /// The sentence the question is about (a name's line, a step's own sentence), verbatim.
    public let said: Said?
    /// An ending: what came since the open step.
    public let since: Said?
    /// The matters the answer rides on, by name.
    public let onMatters: [MatterRef]?
    public let options: [Option]
    /// The option a bulk ask starts this row ticked with (`preTickedOf`, the server's rule); nil: not ticked, or from a
    /// Life that predates it.
    public let preTicked: String?
    public let clips: [Clip]
    public let likelyPeople: [Party]
    public let links: [String]
    /// What its "Open in" opens: a registered agent's card, the session of the agent holding it now; any other ask, its
    /// first link; nil when none, or from a Life that predates it.
    public let session: String?
    /// The `life:` links of `context`, each with its kind; empty from a Life that predates them.
    public let lifeLinks: [LifeLink]?
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
    /// How Life sees a decision's step done now: `payment`, it looks in his accounts while the card is open; `tap`, only
    /// his word; nil on every other kind.
    public let doneSeenBy: DoneSeenBy?

    public enum DoneSeenBy: String, UnknownTolerant, Sendable {
        case payment, tap
        case unknown
    }

    /// Set on Life's own cards only, nil on an agent's: it offers "Wrong…", which opens Ask Life on the card.
    public let misread: Misread?
    /// His complaint about this card that the caretaker is at work on: it no longer blocks.
    public let beingFixed: BeingFixed?
    /// The ask this card belongs to (`read_thread`'s `ask`), and the option Life suggests (its id).
    public let ask: String?
    public let recommended: String?
    /// A redraft: the older card this one took the place of, and what changed (`changed`).
    public let replacedBy: String?
    /// A draft card's quick edits, a few words each ("More concise"): a tap redrafts (`MainSessionRequest.tap`).
    public let edits: [String]?
    /// His next asks, in his own voice ("Book the earliest one").
    public let follow: [String]?
    /// What a card that replaces an earlier one on its subject says changed; a redraft says how he asked it.
    public let changed: [Change]?

    /// What changed on a replacing card (`CHANGES`, `memory/card-request.ts`): `edit:tap` and `edit:words` mark a redraft.
    public enum Change: String, UnknownTolerant, Sendable {
        case deadline, condition, option, message
        case editTap = "edit:tap"
        case editWords = "edit:words"
        case unknown
    }

    /// What a card of Life's rests on (`causeOf`, `memory/complaint-checks.ts`).
    public struct Misread: Decodable, Sendable, Equatable {
        public let cause: String
    }

    /// His complaint at work (`BeingFixed`, `memory/life-checks.ts`): the caretaker's open card on it, its question
    /// (`line`) and its Markdown (`context`, with `life:` links); both nil when it has none, or holds more than one complaint.
    public struct BeingFixed: Decodable, Sendable, Equatable {
        public let ask: String
        public let since: Date?
        public let line: String?
        public let context: String?
    }

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

    /// Life asks it itself, or he asked it through his own app: no agent hears his words on it.
    public var isLifesOwn: Bool {
        agent == nil && ["life", "owner"].contains { asker.caseInsensitiveCompare($0) == .orderedSame }
    }

    /// Who hears his own words on it (decision 75), as the answer names it ("Tell the Personal agent"): its holder by
    /// its standing role, any other agent "the agent"; Life on Life's own question.
    public func hearer(among agents: [RegisteredAgent]) -> String {
        if isLifesOwn { return "Life" }
        switch agents.first(where: { $0.id == agent })?.role {
        case .personal?: return "the Personal agent"
        case .caretaker?: return "the caretaker"
        default: return "the agent"
        }
    }

    /// The words of what opens his own words on it: "Tell the agent…", or "Ask Life…" on Life's own question.
    public var ownWordsTitle: String { isLifesOwn ? "Ask Life…" : "Tell the agent…" }

    /// A context as he opened it, copied at his tap: an inbox refresh never empties or replaces an open sheet.
    public struct OpenedContext: Identifiable, Equatable, Sendable {
        public let title: String
        public let markdown: String
        /// Its `life:` links' kinds; none for the caretaker's, whose links open by ref all the same.
        public let lifeLinks: [LifeLink]
        /// What its "Open in" opens; nil for the caretaker's.
        public let session: String?

        public var id: String { markdown }
    }

    /// The card's own context, as its link opens it.
    public var ownContext: OpenedContext {
        OpenedContext(
            title: contextLinkTitle ?? "", markdown: context ?? "", lifeLinks: lifeLinks ?? [], session: session)
    }

    /// The caretaker's open question's context, under that question; nil with none.
    public var fixContext: OpenedContext? {
        guard let line = beingFixed?.line, let context = beingFixed?.context else { return nil }
        return OpenedContext(title: line, markdown: context, lifeLinks: [], session: nil)
    }

    /// The words of the link that opens its context: the code's, by what it asks, never the agent's (the context
    /// sheet's table, decision 81); nil with no context, so a card with none has no link.
    public var contextLinkTitle: String? {
        guard let context, !context.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        if draft != nil { return "Why this reply?" }
        switch group {
        case .ending: return "Why done?"
        case .newMatter, .yourMove: return "What Life saw"
        case .guessedPerson, .name, .voice, .contactsCard, .samePerson, .atOrganization:
            let name = networkIdentity?.shownName ?? askedName ?? contactsCard?.name ?? likelyPeople.first?.name
            return name.map { "Why \($0)?" } ?? "Why this person?"
        case .decision, .fix, .unknown: return "Why it asks"
        }
    }

    /// The options in the order the answers draw them: a plan's start first (its asker may send decline first), the
    /// rest as sent.
    public var optionsInOrder: [Option] {
        options.filter { $0.role == .start } + options.filter { $0.role != .start }
    }

    /// The option the card fills (the first in order): the one answer it asks for, the others sit quieter.
    public var filled: Option? { optionsInOrder.first }

    /// The kind of bulk card this ask folds into: a same person ask joins the guessed people's (one screen of "Is this
    /// X?" rows, the same person one first); any other is its own group's.
    public var bulkKind: CheckGroup { group == .samePerson ? .guessedPerson : group }

    /// The person a guess row asks about: who Life holds the account to be, else the name the question gives.
    public var guessedName: String {
        if let name = networkIdentity?.party?.name ?? likelyPeople.first?.name { return name }
        return question.replacingOccurrences(of: "Is this ", with: "").replacingOccurrences(of: "?", with: "")
    }

    /// The option the row starts ticked with in a bulk ask, when Life pre-ticks one this card offers.
    public var preTickedOption: Option? { options.first { $0.id == preTicked } }

    /// Rows of a bulk ask in its groups: the rows Life ticks nothing on first ("Needs you": only he can answer them),
    /// then one per pre-ticked option, in the order they first come.
    public static func bulkGroups(_ checks: [Check]) -> [[Check]] {
        let ids = checks.compactMap(\.preTicked).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        return ([nil] + ids.map(Optional.some)).map { id in checks.filter { $0.preTicked == id } }
            .filter { !$0.isEmpty }
    }

    /// The option he picks by naming someone (`takes` a person, or a person or a name), when the card has one.
    public var namingOption: Option? { options.first { $0.takes == .person || $0.takes == .personOrName } }

    /// Whether the card's own answer is the naming one: then its candidates are drawn as people.
    public var isNamingFilled: Bool { namingOption != nil && filled?.id == namingOption?.id }

    /// His answer by one tap on `option`: nil when that option needs more than the tap (a person, a name or his words).
    /// A your move card's "Hand over" hands over the goal it shows, as a new matter's Start does.
    public func answer(_ option: Option) -> AnswerRequest? {
        guard option.takes == nil else { return nil }
        let goal = isHandOver(option) ? self.goal : nil
        return AnswerRequest(ref: ref, options: [option.id], note: goal)
    }

    /// Whether `option` starts an agent on the card's matter: a new matter's Start, a your move's Hand over.
    public func isHandOver(_ option: Option) -> Bool {
        option.id == "start" && (group == .newMatter || group == .yourMove)
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

    /// A voice's answers that are no option of the card: "Me", his own person; and "TV or video" (`media`: Life accepts it
    /// though the card no longer lists it). Nothing is ever pre-selected; each is one tap.
    public var answerMe: AnswerRequest? { answer(naming: .person("person:me")) }
    public var answerMedia: AnswerRequest { AnswerRequest(ref: ref, options: ["media"]) }
    public var answerDontName: AnswerRequest { AnswerRequest(ref: ref, options: ["not-relevant"]) }

    /// The people a voice may be, never him (he is "Me", always first), `recent` (named earlier in the run) first.
    public func voiceGuesses(recent: [Party]) -> [Party] {
        (recent + likelyPeople).filter { !$0.isOwner }.reduce(into: []) { all, party in
            if !all.contains(where: { $0.ref == party.ref }) { all.append(party) }
        }
    }

    /// Who "Someone else…" offers (the people sheet): the card's likely people first, then everyone else he knows
    /// (`everyone`, the People list: his directory and everyone with a page), never him, and no organization on a voice.
    public func peopleToPick(among everyone: [Party]) -> [Party] {
        let rest = everyone.filter { party in
            !party.isOwner && !likelyPeople.contains { $0.ref == party.ref }
                && (group != .voice || party.kind != .organization)
        }
        return likelyPeople + rest
    }

    /// The name a name card asks about, whole: the longest of `about`, as said. Only a name card's `about` is a name (a
    /// Contacts card's holds its handles).
    public var askedName: String? { group == .name ? about?.max { $0.count < $1.count } : nil }

    /// A name card whose new name is a party he adds (`partyNamed`): a new name opens the create sheet. A voice's new
    /// name goes to lifelog alone, so it is answered by the name as typed.
    public var createsBySheet: Bool { group == .name && namingOption?.takes == .personOrName }

    /// A name card with no one to suggest: its answer is "Create <name>", which opens the create sheet.
    public var createsByName: Bool { createsBySheet && likelyPeople.isEmpty && askedName != nil }

    /// The option that says the name is an organization (`organization`, `memory/life-checks.ts`), on a name card.
    public var organizationOption: Option? { group == .name ? options.first { $0.id == "organization" } : nil }
    /// Whether his tap on `option` opens the create sheet set to an organization instead of answering: "Organization" on a
    /// card that creates by sheet, so its name and what it is are his to see first. It takes nothing more on the wire.
    public func createsOrganizationBySheet(_ option: Option) -> Bool {
        createsBySheet && option.id == organizationOption?.id
    }

    /// Whether `text` is still Life's `guess`: the same words, whatever the spaces around and between them. The one
    /// test, for the sheet's "Life's guess" and for the note it sends.
    public static func isGuess(_ text: String, _ guess: String?) -> Bool {
        let words = { (text: String) in text.split(whereSeparator: \.isWhitespace) }
        guard let guess, !words(text).isEmpty else { return false }
        return words(text) == words(guess)
    }

    /// His answer from the create sheet: the person (through the naming option that takes a name) or the organization
    /// he named, with his words for who or what it is only when he wrote them: `note` goes, trimmed, only when it is not
    /// empty and not Life's `guess` (`isGuess`).
    public func answer(creating name: String, note: String?, guess: String? = nil, asOrganization: Bool)
        -> AnswerRequest?
    {
        guard createsBySheet, let name = name.wordsOrNil else { return nil }
        let note = note?.wordsOrNil.flatMap { Self.isGuess($0, guess) ? nil : $0 }
        let option = asOrganization ? organizationOption : namingOption
        return option.map { AnswerRequest(ref: ref, options: [$0.id], note: note, name: name) }
    }

    /// His own words: with the option he picked that takes them (`option`), else a decision's note (no option); a new
    /// matter's goal goes with its own option that takes them.
    public func answer(words: String, option: String? = nil) -> AnswerRequest? {
        let picked = options.first { $0.takes == .note && (group == .decision ? $0.id == option : true) }
        if let picked {
            return AnswerRequest(ref: ref, options: [picked.id], note: words)
        }
        return group == .decision ? AnswerRequest(ref: ref, options: [], note: words) : nil
    }

    /// Whether "Something else" is offered: an agent reads a decision's own words; Life's own checks take only their
    /// options (a new matter's goal comes through its option that takes a note).
    public var takesOwnWords: Bool { group == .decision }
    /// Whether `request` leaves this card open: a new matter's goal, edited (Life saves it; Start or Dismiss still wait).
    /// Another kind's option of the same id closes it like any answer.
    public func keepsOpen(after request: AnswerRequest) -> Bool {
        group == .newMatter && request.options == ["edit-goal"]
    }

    /// Whether `request` is his word that the step or matter is done: one option that `ends`, alone, with no words.
    public func isEnding(_ request: AnswerRequest) -> Bool {
        guard request.note == nil, request.options.count == 1 else { return false }
        return options.contains { $0.id == request.options[0] && $0.ends != nil }
    }

    /// The program of the registered agent that asked it (`agent`), while the phone still lists that agent; nil for
    /// any other ask, which then shows no program rather than a guessed one.
    public func askingRuntime(among agents: [RegisteredAgent]) -> RuntimeName? {
        agent.flatMap { id in agents.first { $0.id == id }?.runtimeName }
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

extension String {
    /// The words, trimmed; nil when there are none.
    fileprivate var wordsOrNil: String? {
        let words = trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? nil : words
    }
}

extension CheckGroup {
    /// The bulk card's question.
    public var bulkQuestion: String {
        switch self {
        case .ending: "Are these done?"
        case .voice: "Voices to name"
        case .guessedPerson: "Are these the right people?"
        default: "Answer these?"
        }
    }

    /// A group's heading on the bulk card, by the answer Life pre-ticks on it (nil: none); nil draws none.
    public func bulkHeading(_ preTicked: String?) -> String? {
        switch (self, preTicked) {
        case (_, nil): "Needs you"
        case (.ending, "outdated"): "Look done"
        default: nil
        }
    }
}

/// An answer icon: each key Life sends (`ANSWER_ICONS`, `apps/server/src/records/answer-icon.ts`: `ContractTests`
/// checks), with its SF Symbol; `agent` is the asking agent's mark, drawn by the app. A key this build doesn't know
/// draws nothing.
public enum AnswerIcon: String, UnknownTolerant, Sendable {
    case send, done, agent, start, no, later, drop, open, person, people, organization, link, hide, date, place
    case addToCalendar = "add_to_calendar"
    case unknown

    /// The SF Symbol; nil for `agent` (the app draws the agent's mark) and for a key it doesn't know.
    public var symbol: String? {
        switch self {
        case .send: "paperplane"
        case .addToCalendar: "calendar.badge.plus"
        case .done: "checkmark"
        case .start: "play.fill"
        case .no: "xmark"
        case .later: "clock"
        case .drop: "trash"
        case .open: "arrow.up.right"
        case .person: "person"
        case .people: "person.2"
        case .organization: "building.2"
        case .link: "link"
        case .hide: "eye.slash"
        case .date: "calendar"
        case .place: "mappin"
        case .agent, .unknown: nil
        }
    }
}
