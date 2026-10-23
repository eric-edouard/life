import Capture
import Foundation
import Incidents
import PendantProtocol

/// What the status sentence says about recording. Built from the Pendant's own reports and never fresher than they
/// are: connected is not recording, an old report is "last known", and no report is "Checking…".
///
/// On screen: the lens, the sentence and one short line (a failure, else the sound, else `summary`). VoiceOver hears all
/// of it at once (`sentence`, `sound`, `evidence`, `failure`).
struct HeroReading: Equatable {
    enum Mode: Equatable {
        /// A fresh report says it's recording: the lens is lit.
        case live
        /// It was recording when it last reported, not confirmed since.
        case lastKnownRecording
        case paused
        /// A state lifelog doesn't know, shown as neither recording nor paused.
        case unrecognized
        /// A pause or resume, or a reconnect, waiting on the Pendant.
        case waiting
        case notConnected
    }

    enum Voice: Equatable {
        /// One big word: "Recording."
        case word
        /// A longer sentence: "Bluetooth is off."
        case sentence
        /// Italic, while something is pending: "Waiting for Pendant…"
        case waiting
    }

    /// What tapping the button does.
    enum Control: Equatable {
        case pause
        case resume
        case reconnect
        case none
    }

    enum Evidence: Hashable {
        /// "Confirmed by the Pendant 6 seconds ago": the relative part keeps counting on its own.
        case confirmed(lead: String, at: Date)
        case line(String)
    }

    /// The one short line under the sentence, with a glyph so freshness never rests on color alone.
    struct Glance: Equatable {
        var line: Evidence
        var systemImage: String
        /// The Pendant is storing sound now.
        var isHearing = false
    }

    /// What the microphones are doing.
    struct Sound: Equatable {
        var text: String
        var systemImage: String
        /// The Pendant is storing sound now: the lens shimmers and breathes.
        var isHearing = false
    }

    var sentence: String
    var voice = Voice.word
    var mode: Mode
    var sound: Sound?
    /// The state's own evidence in a few words, shown unless a failure or the sound matters more.
    var summary: Glance?
    /// The evidence in full sentences.
    var evidence: [Evidence] = []
    var failure: String?
    /// The way out of a condition that keeps lifelog from the Pendant, as one button.
    var recovery: Recovery?
    var control = Control.none

    /// The button is waiting for the Pendant.
    var isBusy: Bool { mode == .waiting }
}

extension HeroReading {
    /// A hold on the Pendant this recent is named as the cause of the state it reports.
    static let longPressWindow: TimeInterval = 600

    init(status: CaptureStatus, conditions: [CaptureCondition], now: Date) {
        let lastKnown = status.lastKnownRecording
        if let blocker = conditions.first(where: \.blocksLink) {
            let unknown = Glance(line: .line("Recording state unknown"), systemImage: "questionmark.circle")
            let state = Self.lastKnown(lastKnown) ?? unknown
            self.init(
                sentence: blocker.title + ".", voice: .sentence, mode: .notConnected, summary: state,
                evidence: [.line(blocker.detail), state.line], recovery: blocker.recovery)
            return
        }
        // Nothing confirmed since launch yet: never claim more than that.
        if let checking = conditions.first(where: { if case .checking = $0 { true } else { false } }) {
            self.init(
                sentence: "Checking…", voice: .waiting, mode: .waiting,
                summary: Self.lastKnown(lastKnown) ?? Self.waiting("Waiting for its first report"),
                evidence: [.line(checking.detail)] + Self.lastKnownLines(lastKnown))
            return
        }
        switch status.connection {
        case .ready:
            self.init(ready: status, now: now)
        case .idle, .discovering:
            // Nothing reported yet: never claim more than that.
            self.init(
                sentence: "Checking…", voice: .waiting, mode: .waiting,
                summary: Self.waiting("Waiting for its first report"),
                evidence: [.line("Waiting for the Pendant's first report.")] + Self.lastKnownLines(lastKnown))
        default:
            let outOfReach = conditions.first { if case .outOfReach = $0 { true } else { false } }
            self.init(
                sentence: "Not connected.", mode: .notConnected,
                summary: Self.lastKnown(lastKnown)
                    ?? Glance(line: .line(Self.neverReported), systemImage: "questionmark.circle"),
                evidence: Self.lastKnownLines(lastKnown, orNever: true)
                    + [.line(outOfReach?.detail ?? "Reconnecting on its own. The Pendant keeps recording meanwhile.")],
                control: .reconnect)
        }
    }

    private init(ready status: CaptureStatus, now: Date) {
        let lastKnown = status.lastKnownRecording
        switch status.recording {
        case .recording(let at):
            self.init(confirmed: .recording, at: at, press: Self.longPress(status, before: at, now: now), now: now)
        case .paused(let at):
            self.init(confirmed: .paused, at: at, press: Self.longPress(status, before: at, now: now), now: now)
        case .pauseRequested(let since), .resumeRequested(let since):
            let pausing = if case .pauseRequested = status.recording { true } else { false }
            let sent = "\(pausing ? "Pause" : "Resume") sent \(since.formatted(date: .omitted, time: .standard))"
            self.init(
                sentence: "Waiting for Pendant…", voice: .waiting, mode: .waiting, summary: Self.waiting(sent),
                evidence: [.line(sent)])
        case .failed(let failure, _):
            if let lastKnown {
                self.init(confirmed: lastKnown.value, at: lastKnown.at, press: nil, now: now)
            } else {
                self.init(sentence: "Checking…", voice: .waiting, mode: .waiting)
            }
            self.failure = Self.describe(failure)
        case .unknown:
            // Connected and answering, but not yet sure: a NOT_RECORDING report waits for a catch-up to read the
            // flash. The owner can still ask to record meanwhile; only the Pendant's own report confirms it.
            self.init(
                sentence: "Checking…", voice: .waiting, mode: .waiting,
                summary: Self.waiting("Waiting for the Pendant to report."),
                evidence: [.line("Waiting for the Pendant to report.")] + Self.lastKnownLines(lastKnown),
                control: .resume)
        }
        switch mode {
        case .live, .lastKnownRecording: sound = Self.sound(status.soundActivity, now: now)
        // A real pause turns the microphones off (docs/research/pendant-vad.md).
        case .paused where voice == .word: sound = Sound(text: "Microphones off", systemImage: "mic.slash")
        default: break
        }
    }

