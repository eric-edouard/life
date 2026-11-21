import AVFAudio
import AudioPipeline
import Library
import Timeline

/// One dictation from this phone's microphone. The Pendant hears the owner too, so the stretch is left out of its
/// uploads (#802): stored in the library up to the cap before the microphone opens (a failed write keeps it closed),
/// cut to the real end at `finish`, and posted once through the outbox so a reinstalled phone gets it back from the
/// feed. A crash leaves the capped stretch: at most 10 minutes of the Pendant's speech never uploaded (the raw backup
/// keeps it).
final class DictationCapture {
    enum Failure: Error { case denied, noLibrary }

    /// Whole-second Omi stamps and the Pendant clock's drift from the phone's, on both edges.
    static let pad: Int64 = 2_000

    private let library: LibraryStore
    private let sync: SyncStore?
    /// One start for the stretch and the recording, and one deadline: the stretch runs to `start + cap + pad`, the
    /// microphone closes at `start + cap` at the latest.
    private let start: CaptureInstant
    private let mic: MicCapture
    private var lease: AudioSessionOwner.Lease?
    private var deadline: Task<Void, Never>?
    private var closing: Task<Data, any Error>?

    private init(library: LibraryStore, sync: SyncStore?, mic: MicCapture) {
        (self.library, self.sync, self.mic) = (library, sync, mic)
        start = CaptureInstant(.now)
    }

    /// Asks for the microphone, stores the stretch, then opens it. `ended` is told when it stops on its own (the cap,
    /// a call, the microphone lost, playback taking the session): the caller then calls `finish`.
    static func begin(
        library: LibraryStore?, sync: SyncStore?, ended: @escaping @MainActor () -> Void
    ) async throws -> DictationCapture {
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
        guard let library else { throw Failure.noLibrary }
        let capture = DictationCapture(library: library, sync: sync, mic: try MicCapture())
        try await capture.store(until: capture.start.advanced(by: DictationRecording.capMillis))
        do {
            capture.lease = try AudioSessionOwner.shared.take(.recording, end: ended)
            try capture.mic.start(ended: ended)
        } catch {
            _ = try? await capture.finish()
            throw error
        }
        capture.deadline = Task {
            try? await Task.sleep(for: .milliseconds(DictationRecording.capMillis))
            if !Task.isCancelled { ended() }
        }
        appEvent("dictation.opened")
        return capture
    }

    /// Closes the microphone and returns what it heard (Ogg Opus); the stretch shrinks to the real end. Called again,
    /// it returns the same.
    func finish() async throws -> Data {
        if let closing { return try await closing.value }
        let closing = Task { try await close() }
        self.closing = closing
        return try await closing.value
    }

    private func close() async throws -> Data {
        deadline?.cancel()
        let heard: Result<Data, any Error>
        do { heard = .success(try await mic.stop()) } catch { heard = .failure(error) }
        lease.map(AudioSessionOwner.shared.release)
        lease = nil
        let end = min(CaptureInstant(.now), start.advanced(by: DictationRecording.capMillis))
        // A failed write keeps the capped stretch: more left out, never less.
        try? await store(until: end)
        let stretch = start.advanced(by: -Self.pad).date..<end.advanced(by: Self.pad).date
        await sync?.perform(.dictationQuiet(from: stretch.lowerBound, to: stretch.upperBound))
        appEvent("dictation.closed", ["seconds": "\(start.distance(to: end) / 1000)"])
        return try heard.get()
    }

    private func store(until end: CaptureInstant) async throws {
        try await library.setQuiet(.dictation, start.advanced(by: -Self.pad)..<end.advanced(by: Self.pad))
    }
}
