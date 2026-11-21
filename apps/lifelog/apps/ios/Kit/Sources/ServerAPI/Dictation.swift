import Foundation
import Observation

/// One run of a field's dictation as `Dictation` drives it: its loudness now (0 to 1) and its end, which closes the
/// microphone and returns what it heard (Ogg Opus). The app's `DictationCapture` is the one real run.
public struct DictationRun: Sendable {
    public let level: @MainActor () -> Float
    public let finish: @MainActor () async throws -> Data

    public init(level: @escaping @MainActor () -> Float, finish: @escaping @MainActor () async throws -> Data) {
        (self.level, self.finish) = (level, finish)
    }
}

/// One field's dictation. Each run, start to pause, is its own recording (its own quiet stretch and cap); at its pause
/// its words are asked of the Mac once and land at the field's caret (`landed`). Words come only at a pause: the Mac's
/// recognition doesn't stream. Only the current run changes anything: a run cancelled or replaced finishes its
/// recording and drops whatever comes back.
@MainActor @Observable
public final class Dictation {
    public enum Phase: Equatable { case rest, starting, listening, writing }

    /// Why a run couldn't open the microphone (thrown by `begin`).
    public enum StartFailure: Error { case refused, busy, notStarted }

    /// Why the last press brought no words, said on the field's top line, with what fixes it.
    public enum Problem: Equatable {
        /// Nothing reached the paid step: the same recording may go again.
        case notReached(Data)
        case notWritten, refused, busy, notStarted

        init(_ failure: StartFailure) {
            switch failure {
            case .refused: self = .refused
            case .busy: self = .busy
            case .notStarted: self = .notStarted
            }
        }

        public var line: String {
            switch self {
            case .notReached: "Your Mac did not answer."
            case .notWritten: "Not written. Please say it again."
            case .refused: "Life cannot use the microphone."
            case .busy: "The microphone is busy. Try again after your call."
            case .notStarted: "Dictation could not start. Try again."
            }
        }

        /// The quiet link after the line, when one fixes it: "Try again" sends the same recording, which never reached
        /// the paid step; "Speak again" opens the microphone, since those bytes may have been heard and never go twice.
        public var fix: (title: String, symbol: String)? {
            switch self {
            case .notReached: ("Try again", "mic")
            case .notWritten: ("Speak again", "mic")
            case .refused: ("Open Settings", "arrow.up.right")
            case .busy, .notStarted: nil
            }
        }
    }

    /// Words that came back, once each: the field puts them at its caret.
    public struct Landed: Equatable {
        public let id = UUID()
        public let words: String
    }

    public typealias Begin = @MainActor (_ ended: @escaping @MainActor () -> Void) async throws -> DictationRun

    /// The stream draws one bar per sample.
    public static let sampleEvery = Duration.milliseconds(60)
    static let samplesKept = 120

    public private(set) var phase = Phase.rest
    public private(set) var problem: Problem?
    public private(set) var landed: Landed?
    /// The run's loudness, 0 to 1, one per `sampleEvery`, newest last; `sampledAt` is the newest's time.
    public private(set) var levels: [Double] = []
    public private(set) var sampledAt = Date.now
    public private(set) var runStarted = Date.now
    public private(set) var isRefused: Bool
    /// Called once the words of a run paused by a swipe up landed (a field with a Send, as Tell Life will be).
    public var send: (() -> Void)?

    /// Opens the microphone, asking for it the first time; the field sets it once its environment is known.
    public var begin: Begin
    private let words: @Sendable (Data) async throws -> String
    private let refused: @MainActor () -> Bool
    /// The current run; a task of any other changes nothing.
    private var run = 0
    private var starting: Task<DictationRun?, Never>?
    private var sampling: Task<Void, Never>?
    private var writing: Task<Void, Never>?
    private var sendsWhenLanded = false

    /// `words` asks the Mac once; `refused` reads whether the microphone was refused.
    public init(
        begin: @escaping Begin, words: @escaping @Sendable (Data) async throws -> String,
        refused: @escaping @MainActor () -> Bool
    ) {
        (self.begin, self.words, self.refused) = (begin, words, refused)
        isRefused = refused()
    }

