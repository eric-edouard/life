import Foundation
import Observation

/// What is on his screen when he talks to Life, as refs only (`MainSessionScreen`, `records/main-session-wire.ts`): never
/// text or pixels. The session opens them through its own reads.
public struct TellScreen: Encodable, Sendable, Equatable {
    public var tab: String?
    public var open: String?
    public var visible: [String]?

    public init(tab: String? = nil, open: String? = nil, visible: [String]? = nil) {
        (self.tab, self.open, self.visible) = (tab, open, visible)
    }
}

/// One piece of work the main session reports as it goes: a tool call, a subagent or an agent it put to work.
public struct TellStrand: Sendable, Equatable, Identifiable {
    public let id: String
    public var title: String
    public var state: String

    /// Whether it ended (any state but running).
    public var isDone: Bool { ["completed", "done", "failed"].contains(state) }
}

/// A line the session streams before its answer (`MainSessionLine`): that it thinks, a piece of work and its state, a
/// chunk of its words. A `working` line after words starts the words again: the answer is its text after its last tool call.
enum TellLine: Equatable {
    case thinking
    case working(TellStrand)
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
                TellStrand(id: id, title: object["title"] as? String ?? "", state: object["state"] as? String ?? ""))
        default: return nil
        }
    }
}

/// The answer's kind, one of a closed list the phone draws natively (`MainSessionAnswer`). A kind this build doesn't
/// know is `unknown`, said as such, never guessed at.
public enum TellAnswer: Sendable, Equatable {
    case reply(words: String)
    case error(what: String)
    case unknown

    init(_ text: String) {
        let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
        switch object["kind"] as? String {
        case "reply": self = .reply(words: object["words"] as? String ?? "")
        case "error": self = .error(what: object["what"] as? String ?? "Life did not say why.")
        default: self = .unknown
        }
    }
}

/// His Tell Life: one ongoing conversation with Life's main session (`ask_main_session`). He sends words, the session
/// streams what it does and says, and the call ends on its answer. A call that did not reach Life leaves his words
/// waiting, to go as they were (the same key, so Life asks once); nothing else is kept here.
@MainActor @Observable
public final class TellLife {
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
    public private(set) var strands: [TellStrand] = []
    /// The answer's words as they arrive; empty again when a piece of work starts after them.
    public private(set) var words = ""
    public private(set) var answer: TellAnswer?
    /// What he last said (the caption), and, after a call that did not go through, the words waiting to go again.
    public private(set) var said = ""
    public private(set) var waiting: String?

    private let api: any LifeAPI
    /// The key of the call whose outcome he doesn't know (its connection failed): the same words go again under it.
    private var pendingKey: String?
    private var isAsking = false

    public init(api: any LifeAPI) { self.api = api }

    /// Whether his words are on their way and no answer came yet.
    public var isBusy: Bool { isAsking }

    /// Sends his words with what is on screen; resolves once the answer (or why not) is in.
    public func send(_ text: String, screen: TellScreen) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isAsking else { return }
        isAsking = true
        defer { isAsking = false }
        (said, words, answer, strands, waiting, stage) = (text, "", nil, [], nil, .thinking)
        let key = pendingKey ?? UUID().uuidString
        let (lines, feed) = AsyncStream.makeStream(of: Data.self)
        // Lines are drawn in order, here, never from the call's own thread.
        let drawing = Task { for await data in lines { if let line = TellLine(data) { apply(line) } } }
        do {
            let result = try await api.askMainSession(
                words: text, screen: screen, answerKey: key, onProgress: { feed.yield($0) })
            feed.finish()
            await drawing.value
            pendingKey = nil
            (answer, stage) = (TellAnswer(result), .ready)
        } catch {
            feed.finish()
            await drawing.value
            let failure = MCPError.of(error)
            switch failure {
            case .cancelled:
                (stage, waiting) = (.ready, text)
            case .offline, .unreachable, .timedOut, .streamDropped:
                // It may have gone: the same key goes with the same words, so Life asks once.
                if failure == .timedOut || failure == .streamDropped { pendingKey = key }
                (stage, waiting) = (.offline, text)
            case .notPaired, .wrongCode, .refused, .failed:
                pendingKey = nil
                (answer, stage, waiting) = (.error(what: failure.reason), .ready, text)
            }
        }
    }

    /// His waiting words, again (Try again, or the way back).
    public func sendAgain(screen: TellScreen) async {
        if let waiting { await send(waiting, screen: screen) }
    }

    /// The Tell Life screen is open: the session is kept warm, so his first words start at once. Nothing is asked of
    /// it, and nothing shows: a session that can't be reached is found out when he speaks.
    public func keepWarm() async {
        guard !isAsking else { return }
        _ = try? await api.askMainSession(words: nil, screen: nil, answerKey: nil, onProgress: { _ in })
    }

    private func apply(_ line: TellLine) {
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
