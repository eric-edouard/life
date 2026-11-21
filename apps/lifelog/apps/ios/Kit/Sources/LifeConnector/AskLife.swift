import Foundation
import Observation

/// What is on his screen when he talks to Life, as refs only (`MainSessionScreen`, `records/main-session-wire.ts`): never
/// text or pixels. The session opens them through its own reads.
public struct MainSessionScreen: Encodable, Sendable, Equatable {
    public var tab: String?
    public var open: String?

    public init(tab: String? = nil, open: String? = nil) {
        (self.tab, self.open) = (tab, open)
    }
}

/// One piece of work the main session reports as it goes: a tool call, a subagent or an agent it put to work.
public struct AskLifeStrand: Sendable, Equatable, Identifiable {
    public let id: String
    public var title: String
    public var state: String

    /// Whether it ended (any state but running).
    public var isDone: Bool { ["completed", "done", "failed"].contains(state) }
}

/// A line the session streams before its answer (`MainSessionLine`): that it thinks, a piece of work and its state, a
/// chunk of its words. A `working` line after words starts the words again: the answer is its text after its last tool call.
enum AskLifeStreamLine: Equatable {
    case thinking
    case working(AskLifeStrand)
    case words(String)

    init?(_ data: Data) {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let kind = object["kind"] as? String
        else { return nil }
        switch kind {
        case "thinking": self = .thinking
        case "words": self = (object["text"] as? String).map(Self.words) ?? .thinking
        case "working":
            guard let id = object["id"] as? String else { return nil }
            self = .working(
                AskLifeStrand(id: id, title: object["title"] as? String ?? "", state: object["state"] as? String ?? ""))
        default: return nil
        }
    }
}

/// The answer's kind, one of the closed list the server sends (`MainSessionAnswer`): `reply`, `question`, `error`, and
/// when the main session acted, its act's kind with its words: `done` (a correction, on a matter), `agent` (an agent
/// on his words: its name, the words it was told), `card` (a card in his Inbox) and `fix` (the caretaker has it).
/// `offline` is the phone's own state, `AskLife.Stage`. Words mark the one that matters in `**`. An answer's chips
/// only open refs or give words as his; it never carries a free action. A kind this build doesn't know is `unknown`,
/// said as such, never guessed at.
public enum AskLifeAnswer: Sendable, Equatable {
    case reply(words: String, why: String?, sources: [String])
    case question(question: String, answers: [String])
    case error(what: String)
    case done(words: String, matter: String?)
    case agent(words: String, agent: String, told: String)
    case card(words: String, card: String)
    case fix(words: String)
    case unknown

