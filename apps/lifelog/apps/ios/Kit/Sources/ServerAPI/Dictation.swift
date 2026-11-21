import Foundation
import Observation

/// One run of a field's dictation as `Dictation` drives it: its loudness since last asked (0 to 1) and its end, which closes the
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

    /// Words that came back, once each: the field puts them at its caret, then sends when the run was paused by a
    /// swipe up (a field with a Send).
    public struct Landed: Equatable {
        public let id = UUID()
        public let words: String
        public let sends: Bool
    }

    public typealias Begin = @MainActor (_ ended: @escaping @MainActor () -> Void) async throws -> DictationRun

    /// The stream draws one bar per sample.
    public static let sampleEvery = Duration.milliseconds(60)
    /// How long the spinner may last: the Mac's answer, or the recording's close, past this is a failure (`notWritten`
    /// for the answer: it may have been heard, so it is said again). Under the request's 300 s, over a normal hearing.
    var answerWithin = Duration.seconds(120)
    static let samplesKept = 120

    public private(set) var phase = Phase.rest
    public private(set) var problem: Problem?
    public private(set) var landed: Landed?
    /// The run's loudness, 0 to 1, one per `sampleEvery`, newest last; `sampledAt` is the newest's time.
    public private(set) var levels: [Double] = []
    public private(set) var sampledAt = Date.now
    public private(set) var runStarted = Date.now
    public private(set) var isRefused: Bool

    /// Opens the microphone, asking for it the first time; the field sets it once its environment is known.
    public var begin: Begin
    private let words: @Sendable (Data) async throws -> String
    private let refused: @MainActor () -> Bool
    /// The current run; a task of any other changes nothing.
    private var run = 0
    private var starting: Task<Void, Never>?
    /// The current run's open microphone, held here alone until its pause or cancel takes it to close it.
    private var opened: DictationRun?
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
                let run = try await begin(ended)
                guard self.run == current else {
                    _ = try? await run.finish()
                    return
                }
                opened = run
                if phase == .starting {
                    phase = .listening
                    sample()
                }
            } catch {
                guard run == current else { return }
                isRefused = refused()
                (problem, phase) = ((error as? StartFailure).map(Problem.init) ?? .notStarted, .rest)
            }
        }
    }

    /// Ends the run (also before the microphone opened: it closes as soon as it does): its words are asked once.
    public func pause() {
        guard phase == .starting || phase == .listening else { return }
        let current = run
        phase = .writing
        sampling?.cancel()
        // `starting` stays: a cancel before the microphone opened still stops it opening.
        let starting = starting
        writing = Task {
            await starting?.value
            if let ogg = await closed(current) { await write(ogg, current) }
        }
    }

    /// Takes the run's microphone, closes it and returns what it heard; nil when the run is no longer current or its
    /// recording has a hole (never sent). Nothing keeps the run once this returns.
    private func closed(_ current: Int) async -> Data? {
        guard run == current, let run = opened else { return nil }
        opened = nil
        do {
            let ogg = try await bounded { try await run.finish() }
            return self.run == current ? ogg : nil
        } catch {
            if self.run == current { fail(.notWritten) }
            return nil
        }
    }

    /// A swipe up from the microphone where the field has a Send: pause, and its words land with `sends`.
    public func swipeUp() {
        guard phase == .starting || phase == .listening else { return }
        sendsWhenLanded = true
        pause()
    }

    /// Drops the run: its microphone closes, nothing more is asked, and what comes back is dropped.
    public func cancel() {
        guard phase != .rest else { return }
        run += 1
        sampling?.cancel()
        writing?.cancel()
        // A microphone still opening closes as it opens (its run is no longer current); an open one closes here; one
        // the writing task took, there.
        starting?.cancel()
        if let opened { Task { _ = try? await opened.finish() } }
        (starting, opened, phase, sendsWhenLanded) = (nil, nil, .rest, false)
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
            let words = words
            let text = try await bounded { try await words(ogg) }
            guard run == current else { return }
            (phase, landed, sendsWhenLanded) = (.rest, Landed(words: text, sends: sendsWhenLanded), false)
        } catch {
            guard run == current else { return }
            fail(DictationFailure(error) == .notReached ? .notReached(ogg) : .notWritten)
        }
    }

    private struct TimedOut: Error {}

    /// `work`'s result, or `TimedOut` once `answerWithin` has passed (the work is cancelled).
    private func bounded<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let limit = answerWithin
        return try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(for: limit)
                throw TimedOut()
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    /// One bar, 0 to 1, from a moment's loudness (root mean square) on a log scale: the microphone is unprocessed
    /// (`.measurement`, no gain control), so a quiet room sits near -60 dB and speech close to the phone near -20.
    /// A bar rises at once and falls by half a bar at most: each syllable a peak, a pause a short slope to the dots.
    // ponytail: -60 and -20 are set from the session's mode, not measured on his iPhone; move them if bars sit low.
    nonisolated static func bar(_ level: Float, after last: Double) -> Double {
        let heard = min(max((20 * log10(max(Double(level), 1e-6)) + 60) / 40, 0), 1)
        return max(heard, last / 2)
    }

    private func fail(_ problem: Problem) {
        (self.problem, phase, sendsWhenLanded) = (problem, .rest, false)
    }

    /// The run's loudness every 60 ms, one bar each (`bar`).
    private func sample() {
        sampling = Task {
            var last = 0.0
            while !Task.isCancelled, let level = opened?.level() {
                last = Self.bar(level, after: last)
                levels = Array((levels + [last]).suffix(Self.samplesKept))
                sampledAt = .now
                try? await Task.sleep(for: Self.sampleEvery)
            }
        }
    }
}
