import Capture
import Foundation

/// Tells changes made on the Pendant (its button, going out of reach and coming back) from those asked for in
/// lifelog, from the app, a Shortcut or a control. Only the Pendant's own changes notify: the owner just made the
/// others and sees the result where they asked. Pure and Codable, like `IncidentReducer`, so it survives relaunches.
public struct PendantChangeReducer: Sendable, Codable, Equatable {
    /// A change confirmed this soon after an in-app request in the same direction is that request's outcome.
    /// ponytail: one window; telemetry normally confirms within the 10 s reply timeout, the rest is margin.
    public static let requestWindow: TimeInterval = 60
    /// Disconnects shorter than this recover quietly. Longer, the notice tells how to restart the Pendant: on Oct 20
    /// it stopped advertising after a link timeout until restarted 35 min later (one incident, cause unknown).
    public static let disconnectAfter: TimeInterval = 10 * 60
    /// How long a reconnect notice waits for the Pendant's first backlog count before going out without it.
    public static let backlogWait: TimeInterval = 30

    private struct Request: Sendable, Codable, Equatable {
        var intent: RecordingIntent
        var at: Date
    }

    private var request: Request?
    /// The last on/off the Pendant reported; `nil` until it reports one.
    private var wasRecording: Bool?
    private var wasConnected = false
    private var lostAt: Date?
    /// Back after a long outage, waiting for its backlog count.
    private var reconnectedAt: Date?

    public init() {}

    /// Call before sending a pause or resume the owner asked for in lifelog.
    public mutating func appRequested(_ intent: RecordingIntent, at: Date) {
        request = Request(intent: intent, at: at)
    }

    public mutating func reduce(_ status: CaptureStatus, now: Date) -> [IncidentEffect] {
        recordingEffects(status, now: now) + connectionEffects(status, now: now)
    }

    private mutating func recordingEffects(_ status: CaptureStatus, now: Date) -> [IncidentEffect] {
        if let request, now.timeIntervalSince(request.at) > Self.requestWindow { self.request = nil }
        guard let observed = status.lastKnownRecording else { return [] }
        let recording: Bool
        switch observed.value {
        case .recording: recording = true
        case .paused: recording = false
        // An unrecognized state says nothing about on or off.
        case .unrecognized: return []
        }
        defer { wasRecording = recording }
        guard let wasRecording, wasRecording != recording else { return [] }
        let intent: RecordingIntent = recording ? .resume : .pause
        if let request, request.intent == intent, observed.at >= request.at {
            self.request = nil
            return []
        }
        if recording { return [.clear(.recordingPausedOnPendant), .post(.recordingResumedOnPendant)] }
        // An unexpected stop has its own alert with the known reason (`IncidentReducer`).
        if status.incidents.contains(.recordingStoppedUnexpectedly) { return [] }
        return [.clear(.recordingResumedOnPendant), .post(.recordingPausedOnPendant)]
    }

    private mutating func connectionEffects(_ status: CaptureStatus, now: Date) -> [IncidentEffect] {
        var effects: [IncidentEffect] = []
        switch status.connection {
        case .ready:
            wasConnected = true
            if let lost = lostAt {
                lostAt = nil
                if now.timeIntervalSince(lost) >= Self.disconnectAfter {
                    reconnectedAt = now
                } else {
                    effects.append(.unschedule(.pendantDisconnected))
                }
            }
            if let since = reconnectedAt {
                let backlog = status.backlog.flatMap { $0.at >= since ? $0.value.pages : nil }
                if backlog != nil || now.timeIntervalSince(since) >= Self.backlogWait {
                    reconnectedAt = nil
                    effects += [.clear(.pendantDisconnected), .postReconnected(catchingUpPages: backlog)]
                }
            }
        case .disconnected(_, let reason) where reason != .cancelled:
            effects += linkLost(now)
        case .connecting:
            effects += linkLost(now)
        case .discovering, .pairingPending, .scanning:
            // On the way back (or still looking): neither a new loss nor a recovery.
            break
        case .idle, .bluetoothOff, .unauthorized, .unsupported, .busyElsewhere, .disconnected, .resting:
            // The phone's side, which the app shows: Bluetooth off, another app holding the Pendant, lifelog
            // letting go. Not something the Pendant did.
            wasConnected = false
            reconnectedAt = nil
            if lostAt != nil {
                lostAt = nil
                effects.append(.unschedule(.pendantDisconnected))
            }
        }
        return effects
    }

    /// A Pendant last reported paused isn't capturing, so losing it loses nothing: no notice either way. A pause by
    /// the button seemed to drop the link (Oct 19), and "disconnected" came for a pause just made on the Pendant.
    /// Days without contact still alert (`IncidentReducer.noContactAfter`).
    private mutating func linkLost(_ now: Date) -> [IncidentEffect] {
        guard wasConnected else { return [] }
        wasConnected = false
        reconnectedAt = nil
        guard wasRecording != false else { return [] }
        lostAt = now
        return [.schedule(.pendantDisconnected, at: now.addingTimeInterval(Self.disconnectAfter))]
    }
}
