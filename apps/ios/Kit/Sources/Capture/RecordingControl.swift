import Foundation
import PendantProtocol
import Timeline

public enum RecordingIntent: String, Sendable, Codable, Hashable {
    case pause
    case resume
}

public enum RecordingFailure: Sendable, Equatable, Hashable {
    /// The Pendant answered the command with an error.
    case rejected(RecordingIntent, String)
    /// No telemetry confirmed the change in time. The device may or may not have changed.
    case unconfirmed(RecordingIntent)
}

/// Whether recording is on: the owner's and the firmware's choice, not the sound detector's. "Recording" includes the
/// detector waiting in silence with the microphones on; "paused" is idle mode with the microphones off. Confirmed
/// states come only from the Pendant's own evidence, never from a successful Bluetooth write.
public enum RecordingState: Sendable, Equatable {
    case unknown
    case recording(confirmedAt: Date)
    case paused(confirmedAt: Date)
    case pauseRequested(pendingSince: Date)
    case resumeRequested(pendingSince: Date)
    case failed(RecordingFailure, at: Date)
}

public enum RecordingEvent: Sendable, Equatable {
    case requested(RecordingIntent, at: Date)
    case commandRejected(String, at: Date)
    /// A `DeviceStatus` carrying recording state. `answersControl` is true only for the reply to the status query
    /// we sent after our own start/stop command.
    case telemetry(DeviceRecordingState, at: Date, answersControl: Bool)
    /// A ~2 s hold: the firmware toggled recording on its own.
    case firmwareToggle(at: Date)
    /// A fresh quick press. While paused it asks to resume, like the owner's own request.
    case quickPress(at: Date)
    /// What flash pages say about the firmware's mode (`FlashPage.recordingMode`), `nil` when they say nothing. Sent
    /// once a drain has seen every page, or for a live page as it arrives.
    case flash(Observed<Bool>?)
    case confirmationTimedOut(at: Date)
    case connectionLost
}

public enum RecordingEffect: Sendable, Equatable {
    case send(PendantCommand)
    /// Query status, treat the reply as the confirmation, and time the confirmation out.
    case confirmByStatusQuery
    /// Query status to reflect a change we did not cause.
    case refreshStatus
    case alertUnexpectedStop
    /// Telemetry confirmed the microphone went off, or came back on after being off. Persisted for segmentation.
    case confirmed(RecordingChange.Kind, at: Date)
}

/// Recording on or off as the Pendant last confirmed, or a state it reported that Life doesn't know.
public enum KnownRecording: Equatable, Sendable {
    case recording
    case paused
    case unrecognized(UInt64)
}

/// Pure recording-control state machine.
///
/// The firmware reports NOT_RECORDING both when it is paused (idle mode, microphones off) and, as its own logs and
/// flash chunks show, every time its sound detector stops storing (docs/voice/research/pendant-vad.md). So NOT_RECORDING
/// alone is never a pause: it is one only when this app asked for it, a long press was just seen, or the newest
/// evidence of the firmware's mode says idle. Otherwise recording stays on and the silence is the sound line's business.
public struct RecordingControl: Sendable {
    public private(set) var state: RecordingState = .unknown
    /// Recording on or off as last confirmed, kept across disconnects as "last known".
    public private(set) var lastObserved: Observed<KnownRecording>?
    private var firmwareToggled = false
    /// The Pendant's last report, as sent.
    private var report: Observed<DeviceRecordingState>?
    /// Whether the firmware's recording is on, from the newest evidence of its mode: our confirmed commands, a long
    /// press, a RECORDING or LISTENING report, flash pages. `nil` on each new connection until something says.
    private var enabled: Observed<Bool>?
    /// `enabled` as it stood when the last connection ended: what a drain that says nothing falls back to. A long press
    /// out of reach logs its idle switch on flash, so a drain without mode evidence means nothing changed.
    private var before: Observed<Bool>?

    public init() {}

