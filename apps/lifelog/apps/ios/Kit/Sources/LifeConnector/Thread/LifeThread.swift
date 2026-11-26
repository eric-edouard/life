import Foundation
import Observation

/// One exchange of the thread: his words and Life's answer to them, with a reaction each way. Life's own record of it
/// (`read_thread`'s entries) is the source; the phone holds an entry itself only until a read holds it: his ask under way,
/// waiting to go, failed or stopped, and an answer taken before the next read.
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
    /// Keys of the blocks the server streamed (`LifeBlock.key`): only these are drawn from the answer's fences.
    public var checked: [String] = []
    /// Life's reaction to his words, and his to Life's answer.
    public var lifeReaction: String?
    public var ownerReaction: String?
    public var why: String?
    /// The entry of his ask this one is a late reply to (an agent's), from Life's record.
    public var follows: Int?
    /// Work handed on from it, and every reaction on it, from Life's record.
    public var handed: [ThreadWireEntry.Handed]?
    public var reactions: [ThreadWireEntry.Reaction]?
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
    /// By entry: what the session is doing for each ask under way.
    public private(set) var live: [UUID: LiveAnswer] = [:]

    private let api: any LifeAPI
    private let cache: ReadCache?
    private let now: @Sendable () -> Date
    private var stopped: Set<UUID> = []
    /// Entries with a call under way: one call each, so a repeat never sends the same ask twice.
    private var flying: Set<UUID> = []
    /// His asks Life's record does not hold yet (or that its read cannot show): under way, waiting, failed, stopped, and an
    /// answer taken before the next read.
    private var pending: [ThreadEntry]
    /// Life's record of the thread as last read, and what it held before that window (older entries stay as they were).
    private var wire: [ThreadWireEntry]
    /// His reactions given since the last read, by entry: shown until Life's record says them.
    private var reacted: [Int: String] = [:]
    /// Failed entries of Life's record asked again as new asks: the old one is no longer shown.
    private var retried: Set<Int> = []
    private static let key = "thread"
    private static let kept = 300
    /// How long an ask Life's record holds with no answer is taken to be under way.
    private static let underWayFor: TimeInterval = 600

    /// What the cache keeps: only a copy of what is above.
    private struct Kept: Codable {
        var pending: [ThreadEntry]
        var wire: [ThreadWireEntry]
    }

    public init(api: any LifeAPI, cache: ReadCache? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        (self.api, self.cache, self.now) = (api, cache, now)
        let text = cache?.load(Self.key).map { Data($0.text.utf8) }
        let saved = text.flatMap { try? JSONDecoder().decode(Kept.self, from: $0) }
        // A call under way when the app closed is gone: its words go again under their key, so Life asks once.
        pending = (saved?.pending ?? text.flatMap { try? JSONDecoder().decode([ThreadEntry].self, from: $0) } ?? [])
            .map {
                var e = $0; if e.phase == .sending { e.phase = .waiting }; return e
            }
        wire = saved?.wire ?? []
    }

    /// Another Life: nothing of the last one's conversation stays.
    public func startOver() {
        (pending, wire, reacted, live, stopped, retried) = ([], [], [:], [:], [], [])
        cache?.clear()
    }

    /// The thread, oldest first: Life's record, then his asks it does not hold yet. A late reply of an agent is not in it
    /// (`lateReplies`).
    public var entries: [ThreadEntry] {
        let held = Set(pending.compactMap(\.entry))
        let record = wire.filter { w in
            w.follows == nil && !held.contains(w.id) && !retried.contains(w.id) && !pending.contains { isTheAsk($0, w) }
        }
        return (record.map(entry(of:)) + pending).enumerated()
            .sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }.map(\.element)
    }

    /// The late replies of an agent to his ask `entry` (Life's number), oldest first.
    public func lateReplies(to entry: Int) -> [ThreadEntry] {
        wire.filter { $0.follows == entry }.map(self.entry(of:))
    }

    /// Life's record of the thread, as a read gave it: the entries in its window replace what the phone held there, older
    /// ones stay. An ask the phone held that the record now holds is the record's.
    public func adopt(_ read: [ThreadWireEntry], asked: Date? = nil) {
        let from = (asked ?? now()).addingTimeInterval(-Self.window)
        wire = (wire.filter { w in w.at < from && !read.contains(where: { r in r.id == w.id }) } + read)
            .sorted { $0.at < $1.at }
        let numbers = Set(read.map(\.id))
        pending.removeAll { $0.phase == .answered && $0.entry.map(numbers.contains) == true }
        for (number, emoji) in reacted where read.first(where: { $0.id == number }).flatMap(Self.ownerReaction) == emoji
        {
            reacted[number] = nil
        }
        save()
    }

    /// The days one read of the thread holds (`PAGE_DAYS`, `host/life-thread.ts`), as seconds: older entries are the cache's.
    private static let window: TimeInterval = 3 * 86_400

    private func entry(of w: ThreadWireEntry) -> ThreadEntry {
        let tail = String(format: "%012d", w.id)
        let unanswered = w.answer == nil && w.error == nil
        let isOver = unanswered && now().timeIntervalSince(w.at) > Self.underWayFor
        var e = ThreadEntry(
            id: UUID(uuidString: "00000000-0000-0000-0000-\(tail)") ?? UUID(), at: w.at, words: w.words ?? "", key: "",
            phase: w.error != nil || isOver ? .failed : unanswered ? .sending : .answered)
        e.entry = w.id
        e.answer = w.answer
        e.refs = w.refs
        e.checked = w.answer.map(AnswerPart.blockKeys(of:)) ?? []
        e.lifeReaction = w.reactions.last { $0.by == "life" }?.with
        e.ownerReaction = reacted[w.id] ?? Self.ownerReaction(w)
        e.why = w.error ?? (isOver ? "Life did not answer." : nil)
        (e.follows, e.handed, e.reactions) = (w.follows, w.handed, w.reactions)
        return e
    }

    private static func ownerReaction(_ w: ThreadWireEntry) -> String? { w.reactions.last { $0.by == "owner" }?.with }

    /// Whether Life's record holds this ask of his, still unanswered: the same words, within a minute.
    private func isTheAsk(_ e: ThreadEntry, _ w: ThreadWireEntry) -> Bool {
        e.entry == nil && w.words == e.words && abs(w.at.timeIntervalSince(e.at)) < 60
    }

    /// Whether Life is answering something now (the edge's blue).
    public var isWorking: Bool { entries.contains { $0.phase == .sending } }

    /// His words, sent at once with what is on his screen. The call runs on; the entry shows its state.
    /// Whether the words were taken: none, when they are empty.
    @discardableResult public func ask(_ text: String, screen: MainSessionScreen) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        let entry = ThreadEntry(id: UUID(), at: now(), words: text, key: UUID().uuidString, phase: .sending)
        pending.append(entry)
        save()
        Task { await deliver(entry.id, screen: screen) }
        return true
    }

    /// His words that never reached Life, again, in order (the way back online).
    public func sendWaiting(screen: MainSessionScreen) async {
        for e in pending where e.phase == .waiting || (e.phase == .sending && !flying.contains(e.id)) {
            await deliver(e.id, screen: screen)
        }
    }

    /// A tap on his bubble when Life couldn't answer: the same words, as a new ask.
    public func askAgain(_ id: UUID, screen: MainSessionScreen) {
        if let at = pending.firstIndex(where: { $0.id == id }), pending[at].phase == .failed {
            (pending[at].phase, pending[at].key, pending[at].why) = (.sending, UUID().uuidString, nil)
        } else if let old = entries.first(where: { $0.id == id }), old.phase == .failed, let number = old.entry,
            old.follows == nil
        {
            // A failed entry of Life's record (its error, or no answer past `underWayFor`): the same words, as a new ask.
            retried.insert(number)
            pending.append(
                ThreadEntry(id: UUID(), at: now(), words: old.words, key: UUID().uuidString, phase: .sending))
            Task { await deliver(pending[pending.count - 1].id, screen: screen) }
            save()
            return
        } else {
            return
        }
        save()
        Task { await deliver(id, screen: screen) }
    }

    /// His Stop: the ask Life is on ends; the asks queued after it still run.
    public func stop() async {
        guard let running = pending.first(where: { $0.phase == .sending }) else { return }
        stopped.insert(running.id)
        _ = try? await api.askMainSession(.stop, answerKey: nil, onProgress: { _ in })
    }

    /// His reaction to an answer (one emoji; the same again takes it off the screen only, Life keeps its copy).
    public func react(_ id: UUID, with emoji: String) async {
        guard let number = entries.first(where: { $0.id == id })?.entry else { return }
        reacted[number] = emoji
        update(id) { $0.ownerReaction = emoji }
        save()
        _ = try? await api.askMainSession(.react(entry: number, with: emoji), answerKey: nil, onProgress: { _ in })
    }

    /// His presence on the screen: the session is kept warm, so his first words start at once.
    public func keepWarm() async {
        _ = try? await api.askMainSession(.present, answerKey: nil, onProgress: { _ in })
    }

    private func deliver(_ id: UUID, screen: MainSessionScreen) async {
        guard let e = pending.first(where: { $0.id == id }), flying.insert(id).inserted else { return }
        defer { flying.remove(id) }
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
        case .success(.reply(let number, let text, let refs, let reaction, _)):
            update(id) { e in
                (e.phase, e.entry, e.answer, e.refs) = (.answered, number, text, refs)
                e.lifeReaction = reaction ?? e.lifeReaction
            }
        case .success(.working): update(id) { $0.phase = .sending }
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
        case .block(let block, let key):
            live[id]?.parts.append(.block(block))
            update(id) { $0.checked.append(key) }
        case .reaction(let emoji): update(id) { $0.lifeReaction = emoji }
        }
    }

    private func update(_ id: UUID, _ change: (inout ThreadEntry) -> Void) {
        if let at = pending.firstIndex(where: { $0.id == id }) { change(&pending[at]) }
    }

    private func save() {
        pending = Array(pending.suffix(Self.kept))
        wire = Array(wire.suffix(Self.kept))
        if let data = try? JSONEncoder().encode(Kept(pending: pending, wire: wire)) {
            cache?.store(String(decoding: data, as: UTF8.self), key: Self.key)
        }
    }
}
