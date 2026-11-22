import Foundation
import Observation

extension ServerClient {
    /// A single-use ElevenLabs realtime token (`POST /live-words/token`): the key stays on the Mac.
    public func liveWordsToken() async throws -> String {
        struct Token: Decodable { var token: String }
        return try decode(Token.self, try await send(try request("live-words/token", method: "POST"))).token
    }
}

/// One message of ElevenLabs' realtime speech-to-text, as far as the phone reads it.
enum LiveWordsMessage: Equatable {
    case partial(String), committed(String), nothingToCommit, failed

    init?(_ text: String) {
        let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
        switch o["message_type"] as? String {
        case "partial_transcript": self = .partial(o["text"] as? String ?? "")
        case "committed_transcript": self = .committed(o["text"] as? String ?? "")
        // The last commit found under 0.3 s of audio left (all of it committed already): the words are complete.
        case "commit_throttled", "insufficient_audio_activity": self = .nothingToCommit
        case "session_started", "warning", nil: return nil
        default: self = .failed  // error, auth_error, quota_exceeded, rate_limited, ...
        }
    }
}

/// The realtime socket as `LiveWords` uses it: text frames out and in (`receive` gives nil once it closed), and its
/// close. `URLSession`'s in the app (`webSocket`); a test passes its own.
struct LiveWordsSocket {
    let send: (String) -> Void
    let receive: () async -> String?
    let close: (_ isNormal: Bool) -> Void
}

/// One word of instant dictation as the field shows it, and when it began to show: its fade starts then.
public struct LiveWord: Equatable, Sendable {
    public let text: String
    public let at: Date
}

/// Instant dictation: while his `dictationHeard` switch is `instant`, the 16 kHz microphone stream goes to ElevenLabs'
/// realtime Scribe over one socket per run (a fresh single-use token each time), its words show in the field as they
/// come, and at the pause they are the ones that land (`finish`). Any failure stops it; the Mac then hears the run's
/// recording, today's path. One microphone at a time, so one stream.
@MainActor @Observable
public final class LiveWords {
    public static let shared = LiveWords()

    private let makeSocket: (URL) -> LiveWordsSocket
    /// How long the stream stays quiet after a commit, once he paused, before the words are his: a commit voice
    /// detection made just before the pause's own is followed by that one, and his last words are in the second.
    private let settleAfter: Duration
    /// How long the last words may take after the pause before the Mac hears the run instead (a commit takes ~0.3 s).
    private let finishWithin: Duration

    init(
        socket: @escaping (URL) -> LiveWordsSocket = LiveWords.webSocket, settleAfter: Duration = .milliseconds(300),
        finishWithin: Duration = .seconds(3)
    ) {
        (makeSocket, self.settleAfter, self.finishWithin) = (socket, settleAfter, finishWithin)
    }

    /// `URLSession`'s socket; a binary frame is skipped.
    nonisolated static func webSocket(_ url: URL) -> LiveWordsSocket {
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        return LiveWordsSocket(
            send: { task.send(.string($0)) { _ in } },
            receive: {
                while let message = try? await task.receive() {
                    if case .string(let line) = message { return line }
                }
                return nil
            },
            close: { task.cancel(with: $0 ? .normalClosure : .goingAway, reason: nil) })
    }

    /// What he has said so far in this run, word by word: the committed words, then the ones still changing.
    public private(set) var words: [LiveWord] = []
    /// The stream stopped (no token, the socket or ElevenLabs failed): the Mac hears this run.
    public private(set) var hasFailed = false

    private var committed = ""
    /// What he said since the last commit, still changing: words a commit has not taken yet.
    private var pending = ""
    private var socket: LiveWordsSocket?
    /// Once he paused: the words settle when the stream has been quiet `settleAfter` since a commit.
    private var quiet: Task<Void, Never>?
    private var session: Task<Void, Never>?
    private var queue: [String] = []
    private var isOpen = false
    /// Which run the socket serves: a run that ended or was replaced changes it.
    private var generation = 0
    /// The pause waiting for its last words, and whether one began (ElevenLabs then closes the socket itself).
    private var ending: CheckedContinuation<String?, Never>?
    private var isFinishing = false

    nonisolated static let rate = 16_000
    /// About 10 minutes of audio, the dictation cap: more is never held while the socket opens.
    private static let queued = 6_000
    /// Between two words that arrive together, so a batch reads in left to right.
    nonisolated static let stagger = 0.06
    /// One glyph's fade, and how much later each next glyph of a word starts it: the word sweeps in from the left.
    nonisolated static let fade = 0.25
    nonisolated static let perGlyph = 0.02

    /// One audio chunk as the socket takes it: 16-bit mono little endian, base 64.
    nonisolated static func chunk(_ samples: [Float], commit: Bool = false) -> String {
        var pcm = Data(capacity: samples.count * 2)
        for sample in samples {
            withUnsafeBytes(of: Int16(max(-1, min(1, sample)) * Float(Int16.max)).littleEndian) {
                pcm.append(contentsOf: $0)
            }
        }
        let body: [String: Any] = [
            "message_type": "input_audio_chunk", "audio_base_64": pcm.base64EncodedString(), "commit": commit,
            "sample_rate": rate,
        ]
        return String(decoding: (try? JSONSerialization.data(withJSONObject: body)) ?? Data(), as: UTF8.self)
    }

    /// The words of `text`, from those shown: a word at a place already shown keeps its time, so a final replacing its
    /// partial (or a partial correcting itself) never fades or moves again; new words come after, `stagger` apart.
    nonisolated static func merged(_ shown: [LiveWord], with text: String, at now: Date) -> [LiveWord] {
        let next = text.split(whereSeparator: \.isWhitespace).map(String.init)
        return next.indices.map { i in
            LiveWord(
                text: next[i],
                at: i < shown.count ? shown[i].at : now.addingTimeInterval(Double(i - shown.count) * stagger))
        }
    }