    /// A tap: starts a run at rest, pauses the one under way; nothing while its words are written.
    public func tap() {
        switch phase {
        case .rest: start()
        case .starting, .listening: pause()
        case .writing: break
        }
    }

    public func start() {
        guard phase == .rest else { return }
        run += 1
        let current = run
        (problem, levels, runStarted, sampledAt, isRefused) = (nil, [], .now, .now, refused())
        guard !isRefused else {
            problem = .refused
            return
        }
        phase = .starting
        // The recording holds this: weak, so a field that went away isn't kept by its microphone.
        let ended: @MainActor () -> Void = { [weak self] in
            if self?.run == current { self?.pause() }
        }
        let begin = begin
        starting = Task {
            do {
                let opened = try await begin(ended)
                guard run == current else {
                    _ = try? await opened.finish()
                    return nil
                }
                if phase == .starting {
                    phase = .listening
                    sample(opened)
                }
                return opened
            } catch {
                guard run == current else { return nil }
                isRefused = refused()
                (problem, phase) = ((error as? StartFailure).map(Problem.init) ?? .notStarted, .rest)
                return nil
            }
        }
    }

    /// Ends the run (also before the microphone opened: it closes as soon as it does): its words are asked once.
    public func pause() {
        guard phase == .starting || phase == .listening else { return }
        let current = run
        phase = .writing
        sampling?.cancel()
        let starting = starting
        writing = Task {
            guard let opened = await starting?.value else { return }
            let ogg: Data
            do {
                ogg = try await opened.finish()
            } catch {
                // A recording with a hole is never sent.
                if run == current { fail(.notWritten) }
                return
            }
            guard run == current else { return }
            await write(ogg, current)
        }
    }

    /// A swipe up from the microphone where the field has a Send: pause, then send once the words landed.
    public func swipeUp() {
        guard send != nil, phase == .starting || phase == .listening else { return }
        sendsWhenLanded = true
        pause()
    }

    /// Drops the run: its microphone closes, nothing more is asked, and what comes back is dropped.
    public func cancel() {
        guard phase != .rest else { return }
        run += 1
        sampling?.cancel()
        writing?.cancel()
        let starting = starting
        starting?.cancel()
        Task { _ = try? await starting?.value?.finish() }
        (phase, sendsWhenLanded) = (.rest, false)
    }

    /// The problem line's link.
    public func fix(openSettings: () -> Void) {
        switch problem {
        case .notReached(let ogg):
            guard phase == .rest else { return }
            run += 1
            let current = run
            (problem, phase) = (nil, .writing)
            writing = Task { await write(ogg, current) }
        case .notWritten: start()
        case .refused: openSettings()
        case .busy, .notStarted, nil: break
        }
    }

    private func write(_ ogg: Data, _ current: Int) async {
        do {
            let text = try await words(ogg)
            guard run == current else { return }
            (phase, landed) = (.rest, Landed(words: text))
            if sendsWhenLanded {
                sendsWhenLanded = false
                send?()
            }
        } catch {
            guard run == current else { return }
            fail(DictationFailure(error) == .notReached ? .notReached(ogg) : .notWritten)
        }
    }

    private func fail(_ problem: Problem) {
        (self.problem, phase, sendsWhenLanded) = (problem, .rest, false)
    }

    /// The run's loudness every 60 ms, smoothed, on a log scale (speech sits far below full scale).
    private func sample(_ opened: DictationRun) {
        sampling = Task {
            var smoothed = 0.0
            while !Task.isCancelled {
                let decibels = 20 * log10(max(Double(opened.level()), 1e-5))
                smoothed = 0.6 * smoothed + 0.4 * min(max((decibels + 50) / 40, 0), 1)
                levels = Array((levels + [smoothed]).suffix(Self.samplesKept))
                sampledAt = .now
                try? await Task.sleep(for: Self.sampleEvery)
            }
        }
    }
}
