import AudioPipeline
import Export
import Foundation
import Library
import Observation
import Timeline

/// Export feature store: the owner's choices and one export at a time. The work runs in Kit (`ExportJob`), off the
/// main actor; nothing leaves the phone until the owner picks a destination in the share sheet.
@Observable
final class ExportStore {
    enum Content: String, CaseIterable {
        case both = "Audio and text"
        case audio = "Audio only"
        case text = "Text only"
    }

    enum State {
        case idle
        case running(fraction: Double)
        case finished(ExportResult)
        case failed(String)
    }

    var content = Content.both
    var audio: Set<AudioFormat> = [.m4a]
    var text: Set<ExportFormat> = [.txt, .json]
    private(set) var state = State.idle
    @ObservationIgnored private var task: Task<Void, Never>?

    /// Something to export: the chosen kinds have at least one format each.
    var canExport: Bool {
        switch content {
        case .both: !audio.isEmpty && !text.isEmpty
        case .audio: !audio.isEmpty
        case .text: !text.isEmpty
        }
    }

    func export(_ conversations: [UUID], from library: LibraryStore?, sync: SyncStore?) {
        guard let library else {
            state = .failed(LibraryStore.notOpen)
            return
        }
        let request = ExportRequest(
            conversations: conversations, audio: content == .text ? [] : audio, text: content == .audio ? [] : text)
        state = .running(fraction: 0)
        task = Task {
            do {
                // ponytail: evicted files are rebuilt whole, so exporting the archive writes them all again; read the
                // source packs in `RangeAudio` if that gets slow.
                var imported: [ImportedAudio] = []
                for id in conversations where !request.audio.isEmpty {
                    guard let conversation = try await library.conversation(id) else { continue }
                    if let audio = try await library.importedAudio(of: conversation.id) {
                        imported.append(audio)
                    } else {
                        try await sync?.restorePlayback(covering: conversation.range)
                    }
                }
                let sources =
                    try AudioSource.derived(PlaybackStore.audio(), deviceID: CaptureStore.deviceID)
                    + AudioSource.imported(imported, in: library)
                let result = try await ExportJob.run(
                    request, library: library, audio: sources, timeZone: .current, appVersion: Bundle.main.appVersion,
                    in: URL.temporaryDirectory.appending(path: "export-\(UUID())", directoryHint: .isDirectory)
                ) { fraction in
                    Task { @MainActor in self.progressed(fraction) }
                }
                state = .finished(result)
            } catch is CancellationError {
                state = .idle
            } catch {
                state = .failed(report(error))
            }
        }
    }

    func cancel() {
        task?.cancel()
    }

    func reset() {
        state = .idle
    }

    private func progressed(_ fraction: Double) {
        if case .running = state { state = .running(fraction: fraction) }
    }
}

extension Bundle {
    /// "1.0 (12)", written into every manifest.
    var appVersion: String {
        let short = object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(short) (\(build))"
    }
}
