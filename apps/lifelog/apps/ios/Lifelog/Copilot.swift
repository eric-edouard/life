import AVFoundation
import AudioPipeline
import Foundation
import OwnerSettings
import Timeline
import UIKit

/// The Copilot (docs/pendant.md): while its switch is on, what the Pendant hears goes from this phone straight to
/// ElevenLabs Scribe Realtime, each finished line goes to the owner's copilot (a project's server on his Mac, over
/// Tailscale), and what the copilot says back plays in his AirPods, in its voice. A press asks it to speak now; a press while it
/// speaks stops it. The copilot decides what to say and when; this only carries sound and words. Pages are stored and
/// synced as always.
@MainActor
final class Copilot: NSObject {
    /// Audio that ended longer ago than this is a backlog after a reconnect, not the room now: skipped.
    private static let staleSeconds: TimeInterval = 20
    /// Scribe takes audio in chunks; half a second keeps it close behind the room.
    private static let chunkSamples = 500 * PendantAudio.samplesPerMilli
    /// How long a press waits for Scribe to finish the line it falls in before asking.
    private static let commitWait: Duration = .milliseconds(1500)

    private let capture: CaptureStore
    private let settings: Settings
    /// The copilot's voice, playing; `nil` when quiet.
    private var player: AVAudioPlayer?
    /// The newest page fed; `nil` while off, so the feed starts at the newest page, never in the archive.
    private var seq: Int64?
    private var feeding = false
    private var scribe: URLSessionWebSocketTask?
    private var copilot: URLSessionWebSocketTask?
    /// A press waiting for Scribe's next finished line.
    private var committed: CheckedContinuation<Void, Never>?
    /// The press being answered, for its timing (`copilot.said`).
    private var pressedAt: Date?

    init(capture: CaptureStore, settings: Settings) {
        self.capture = capture
        self.settings = settings
        super.init()
    }

    /// New audio was saved: feed it, unless a feed is under way (it reads on until no page is new).
    func poke() {
        guard let address = settings.copilot else { return stop() }
        guard !feeding else { return }
        feeding = true
        Task {
            defer { feeding = false }
            do { try await feed(address) } catch { fail(error) }
        }
    }

    /// "Tell me now", or, while it speaks, "stop".
    func press() {
        if player?.isPlaying == true {
            silence()
            appEvent("copilot.stop")
            return
        }
        guard let address = settings.copilot else { return }
        pressedAt = .now
        Task {
            let background = UIApplication.shared.beginBackgroundTask(withName: "copilot")
            defer { UIApplication.shared.endBackgroundTask(background) }
            if let scribe, (try? await scribe.send(.string(Self.chunk("", commit: true)))) != nil {
                await withCheckedContinuation { continuation in
                    finishCommit()  // an earlier press still waiting asks now
                    committed = continuation
                    Task {
                        try? await Task.sleep(for: Self.commitWait)
                        finishCommit()
                    }
                }
            }
            do {
                _ = try await post(address, "now", [:])
                appEvent("copilot.press")
            } catch {
                pressedAt = nil
                _ = report(error)
            }
        }
    }

    private func feed(_ address: URL) async throws {
        guard let store = capture.sourceStore else { return }
        let device = CaptureStore.deviceID
        guard var after = seq else {
            seq = try await RecentAudio.newestSeq(store: store, deviceID: device)
            return
        }
        try await connect(address)
        while let next = try await RecentAudio.source(afterSeq: after, store: store, deviceID: device) {
            // Switched off meanwhile: `stop()` cleared the cursor, keep it cleared.
            guard settings.copilot != nil, let audio = next.audio else { break }
            after = next.seq
            seq = after
            let recent = CaptureInstant(Date.now.addingTimeInterval(-Self.staleSeconds))
            for span in audio.spans where recent < span.interval.upperBound {
                let samples = try await audio.samples(max(recent, span.interval.lowerBound)..<span.interval.upperBound)
                    .samples
                for start in stride(from: 0, to: samples.count, by: Self.chunkSamples) {
                    let pcm = samples[start..<min(samples.count, start + Self.chunkSamples)]
                    try await scribe?.send(.string(Self.chunk(Self.base64(pcm), commit: false)))
                }
            }
        }
    }

