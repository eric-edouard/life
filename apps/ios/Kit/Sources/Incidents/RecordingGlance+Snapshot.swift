import Capture
import Foundation
import Glance

extension RecordingGlance {
    /// The snapshot's answer to "am I recording?", with its freshness decided now and the sound detector's last word.
    public init(_ snapshot: PendantSnapshot, sound: Observed<SoundActivity>?, lowBatteryPercent: Int, now: Date) {
        let connected = snapshot.link == .connected
        let battery = snapshot.battery?.value
        let heard: Heard? =
            switch sound?.value {
            case .hearing?: Heard(.hearing, at: sound?.at ?? now)
            case .quiet?: Heard(.quiet, at: sound?.at ?? now)
            case nil: nil
            }
        self.init(
            connected: connected, microphone: snapshot.microphone?.value, reportedAt: snapshot.microphone?.at,
            currentUntil: snapshot.recordingTurnsStale(now: now),
            pending: snapshot.pendingRequest(now: now).map {
                Pending(Request($0), until: (snapshot.request?.since ?? now) + PendantSnapshot.requestExpiry)
            },
            failed: snapshot.request.flatMap { $0.failed ? Request($0.intent) : nil },
            battery: battery, batteryCurrentUntil: snapshot.batteryCurrentUntil(now: now),
            // Only from a current level: a Watch built before `batteryCurrentUntil` shows it as is.
            batteryLow: snapshot.batteryIsCurrent(now: now) && battery.map { $0 <= lowBatteryPercent } == true
                && snapshot.charging?.value != true,
            heard: snapshot.microphone?.value == .recording ? heard : nil)
    }
}

extension RecordingGlance.Request {
    init(_ intent: RecordingIntent) {
        self = intent == .pause ? .pause : .resume
    }
}
