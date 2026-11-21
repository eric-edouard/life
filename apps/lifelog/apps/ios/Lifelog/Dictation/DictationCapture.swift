import AVFAudio
import AudioPipeline
import Library
import ServerAPI
import Timeline

/// One dictation from this phone's microphone. The Pendant hears the owner too, so the stretch is left out of its
/// speech uploads (#802): stored in the library up to the cap before the microphone opens (a failed write keeps it
/// closed), then at the end cut to what was recorded and queued for the server in the same write, so a reinstalled
/// phone gets it back from the feed. A crash leaves the capped stretch, closed at the next launch: at most 10 minutes
/// of the Pendant's speech never sent for processing (its raw backup still reaches his server).
final class DictationCapture {
    enum Failure: Error { case denied, noLibrary, tooLate }

    /// Whole-second Omi stamps and the Pendant clock's drift from the phone's, on both edges.
    static let pad: Int64 = 2_000
    private static let cap = Duration.milliseconds(DictationRecording.capMillis)

    private let library: LibraryStore
    private let sync: SyncStore?
    /// One start for the stretch and the recording: the stretch runs to `start + cap + pad`, and the microphone
    /// closes by `opened + cap` on the monotonic clock, both taken once the microphone is allowed, before the stretch.
    private let start: CaptureInstant
    private let opened: ContinuousClock.Instant
    private let mic: MicCapture
    private var lease: AudioSessionOwner.Lease?
    private var deadline: Task<Void, Never>?
    private var closing: Task<Data, any Error>?
    /// Told once when it stopped on its own; the caller then takes the words with `finish`.
    private let ended: @MainActor () -> Void

    private init(
        library: LibraryStore, sync: SyncStore?, mic: MicCapture, start: CaptureInstant,
        opened: ContinuousClock.Instant, ended: @escaping @MainActor () -> Void
    ) {
        (self.library, self.sync, self.mic, self.start, self.opened, self.ended) =
            (library, sync, mic, start, opened, ended)
    }

    /// Closes the dictations a crash left open, once per launch, before any of this launch opens.
    static func recover(library: LibraryStore?) async {
        await recovery(library).value
    }

    private static var recovering: Task<Void, Never>?
    private static func recovery(_ library: LibraryStore?) -> Task<Void, Never> {
        if let recovering { return recovering }
        let task = Task {
            do { try await library?.closeInterruptedDictations() } catch { _ = report(error) }
        }
        recovering = task
        return task
    }

    /// Asks for the microphone, stores the stretch, then opens it, unless the caller went away meanwhile. `ended` is
    /// told once the microphone closed on its own (the cap, a call, the microphone lost, playback taking the session).
    static func begin(
        library: LibraryStore?, sync: SyncStore?, ended: @escaping @MainActor () -> Void
    ) async throws -> DictationCapture {
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
        // Taken once he allowed it: the time the permission sheet stays up is never left out.
        let (start, opened) = (CaptureInstant(.now), ContinuousClock.now)
        guard let library else { throw Failure.noLibrary }
        await recover(library: library)
        let capture = DictationCapture(
            library: library, sync: sync, mic: try MicCapture(), start: start, opened: opened, ended: ended)
        try await library.setQuiet(
            .dictation, capture.stretch(until: start.advanced(by: DictationRecording.capMillis)), open: true)
        do {
            try Task.checkCancellation()
            guard ContinuousClock.now < opened + cap else { throw Failure.tooLate }
            capture.lease = try AudioSessionOwner.shared.take(.recording) { [weak capture] in capture?.stopOnItsOwn() }
            try capture.mic.start { [weak capture] in capture?.stopOnItsOwn() }
        } catch {
            _ = try? await capture.finish()
            throw error
        }
        capture.deadline = Task { [weak capture] in
            try? await Task.sleep(until: opened + cap, clock: .continuous)
            if !Task.isCancelled { capture?.stopOnItsOwn() }
        }
        appEvent("dictation.opened")
        return capture
    }

    /// The recording's loudness now, 0 to 1: the field's stream.
    var level: Float { mic.recording.level }

    /// One run of a field's dictation (`Dictation`), its start's failures in the field's words.
    static func run(library: LibraryStore?, sync: SyncStore?) -> Dictation.Begin {
        { ended in
            let capture: DictationCapture
            do {
                capture = try await begin(library: library, sync: sync, ended: ended)
            } catch Failure.denied {
                throw Dictation.StartFailure.refused
            } catch Failure.noLibrary, Failure.tooLate {
                throw Dictation.StartFailure.notStarted
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as NSError where Self.isAudioBusy(error) {
                throw Dictation.StartFailure.busy
            } catch {
                // The stretch's write, the encoder: nothing a call explains.
                throw Dictation.StartFailure.notStarted
            }
            return DictationRun(level: { capture.level }, finish: capture.finish)
        }
    }

    /// The audio session or the engine refused to start because a call, Siri or another app holds the microphone.
    private static func isAudioBusy(_ error: NSError) -> Bool {
        let busy: Set<AVAudioSession.ErrorCode> = [.insufficientPriority, .cannotInterruptOthers, .siriIsRecording]
        return [NSOSStatusErrorDomain, "com.apple.coreaudio.avfaudio"].contains(error.domain)
            && AVAudioSession.ErrorCode(rawValue: error.code).map(busy.contains) == true
    }

    /// Closes the microphone and returns what it heard (Ogg Opus). Called again, it returns the same.
    func finish() async throws -> Data {
        if let closing { return try await closing.value }
        let closing = Task { try await close() }
        self.closing = closing
        return try await closing.value
    }

    /// The microphone closes itself before the field, or playback taking the session, hears of it.
    private func stopOnItsOwn() {
        guard closing == nil else { return }
        mic.halt()
        closing = Task { try await close() }
        ended()
    }

    private func close() async throws -> Data {
        deadline?.cancel()
        let heard: Result<Data, any Error>
        do { heard = .success(try await mic.stop()) } catch { heard = .failure(error) }
        lease.map(AudioSessionOwner.shared.release)
        lease = nil
        // From the monotonic clock: a wall clock set back can't make the stretch end before it starts.
        let elapsed = min(opened.duration(to: .now), Self.cap)
        let end = start.advanced(by: Int64(elapsed / .milliseconds(1)))
        do {
            try await library.closeDictation(stretch(until: end))
            sync?.run()
        } catch {
            // The open stretch stays capped, and the next launch closes and queues it: more left out, never less.
            _ = report(error)
        }
        appEvent("dictation.closed", ["seconds": "\(elapsed.components.seconds)"])
        return try heard.get()
    }

    private func stretch(until end: CaptureInstant) -> Range<CaptureInstant> {
        start.advanced(by: -Self.pad)..<end.advanced(by: Self.pad)
    }
}