    private func connect(_ address: URL) async throws {
        if scribe?.state != .running {
            let reply = try await post(address, "scribe", [:])
            guard let url = (try? JSONDecoder().decode(ScribeAddress.self, from: reply))?.url else {
                throw CopilotError("The copilot gave no Scribe address.")
            }
            let task = URLSession.shared.webSocketTask(with: url)
            task.resume()
            // Scribe takes audio once its session has started.
            guard case .string(let first) = try await task.receive(), first.contains("session_started") else {
                task.cancel()
                throw CopilotError("Scribe didn't start a session.")
            }
            scribe = task
            listen(scribe: task, address: address)
        }
        if copilot?.state != .running {
            var socket = URLComponents(url: address.appending(path: "ws"), resolvingAgainstBaseURL: false)
            socket?.scheme = address.scheme == "https" ? "wss" : "ws"
            guard let url = socket?.url else { throw CopilotError("The copilot's address isn't valid.") }
            let task = URLSession.shared.webSocketTask(with: url)
            task.resume()
            copilot = task
            listen(copilot: task)
        }
    }

    /// Scribe's finished lines go to the copilot as the room's.
    private func listen(scribe task: URLSessionWebSocketTask, address: URL) {
        Task {
            while case .string(let text)? = try? await task.receive() {
                guard let event = try? JSONDecoder().decode(ScribeEvent.self, from: Data(text.utf8)) else { continue }
                if event.message_type == "committed_transcript" {
                    let line = event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if !line.isEmpty {
                        do {
                            _ = try await post(
                                address, "caption", ["speaker": "Room", "text": line, "source": "pendant"])
                        } catch { _ = report(error) }
                    }
                    finishCommit()
                } else if event.message_type.contains("error") {
                    appEvent("copilot.error", ["reason": event.message_type])
                }
            }
            if scribe === task { scribe = nil }
        }
    }

    /// The copilot's `say` is spoken.
    private func listen(copilot task: URLSessionWebSocketTask) {
        Task {
            while case .string(let text)? = try? await task.receive() {
                guard let message = try? JSONDecoder().decode(CopilotMessage.self, from: Data(text.utf8)),
                    message.type == "say", let audio = message.audio.flatMap({ Data(base64Encoded: $0) })
                else { continue }
                play(audio, words: message.text ?? "")
            }
            if copilot === task { copilot = nil }
        }
    }

    /// The copilot's spoken answer (MP3 in its voice), in the AirPods.
    private func play(_ audio: Data, words: String) {
        let session = AVAudioSession.sharedInstance()
        // Ducking makes it mixable, so it may start while the app is in the background.
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        player?.stop()
        player = try? AVAudioPlayer(data: audio)
        player?.delegate = self
        player?.play()
        var fields = ["words": "\(words.split(separator: " ").count)"]
        if let pressedAt { fields["sincePressMs"] = "\(Int(Date.now.timeIntervalSince(pressedAt) * 1000))" }
        pressedAt = nil
        appEvent("copilot.said", fields)
    }

    private func finishCommit() {
        committed?.resume()
        committed = nil
    }

    private func stop() {
        guard seq != nil || scribe != nil || copilot != nil else { return }
        seq = nil
        scribe?.cancel()
        copilot?.cancel()
        scribe = nil
        copilot = nil
        silence()
    }

    /// Stops the voice; other audio comes back up.
    // ponytail: deactivates the shared session; a recording playing at the same moment would stop with it.
    private func silence() {
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The feed failed: reported, and Scribe's session dropped so the next page opens a fresh one.
    private func fail(_ error: Error) {
        _ = report(error)
        scribe?.cancel()
        scribe = nil
    }

    private func post(_ address: URL, _ path: String, _ body: [String: String]) async throws -> Data {
        var request = URLRequest(url: address.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw CopilotError("The copilot answered \((response as? HTTPURLResponse)?.statusCode ?? 0) to /\(path).")
        }
        return data
    }

    /// One Scribe audio message: 16 kHz PCM, base64.
    private static func chunk(_ audio: String, commit: Bool) -> String {
        #"{"message_type":"input_audio_chunk","audio_base_64":"\#(audio)","commit":\#(commit),"sample_rate":16000}"#
    }

    /// Float samples as 16-bit little-endian PCM, base64.
    private static func base64(_ samples: ArraySlice<Float>) -> String {
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            let value = Int16(max(-1, min(1, sample)) * Float(Int16.max)).littleEndian
            withUnsafeBytes(of: value) { data.append(contentsOf: $0) }
        }
        return data.base64EncodedString()
    }

    private struct ScribeAddress: Decodable { var url: URL }
    private struct ScribeEvent: Decodable {
        var message_type: String
        var text: String?
    }
    private struct CopilotMessage: Decodable {
        var type: String
        var text: String?
        var audio: String?
    }
    private struct CopilotError: LocalizedError {
        let errorDescription: String?
        init(_ reason: String) { errorDescription = reason }
    }
}

extension Copilot: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let finished = ObjectIdentifier(player)
        // Only the answer playing now: a newer one may have replaced it.
        Task { @MainActor in if self.player.map(ObjectIdentifier.init) == finished { silence() } }
    }
}