    init(_ text: String) {
        let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
        func string(_ key: String) -> String? { (o[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        func strings(_ key: String) -> [String] { o[key] as? [String] ?? [] }
        switch o["kind"] as? String {
        case "reply": self = .reply(words: string("words") ?? "", why: string("why"), sources: strings("sources"))
        case "question": self = .question(question: string("question") ?? "", answers: strings("answers"))
        case "error": self = .error(what: string("what") ?? "Life did not say why.")
        case "done": self = .done(words: string("words") ?? "", matter: string("matter"))
        case "agent":
            self = .agent(words: string("words") ?? "", agent: string("agent") ?? "", told: string("told") ?? "")
        case "card": self = string("card").map { .card(words: string("words") ?? "", card: $0) } ?? .unknown
        case "fix": self = .fix(words: string("words") ?? "")
        default: self = .unknown
        }
    }

    /// The one line the small player shows (key-word marks kept).
    public var line: String {
        switch self {
        case .reply(let words, _, _): words
        case .question(let question, _): question
        case .error(let what): what
        case .done(let words, _), .agent(let words, _, _), .card(let words, _), .fix(let words): words
        case .unknown: "Life answered in a way this app can't show yet."
        }
    }
}

/// What the answer puts before his eyes (`show`, `MainSessionShow`): one page, or a tab's list cut to the rows Life
/// named, under its words. It changes no data; the app applies it (`AppRouter.open(shown:)`). Nil for a shape this build
/// doesn't know: nothing shows, never a guess.
public enum AskLifeShow: Sendable, Equatable {
    public enum Page: String, Sendable { case matter, person, project, agent }
    case page(Page, id: String)
    case list(ShownList)

    init?(_ text: String) {
        let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
        guard let show = o?["show"] as? [String: Any] else { return nil }
        switch show["kind"] as? String {
        case "page":
            guard let page = (show["page"] as? String).flatMap(Page.init), let id = show["id"] as? String else {
                return nil
            }
            self = .page(page, id: id)
        case "list":
            guard let list = (show["list"] as? String).flatMap(ShownList.Kind.init),
                let refs = show["refs"] as? [String], let label = show["label"] as? String
            else { return nil }
            self = .list(ShownList(kind: list, refs: refs, label: label))
        default: return nil
        }
    }
}

/// A tab's list cut to the rows Life named (`refs`), under `label`, its words, until he closes it.
public struct ShownList: Sendable, Equatable {
    public enum Kind: String, Sendable { case matters, checks, people }
    public let kind: Kind
    public let refs: [String]
    public let label: String

    public init(kind: Kind, refs: [String], label: String) {
        (self.kind, self.refs, self.label) = (kind, refs, label)
    }

    /// The rows it names, in its order; a row gone since Life named it is left out.
    public func cut<Row>(_ rows: [Row], ref: (Row) -> String) -> [Row] {
        let byRef = Dictionary(rows.map { (ref($0), $0) }, uniquingKeysWith: { first, _ in first })
        return refs.compactMap { byRef[$0] }
    }
}

extension PeopleList {
    /// Only the people Ask Life named, in its order (the groups then sort them as ever); nil is everyone.
    public func cut(to cut: ShownList?) -> PeopleList {
        cut.map { PeopleList(people: $0.cut(people, ref: \.id)) } ?? self
    }
}

/// An answer's `show`, once per answer: the same show asked twice still applies twice.
public struct AskLifeShown: Sendable, Equatable {
    public let show: AskLifeShow
    public let answer: Int
}

extension String {
    /// The words with the key word's marks (`**`) taken out.
    public var withoutMarks: String { replacing("**", with: "") }
}

/// His Ask Life: one ongoing conversation with Life's main session (`ask_main_session`). He sends words, the session
/// streams what it does and says, and the call ends on its answer. A call that did not reach Life leaves his words
/// waiting, to go as they were (the same key, so Life asks once); nothing else is kept here.
@MainActor @Observable
public final class AskLife {
    public enum Stage: Equatable, Sendable {
        /// Nothing under way. After an answer, `answer` holds it.
        case ready
        /// Sent, nothing back yet.
        case thinking
        /// It works: strands, then its words as they arrive.
        case working
        /// This phone cannot reach Life: his words wait.
        case offline
    }

    public private(set) var stage = Stage.ready
    public private(set) var strands: [AskLifeStrand] = []
    /// The answer's words as they arrive; empty again when a piece of work starts after them.
    public private(set) var words = ""
    public private(set) var answer: AskLifeAnswer?
    /// What the last answer that showed something put before his eyes.
    public private(set) var shown: AskLifeShown?
    /// What he last said (the caption), and, after a call that did not go through, the words waiting to go again.
    public private(set) var said = ""
    public private(set) var waiting: String?

    private let api: any LifeAPI
    /// The key of the call whose outcome he doesn't know (its connection failed), with the words it was minted for.
    private var pending: (key: String, words: String)?
    private var isAsking = false

    public init(api: any LifeAPI) { self.api = api }

    /// Whether his words are on their way and no answer came yet.
    public var isBusy: Bool { isAsking }

    /// Sends his words with what is on screen; resolves once the answer (or why not) is in.
    public func send(_ text: String, screen: MainSessionScreen) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isAsking else { return }
        isAsking = true
        defer { isAsking = false }
        (said, words, answer, strands, waiting, stage) = (text, "", nil, [], nil, .thinking)
        // Only the same words go again under the old key: other words are another ask.
        let key = pending.flatMap { $0.words == text ? $0.key : nil } ?? UUID().uuidString
        let (lines, feed) = AsyncStream.makeStream(of: Data.self)
        // Lines are drawn in order, here, never from the call's own thread.
        let drawing = Task { for await data in lines { if let line = AskLifeStreamLine(data) { apply(line) } } }
        do {
            let result = try await api.askMainSession(
                words: text, screen: screen, answerKey: key, onProgress: { feed.yield($0) })
            feed.finish()
            await drawing.value
            pending = nil
            (answer, stage) = (AskLifeAnswer(result), .ready)
            if let show = AskLifeShow(result) { shown = AskLifeShown(show: show, answer: (shown?.answer ?? 0) + 1) }
        } catch {
            feed.finish()
            await drawing.value
            let failure = MCPError.of(error)
            switch failure {
            case .cancelled:
                (pending, stage, waiting) = ((key, text), .ready, text)
            case .offline, .unreachable, .timedOut, .streamDropped:
                // It may have gone: the same key goes with the same words, so Life asks once.
                if failure == .timedOut || failure == .streamDropped { pending = (key, text) }
                (stage, waiting) = (.offline, text)
            case .notPaired, .wrongCode, .refused, .failed:
                pending = nil
                (answer, stage, waiting) = (.error(what: failure.reason), .ready, text)
            }
        }
    }

    /// His waiting words, again (Try again, or the way back).
    public func sendAgain(screen: MainSessionScreen) async {
        if let waiting { await send(waiting, screen: screen) }
    }

    /// The Ask Life screen is open: the session is kept warm, so his first words start at once. Nothing is asked of
    /// it, and nothing shows: a session that can't be reached is found out when he speaks.
    public func keepWarm() async {
        guard !isAsking else { return }
        _ = try? await api.askMainSession(words: nil, screen: nil, answerKey: nil, onProgress: { _ in })
    }

    private func apply(_ line: AskLifeStreamLine) {
        switch line {
        case .thinking:
            if stage == .thinking { return }
        case .working(let strand):
            words = ""
            if let at = strands.firstIndex(where: { $0.id == strand.id }) {
                strands[at] = strand
            } else {
                strands.append(strand)
            }
        case .words(let text):
            words += text
        }
        stage = .working
    }
}