    /// Said only as fresh as the Pendant's evidence: an old "hearing" is "last heard", never now.
    private static func sound(_ observed: Observed<SoundActivity>?, now: Date) -> Sound? {
        guard let observed else { return nil }
        let fresh = observed.isFresh(now: now)
        return switch observed.value {
        case .hearing where fresh: Sound(text: "Hearing sound · just now", systemImage: "waveform", isHearing: true)
        case .hearing: Sound(text: "Last heard \(observed.at.moment)", systemImage: "waveform")
        case .quiet where fresh: Sound(text: "Quiet · listening", systemImage: "ear")
        case .quiet: Sound(text: "Quiet at \(observed.at.moment) · not confirmed since", systemImage: "ear")
        }
    }

    /// A state the Pendant reported at `at`; current only while that report is fresh. The screen asks for a status
    /// every `EvidenceFreshness.onScreenRefresh`, so an older report is said as "last known", never as now.
    private init(confirmed state: KnownRecording, at: Date, press: Date?, now: Date) {
        let fresh = EvidenceFreshness(observedAt: at, now: now, freshFor: EvidenceFreshness.onScreenFor) == .fresh
        let stale = Evidence.line("Reported at \(at.moment) · not confirmed since")
        // Fresh: "Confirmed 6 s ago", or the press on the Pendant behind it. Old: when it was last reported.
        func summary(pressed verb: String) -> Glance {
            guard fresh else { return Glance(line: stale, systemImage: "clock") }
            return press.map { Glance(line: .line("\(verb) on the Pendant at \($0.moment)"), systemImage: "hand.tap") }
                ?? Glance(line: .confirmed(lead: "Confirmed", at: at), systemImage: "checkmark.circle")
        }
        switch state {
        case .recording:
            let lead = press.map { "Resumed on the Pendant at \($0.moment) · confirmed" } ?? "Confirmed by the Pendant"
            self.init(
                sentence: fresh ? "Recording." : "Last known: recording.", voice: fresh ? .word : .sentence,
                mode: fresh ? .live : .lastKnownRecording, summary: summary(pressed: "Resumed"),
                evidence: [fresh ? .confirmed(lead: lead, at: at) : stale], control: .pause)
        case .paused:
            let lead = press.map { "Paused on the Pendant at \($0.moment) · confirmed" } ?? "Confirmed by the Pendant"
            self.init(
                sentence: fresh ? "Paused." : "Last known: paused.", voice: fresh ? .word : .sentence, mode: .paused,
                summary: summary(pressed: "Paused"), evidence: [fresh ? .confirmed(lead: lead, at: at) : stale],
                control: .resume)
        case .unrecognized(let raw):
            self.init(
                sentence: "Unrecognized state.", voice: .sentence, mode: .unrecognized,
                summary: Glance(line: .line("Reported as \(raw)"), systemImage: "questionmark.circle"),
                evidence: [.line("The Pendant reported a state lifelog doesn't know (\(raw)).")])
        }
    }

    /// A ~2 s hold the firmware acted on before this report, recent enough to be the reason for it.
    private static func longPress(_ status: CaptureStatus, before report: Date, now: Date) -> Date? {
        guard let press = status.lastButton, press.value == .long, press.at <= report,
            now.timeIntervalSince(press.at) < longPressWindow
        else { return nil }
        return press.at
    }

    private static let neverReported = "Its recording state was never reported."

    private static func lastKnownLines(_ observed: Observed<KnownRecording>?, orNever: Bool = false)
        -> [Evidence]
    {
        guard let observed else { return orNever ? [.line(neverReported)] : [] }
        return [.line("Last known: \(observed.value.word) at \(observed.at.moment)")]
    }

    /// In the same words as its evidence line, so the details don't repeat it.
    private static func lastKnown(_ observed: Observed<KnownRecording>?) -> Glance? {
        lastKnownLines(observed).first.map { Glance(line: $0, systemImage: "clock") }
    }

    private static func waiting(_ text: String) -> Glance {
        Glance(line: .line(text), systemImage: "hourglass")
    }

    private static func describe(_ failure: RecordingFailure) -> String {
        let verb = failure.intent == .pause ? "Pause" : "Resume"
        return switch failure {
        case .rejected(_, let message): "\(verb) refused by the Pendant: \(message)"
        case .unconfirmed: "\(verb) never confirmed · it may not have happened"
        }
    }
}

extension KnownRecording {
    /// "recording", "paused": what the Pendant said, in a sentence.
    var word: String {
        switch self {
        case .recording: "recording"
        case .paused: "paused"
        case .unrecognized(let raw): "unrecognized state \(raw)"
        }
    }
}
