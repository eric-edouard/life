import Foundation
import Observation

/// One exchange of the thread: his words and Life's answer to them, with a reaction each way. Kept on the phone so the
/// thread opens as he left it; Life keeps its own copy on the Mac (`read_thread` takes this one's place when it lands).
public struct ThreadEntry: Identifiable, Equatable, Sendable, Codable {
    public enum Phase: String, Sendable, Codable {
        /// Sent, no answer yet (it may be waiting its turn behind another ask).
        case sending
        /// Not sent: no Mac or no internet. Goes as it was when it can.
        case waiting
        case answered
        /// Life didn't answer (`why`); a tap on his bubble asks again.
        case failed
        /// He pressed Stop while it ran.
        case stopped
    }

    public let id: UUID
    public let at: Date
    public let words: String
    /// The key that makes a retry ask once.
    public var key: String
    public var phase: Phase
    /// Life's number for this entry once it answered: what a reaction names.
    public var entry: Int?
    /// Life's answer: Markdown, with its blocks fenced (`AnswerPart.parts`).
    public var answer: String?
    public var refs: [String] = []
    /// Life's reaction to his words, and his to Life's answer.
    public var lifeReaction: String?
    public var ownerReaction: String?
    public var why: String?
}

/// What the session is doing for one ask as it streams: the step it is on, and the answer so far.
public struct LiveAnswer: Equatable, Sendable {
    public struct Step: Equatable, Sendable {
        public let verb, what: String
    }
    public var step: Step?
    public var parts: [AnswerPart] = []
}

/// His one conversation with Life's main session (`ask_main_session`). He sends words; the session streams its steps and
/// its answer, and the call ends on the answer. An ask sent while another runs waits its turn on the Mac. Nothing here
/// acts for him: his words are only words, and a reaction starts no turn.
@MainActor @Observable
public final class LifeThread {
    public private(set) var entries: [ThreadEntry]
    /// By entry: what the session is doing for each ask under way.
    public private(set) var live: [UUID: LiveAnswer] = [:]

    private let api: any LifeAPI
    private let cache: ReadCache?
    private let now: @Sendable () -> Date
    private var stopped: Set<UUID> = []
    private static let key = "thread"
    private static let kept = 300

    public init(api: any LifeAPI, cache: ReadCache? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        (self.api, self.cache, self.now) = (api, cache, now)
        let saved = cache?.load(Self.key).flatMap {
            try? JSONDecoder().decode([ThreadEntry].self, from: Data($0.text.utf8))
        }
        // A call under way when the app closed is gone: its words go again under their key, so Life asks once.
        entries = (saved ?? []).map {
            var e = $0; if e.phase == .sending { e.phase = .waiting }; return e
        }
    }

    /// Another Life: nothing of the last one's conversation stays.
    public func startOver() {
        (entries, live, stopped) = ([], [:], [])
        cache?.clear()
    }

    /// Whether Life is answering something now (the edge's blue).
    public var isWorking: Bool { entries.contains { $0.phase == .sending } }

    /// His words, sent at once with what is on his screen. The call runs on; the entry shows its state.
    public func ask(_ text: String, screen: MainSessionScreen) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let entry = ThreadEntry(id: UUID(), at: now(), words: text, key: UUID().uuidString, phase: .sending)
        entries.append(entry)
        save()
        Task { await deliver(entry.id, screen: screen) }
    }

    /// His words that never reached Life, again, in order (the way back online).
    public func sendWaiting(screen: MainSessionScreen) async {
        for e in entries where e.phase == .waiting { await deliver(e.id, screen: screen) }
    }

    /// A tap on his bubble when Life couldn't answer: the same words, as a new ask.
    public func askAgain(_ id: UUID, screen: MainSessionScreen) {
        guard let at = entries.firstIndex(where: { $0.id == id }), entries[at].phase == .failed else { return }
        (entries[at].phase, entries[at].key, entries[at].why) = (.sending, UUID().uuidString, nil)
        save()
        Task { await deliver(id, screen: screen) }
    }

    /// His Stop: the ask Life is on ends; the asks queued after it still run.
    public func stop() async {
        guard let running = entries.first(where: { $0.phase == .sending }) else { return }
        stopped.insert(running.id)
        _ = try? await api.askMainSession(.stop, answerKey: nil, onProgress: { _ in })
    }

    /// His reaction to an answer (one emoji; the same again takes it off the screen only, Life keeps its copy).
    public func react(_ id: UUID, with emoji: String) async {
        guard let at = entries.firstIndex(where: { $0.id == id }), let number = entries[at].entry else { return }
        entries[at].ownerReaction = emoji
        save()
        _ = try? await api.askMainSession(.react(entry: number, with: emoji), answerKey: nil, onProgress: { _ in })
    }

    /// His presence on the screen: the session is kept warm, so his first words start at once.
    public func keepWarm() async {
        _ = try? await api.askMainSession(.present, answerKey: nil, onProgress: { _ in })
    }

    private func deliver(_ id: UUID, screen: MainSessionScreen) async {
        guard let e = entries.first(where: { $0.id == id }) else { return }
        update(id) { $0.phase = .sending }
        live[id] = LiveAnswer()
        let (lines, feed) = AsyncStream.makeStream(of: Data.self)
        // Lines are drawn in order, here, never from the call's own thread.
        let drawing = Task { for await data in lines { if let line = MainSessionLine(data) { apply(line, to: id) } } }
        let outcome: Result<MainSessionResult, Error>
        do {
            let text = try await api.askMainSession(
                .ask(e.words, screen: screen), answerKey: e.key, onProgress: { feed.yield($0) })
            outcome = .success(MainSessionResult(text))
        } catch {
            outcome = .failure(error)
        }
        feed.finish()
        await drawing.value
        live[id] = nil
        let wasStopped = stopped.remove(id) != nil
        switch outcome {
        case .success(.reply(let number, let text, let refs, let reaction)):
            update(id) { e in
                (e.phase, e.entry, e.answer, e.refs) = (.answered, number, text, refs)
                e.lifeReaction = reaction ?? e.lifeReaction
            }
        case .success(.error(let what, let number)):
            update(id) { e in
                (e.phase, e.why, e.entry) = (wasStopped ? .stopped : .failed, what, number)
            }
        case .failure(let error):
            switch MCPError.of(error) {
            // It may have gone: the same key goes with the same words, so Life asks once.
            case .cancelled, .offline, .unreachable, .timedOut, .streamDropped: update(id) { $0.phase = .waiting }
            case let failure: update(id) { ($0.phase, $0.why) = (.failed, failure.reason) }
            }
        }
        save()
    }

    private func apply(_ line: MainSessionLine, to id: UUID) {
        switch line {
        case .thinking: break
        case .step(let verb, let what): live[id] = LiveAnswer(step: .init(verb: verb, what: what))
        case .words(let text):
            guard var l = live[id] else { return }
            if case .markdown(let before)? = l.parts.last {
                l.parts[l.parts.count - 1] = .markdown(before + text)
            } else {
                l.parts.append(.markdown(text))
            }
            live[id] = l
        case .block(let block): live[id]?.parts.append(.block(block))
        case .reaction(let emoji): update(id) { $0.lifeReaction = emoji }
        }
    }

    private func update(_ id: UUID, _ change: (inout ThreadEntry) -> Void) {
        if let at = entries.firstIndex(where: { $0.id == id }) { change(&entries[at]) }
    }

    private func save() {
        entries = Array(entries.suffix(Self.kept))
        if let data = try? JSONEncoder().encode(entries) {
            cache?.store(String(decoding: data, as: UTF8.self), key: Self.key)
        }
    }
}
