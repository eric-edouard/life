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
    case partial(String), committed(String), failed

    init?(_ text: String) {
        let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
        switch o["message_type"] as? String {
        case "partial_transcript": self = .partial(o["text"] as? String ?? "")
        case "committed_transcript": self = .committed(o["text"] as? String ?? "")
        case "session_started", "warning", nil: return nil
        default: self = .failed  // error, auth_error, quota_exceeded, rate_limited, ...
        }
    }
}

/// His words as he speaks them: the 16 kHz microphone stream goes to ElevenLabs' realtime Scribe over one socket per
/// press (a fresh token each time), and what comes back shows live. Only a display: the words that land in the field
/// are still the Mac's, at the pause. Any failure just stops it, silently.
@MainActor @Observable
public final class LiveWords {
    public static let shared = LiveWords()

    /// Whether the next recording streams (his "Your words, as you speak" setting, set by Tell Life while it is open).
    public var isOn = false
    /// What he has said so far in this press: the stable words, then the one still changing.
    public private(set) var text = ""

    private var committed = ""
    private var socket: URLSessionWebSocketTask?
    private var session: Task<Void, Never>?
    private var queue: [String] = []
    private var isOpen = false

    nonisolated static let rate = 16_000
    /// About 10 minutes of audio, the dictation cap: more is never held while the socket opens.
    private static let queued = 6_000

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

    /// His words landed in the field: the live line has done its job.
    public func clear() { (text, committed) = ("", "") }

    /// A press opens: a token, then the socket; audio fed meanwhile waits for it.
    public func begin(token: @escaping @Sendable () async throws -> String) {
        end()
        (text, committed) = ("", "")
        session = Task { [weak self] in
            guard let token = try? await token(), !Task.isCancelled else { return }
            await self?.open(token: token)
        }
    }

    /// 16 kHz mono samples, in order.
    public func feed(_ samples: [Float]) {
        guard session != nil, !samples.isEmpty else { return }
        send(Self.chunk(samples))
    }

    /// He let go: the last chunk commits, the socket closes after what is still coming.
    public func end() {
        guard session != nil else { return }
        send(Self.chunk([], commit: true))
        session = nil
        let closing = socket
        socket = nil
        isOpen = false
        queue = []
        Task {
            try? await Task.sleep(for: .seconds(2)); closing?.cancel(with: .normalClosure, reason: nil)
        }
    }

    private func send(_ message: String) {
        if isOpen, let socket {
            socket.send(.string(message)) { _ in }
        } else if queue.count < Self.queued {
            queue.append(message)
        }
    }

    private func open(token: String) async {
        var parts = URLComponents(string: "wss://api.elevenlabs.io/v1/speech-to-text/realtime")
        parts?.queryItems = [
            .init(name: "token", value: token), .init(name: "model_id", value: "scribe_v2_realtime"),
            .init(name: "audio_format", value: "pcm_16000"), .init(name: "commit_strategy", value: "vad"),
        ]
        guard let url = parts?.url else { return }
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        isOpen = true
        for message in queue { socket.send(.string(message)) { _ in } }
        queue = []
        while !Task.isCancelled, let message = try? await socket.receive() {
            guard case .string(let line) = message, let parsed = LiveWordsMessage(line) else { continue }
            apply(parsed)
        }
    }

    func apply(_ message: LiveWordsMessage) {
        switch message {
        case .committed(let words):
            committed = [committed, words].filter { !$0.isEmpty }.joined(separator: " ")
            text = committed
        case .partial(let words): text = [committed, words].filter { !$0.isEmpty }.joined(separator: " ")
        case .failed: socket?.cancel(with: .goingAway, reason: nil)
        }
    }
}