    /// A glyph's opacity, 0 to 1, at `now`: its word's fade, begun `perGlyph` later for each glyph before it.
    public nonisolated static func opacity(of word: LiveWord, glyph: Int, at now: Date) -> Double {
        min(max((now.timeIntervalSince(word.at) - Double(glyph) * perGlyph) / fade, 0), 1)
    }

    /// When every glyph of `words` is fully in: nothing changes over time after it.
    public nonisolated static func settledAt(_ words: [LiveWord]) -> Date {
        words.map { $0.at.addingTimeInterval(fade + Double($0.text.count) * perGlyph) }.max() ?? .distantPast
    }

    /// The run the stream serves now: `finish` takes it, so a run's end never touches the next one's stream.
    public var run: Int { generation }

    /// His words landed in the field, or this run is heard on the Mac: nothing live to show.
    public func clear() { (words, committed, pending, hasFailed) = ([], "", "", false) }

    /// A run opens: a token, then the socket; audio fed meanwhile waits for it.
    public func begin(token: @escaping @Sendable () async throws -> String) {
        close()
        clear()
        let mine = generation
        session = Task { [weak self] in
            do {
                let token = try await token()
                guard !Task.isCancelled else { return }
                await self?.open(token: token, generation: mine)
            } catch {
                if self?.generation == mine { self?.hasFailed = true }
            }
        }
    }

    /// 16 kHz mono samples, in order.
    public func feed(_ samples: [Float]) {
        guard session != nil, !samples.isEmpty else { return }
        send(Self.chunk(samples))
    }

    /// `run` paused and the microphone gave its last samples: what is left is committed (a moment of silence sent with
    /// `commit`), and the run's words come back once ElevenLabs committed them. Nil when the stream failed, never
    /// opened, took past `finishWithin`, or heard nothing (`hasFailed`: the Mac then hears the recording), or another run
    /// began: that one's stream is left alone. Otherwise the socket closes either way.
    public func finish(_ mine: Int) async -> String? {
        guard mine == generation, session != nil else { return nil }
        var words: String?
        if isOpen, !hasFailed {
            isFinishing = true
            words = await withCheckedContinuation { ending in
                self.ending = ending
                send(Self.chunk([Float](repeating: 0, count: Self.rate / 10), commit: true))
                Task { [weak self, finishWithin] in
                    try? await Task.sleep(for: finishWithin)
                    if self?.generation == mine { self?.settle(nil) }
                }
            }
        }
        guard mine == generation else { return nil }
        // Nothing heard live may still be words on the Mac: it hears the recording.
        if words?.isEmpty != false {
            words = nil
            hasFailed = true
        }
        close()
        return words
    }

    private func close() {
        session?.cancel()
        quiet?.cancel()
        (session, quiet) = (nil, nil)
        generation += 1
        settle(nil)
        socket?.close(true)
        (socket, isOpen, queue, isFinishing) = (nil, false, [], false)
    }

    private func settle(_ words: String?) {
        ending?.resume(returning: words)
        ending = nil
    }

    private func send(_ message: String) {
        if isOpen, let socket {
            socket.send(message)
        } else if queue.count < Self.queued {
            queue.append(message)
        }
    }

    private func open(token: String, generation mine: Int) async {
        var parts = URLComponents(string: "wss://api.elevenlabs.io/v1/speech-to-text/realtime")
        parts?.queryItems = [
            .init(name: "token", value: token), .init(name: "model_id", value: "scribe_v2_realtime"),
            .init(name: "audio_format", value: "pcm_16000"), .init(name: "commit_strategy", value: "vad"),
        ]
        guard let url = parts?.url, mine == generation, !Task.isCancelled else { return }
        let socket = makeSocket(url)
        self.socket = socket
        isOpen = true
        for message in queue { socket.send(message) }
        queue = []
        // Messages of a run that has ended, or been replaced, are never shown.
        while mine == generation, let line = await socket.receive() {
            guard mine == generation, let parsed = LiveWordsMessage(line) else { continue }
            apply(parsed)
        }
        // The socket closed under a run still current, unless after the pause's words came: the Mac hears it.
        if mine == generation, !isFinishing || ending != nil { fail() }
    }

    func apply(_ message: LiveWordsMessage, at now: Date = .now) {
        switch message {
        case .committed(let said):
            committed = [committed, said].filter { !$0.isEmpty }.joined(separator: " ")
            pending = ""
            words = Self.merged(words, with: committed, at: now)
            if ending != nil { settleWhenQuiet() }
        case .partial(let said):
            pending = said
            words = Self.merged(words, with: [committed, said].joined(separator: " "), at: now)
            // More words after the pause: the commit that takes them is still to come.
            quiet?.cancel()
        // Nothing left to commit, while words were still changing: those would be lost, so the Mac hears the run.
        case .nothingToCommit: pending.trimmingCharacters(in: .whitespaces).isEmpty ? settle(committed) : fail()
        case .failed: fail()
        }
    }

    /// Settles on the committed words once nothing more came for `settleAfter`; a later commit or partial waits again.
    private func settleWhenQuiet() {
        quiet?.cancel()
        let (mine, after) = (generation, settleAfter)
        quiet = Task { [weak self] in
            try? await Task.sleep(for: after)
            guard !Task.isCancelled, let self, self.generation == mine else { return }
            self.settle(self.committed)
        }
    }

    private func fail() {
        hasFailed = true
        settle(nil)
        socket?.close(false)
    }
}
