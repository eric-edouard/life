import AudioPipeline
import Capture
import Foundation
import ServerAPI
import UIKit

/// What the overlay shows of a press (`PressOverlay`), stage by stage as it happens.
struct PressState: Equatable {
    enum Stage: Hashable {
        case heard, listening, transcribing
        /// The words, ready to ask Claude or ChatGPT.
        case ready(String)
        /// Why it didn't work.
        case failed(String)
    }

    var press: QuickPress
    var stage: Stage

    /// How far along, for the lens's ring: 1 once it ended.
    var progress: Double {
        let steps: [Stage] = [.heard, .listening, .transcribing]
        return steps.firstIndex(of: stage).map { Double($0 + 1) / Double(steps.count + 1) } ?? 1
    }

    var ended: Bool { progress == 1 }
}

/// A finished press, as the Presses tab lists it: kept on this phone only, in Caches, and safe to lose.
struct PressRecord: Codable, Identifiable, Equatable {
    var id: String
    var at: Date
    var text = ""
    /// Why it didn't work; `nil` once done.
    var failure: String?
}

/// The Pendant's button (docs/pendant.md). One press, "Quick question to AI": the last minute, transcribed, shown with
/// Claude and ChatGPT to ask. The audio is the phone's own newest pages, rendered as fragments are; the server transcribes
/// it at once with ElevenLabs.
///
/// Every stage shows in the app (`shown`), whatever screen is open. In the background the outcome is a notification
/// instead: the words, or why it failed.
@MainActor @Observable
final class ButtonActions {
    /// The longest wait for the pages up to a press (`RecentAudio.settle`): with no speech the Pendant stores nothing.
    static let settle: Duration = .seconds(4)

    /// The press on screen; `nil` once dismissed.
    private(set) var shown: PressState?
    /// Finished presses, newest first (the Presses tab).
    private(set) var presses: [PressRecord] =
        (try? Data(contentsOf: ButtonActions.log)).flatMap { try? JSONDecoder().decode([PressRecord].self, from: $0) }
        ?? []
    private static let log = URL.cachesDirectory.appending(path: "presses.json")
    @ObservationIgnored private let capture: CaptureStore

    init(capture: CaptureStore) {
        self.capture = capture
    }

    func handle(_ press: QuickPress) {
        let received = Date.now
        shown = PressState(press: press, stage: .heard)
        Task { await run(press, received: received) }
    }

    /// Hides the press. One still at work shows again with its outcome.
    func dismiss() { shown = nil }

    func retry() {
        if let press = shown?.press { handle(press) }
    }

    /// A tapped notification's words, ready again, after a relaunch too.
    func showQuestion(_ words: String) {
        shown = PressState(press: QuickPress(id: "notification", at: .now), stage: .ready(words))
    }

    /// Opens `app` with the words filled in. Over the link's cap, they go through the clipboard and the app opens empty.
    static func ask(_ app: QuickQuestion.App, _ words: String) async {
        let prompt = QuickQuestion.prompt(words)
        let link = QuickQuestion.link(app, text: prompt)
        if link == nil { UIPasteboard.general.string = prompt }
        guard let url = link ?? app.home else { return }
        if await !UIApplication.shared.open(url, options: [.universalLinksOnly: true]) {
            await UIApplication.shared.open(url)
        }
    }

    private func show(_ press: QuickPress, _ stage: PressState.Stage) {
        let state = PressState(press: press, stage: stage)
        guard shown?.press.id == press.id || (shown == nil && state.ended) else { return }
        shown = state
    }

    private func run(_ press: QuickPress, received: Date) async {
        // A press usually wakes the app in the background: ask iOS for the time this takes.
        let background = UIApplication.shared.beginBackgroundTask(withName: "press")
        defer { UIApplication.shared.endBackgroundTask(background) }
        let from = press.at.addingTimeInterval(-60)
        // Each stage's milliseconds since the press, by the Pendant's clock; no text.
        var fields: [String: String] = [:]
        var record = PressRecord(id: press.id, at: press.at)
        func reached(_ stage: String, at: Date = .now) {
            fields["\(stage)Ms"] = String(Int(at.timeIntervalSince(press.at) * 1000))
        }
        reached("received", at: received)
        do {
            guard let store = capture.sourceStore else { throw Failure("lifelog isn't ready yet.") }
            try await RecentAudio.settle(
                until: press.at, store: store, deviceID: CaptureStore.deviceID, timeout: Self.settle)
            reached("settled")
            show(press, .listening)
            let file = URL.temporaryDirectory.appending(path: "press-\(UUID().uuidString).ogg")
            defer { try? FileManager.default.removeItem(at: file) }
            _ = try await RecentAudio.ogg(
                last: Int64(press.at.timeIntervalSince(from)), before: press.at, store: store,
                deviceID: CaptureStore.deviceID, to: file)
            reached("rendered")
            show(press, .transcribing)
            let words = try await transcribe(file)
            reached("transcribed")
            record.text = words.text
            guard !words.text.isEmpty else { throw Failure("No words were heard.") }
            show(press, .ready(record.text))
            if !isActive { await capture.notifier.quickQuestion(record.text, id: press.id) }
            reached("done")
            fields["outcome"] = "done"
        } catch {
            let reason = (error as? Failure)?.errorDescription ?? SyncStore.sentence(error)
            fields["outcome"] = "failed"
            fields["reason"] = reason
            record.failure = reason
            show(press, .failed(reason))
            if !isActive { await capture.notifier.pressFailed(reason, id: press.id) }
        }
        appEvent("press.done", fields)
        keep(record)
    }

    private var isActive: Bool { UIApplication.shared.applicationState == .active }

    /// The window's words, from the server; fixed words for the simulated Pendant (Debug).
    private func transcribe(_ file: URL) async throws -> ServerClient.QuickTranscript {
        #if DEBUG
            if capture.fake != nil {
                try await Task.sleep(for: .seconds(1.5))
                let words =
                    #"{"text":"What was the name of the restaurant Marie-Jo mentioned for Friday?"}"#
                return try JSONDecoder().decode(ServerClient.QuickTranscript.self, from: Data(words.utf8))
            }
        #endif
        let client = ServerClient.production
        return try await client.quickTranscription(audio: file)
    }

    /// One row per press, its latest outcome; the newest 200.
    private func keep(_ record: PressRecord) {
        presses.removeAll { $0.at == record.at }
        presses.insert(record, at: 0)
        presses = Array(presses.prefix(200))
        try? JSONEncoder().encode(presses).write(to: Self.log, options: .atomic)
    }

    private struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ reason: String) { errorDescription = reason }
    }
}