    public mutating func handle(_ event: RecordingEvent) -> [RecordingEffect] {
        switch event {
        case .requested(.pause, let at):
            if case .paused = state { return [] }
            state = .pauseRequested(pendingSince: at)
            return [.send(.stopRecording), .confirmByStatusQuery]
        case .requested(.resume, let at):
            if case .recording = state { return [] }
            state = .resumeRequested(pendingSince: at)
            return [.send(.startRecording), .confirmByStatusQuery]
        case .commandRejected(let message, let at):
            guard let intent = pendingIntent else { return [] }
            state = .failed(.rejected(intent, message), at: at)
            return []
        case .telemetry(let observed, let at, let answersControl):
            report = Observed(observed, at: at)
            if let intent = pendingIntent {
                guard answersControl, intent.isConfirmed(by: observed) else { return [] }
                note(intent == .resume, at: at)
                state = intent == .resume ? .recording(confirmedAt: at) : .paused(confirmedAt: at)
                lastObserved = Observed(intent == .resume ? .recording : .paused, at: at)
                return [.confirmed(intent == .pause ? .paused : .resumed, at: at)]
            }
            let deliberate = firmwareToggled
            firmwareToggled = false
            switch observed {
            case .recording, .listening: note(true, at: at)
            case .notRecording where deliberate: note(false, at: at)
            default: break
            }
            return interpret(deliberate: deliberate)
        case .flash(let mode):
            if let mode {
                note(mode.value, at: mode.at)
            } else if enabled == nil, let before {
                note(before.value, at: before.at)
            }
            // A request in flight is settled only by the reply to its own query; a live page is just evidence.
            guard pendingIntent == nil else { return [] }
            return interpret(deliberate: false)
        case .quickPress(let at):
            guard case .paused = state else { return [] }
            return handle(.requested(.resume, at: at))
        case .firmwareToggle:
            // Reflect, never reverse: no command, just ask what the device now does.
            firmwareToggled = true
            if pendingIntent != nil { state = .unknown }
            return [.refreshStatus]
        case .confirmationTimedOut(let at):
            guard let intent = pendingIntent else { return [] }
            state = .failed(.unconfirmed(intent), at: at)
            return []
        case .connectionLost:
            // A failed request stays failed: the next connection's report can't meet it unless the Pendant obeys.
            if case .failed = state {} else { state = .unknown }
            firmwareToggled = false
            report = nil
            // The owner may long-press while out of reach: the next connection learns the mode afresh from its drain.
            before = enabled ?? before
            enabled = nil
            return []
        }
    }

    private mutating func note(_ on: Bool, at: Date) {
        if enabled.map({ at >= $0.at }) ?? true { enabled = Observed(on, at: at) }
    }

    /// The last report read through the firmware's mode. NOT_RECORDING with the mode unknown waits for the flash.
    private mutating func interpret(deliberate: Bool) -> [RecordingEffect] {
        guard let report else { return [] }
        let on: Bool? =
            switch report.value {
            case .recording, .listening: true
            case .notRecording: enabled?.value
            case .unknown: nil
            }
        // A failed request holds until the Pendant does what the owner asked or the owner acts again (a new request,
        // a long press): a report of anything else confirms the failure, it never clears it.
        if case .failed(let failure, _) = state, !deliberate, on != (failure.intent == .resume) {
            if let on { lastObserved = Observed(on ? .recording : .paused, at: report.at) }
            return []
        }
        guard let on else {
            state = .unknown
            if case .unknown(let raw) = report.value { lastObserved = Observed(.unrecognized(raw), at: report.at) }
            return []
        }
        let wasRecording = if case .recording = state { true } else { false }
        let wasPaused = if case .paused = state { true } else { false }
        state = on ? .recording(confirmedAt: report.at) : .paused(confirmedAt: report.at)
        lastObserved = Observed(on ? .recording : .paused, at: report.at)
        var effects: [RecordingEffect] = []
        if wasRecording && !on && !deliberate { effects.append(.alertUnexpectedStop) }
        if !on && !wasPaused { effects.append(.confirmed(.paused, at: report.at)) }
        if on && wasPaused { effects.append(.confirmed(.resumed, at: report.at)) }
        return effects
    }

    var pendingIntent: RecordingIntent? {
        switch state {
        case .pauseRequested: .pause
        case .resumeRequested: .resume
        default: nil
        }
    }
}

extension FlashPage {
    /// This page's newest sign of the firmware's mode: the detector recording (a RECORDING chunk, audio) or the
    /// firmware waking means on; its switch to idle mode means off (microphones off). A NOT_RECORDING chunk says
    /// neither: the detector writes one at every pause. Verified on the owner's Pendant (docs/voice/research/pendant-vad.md).
    public var recordingMode: Observed<Bool>? {
        guard let opened = timestampMillis else { return nil }
        var mode: Observed<Bool>?
        for chunk in chunks {
            let at = Date(timeIntervalSince1970: (Double(opened) + Double(max(chunk.timeOffsetMillis ?? 0, 0))) / 1000)
            if chunk.recording?.state == .recording || chunk.audio?.opusPackets.isEmpty == false {
                mode = Observed(true, at: at)
            }
            guard let log = chunk.log else { continue }
            if log.contains("Switching to idle mode") || log.contains("Device mode set to IDLE_MODE") {
                mode = Observed(false, at: at)
            } else if log.contains("Waking up from idle mode") {
                mode = Observed(true, at: at)
            }
        }
        return mode
    }
}

extension RecordingFailure {
    public var intent: RecordingIntent {
        switch self {
        case .rejected(let intent, _), .unconfirmed(let intent): intent
        }
    }
}

extension RecordingIntent {
    fileprivate func isConfirmed(by observed: DeviceRecordingState) -> Bool {
        switch self {
        case .pause: observed == .notRecording
        case .resume: observed == .recording || observed == .listening
        }
    }
}
