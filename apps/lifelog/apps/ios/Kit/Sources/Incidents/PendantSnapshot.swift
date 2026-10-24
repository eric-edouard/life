import Capture
import Foundation
import Glance
import PendantProtocol

/// What widgets, controls and Shortcuts know about the Pendant. The app writes it when something meaningful changes;
/// other processes read it. It holds evidence with the time it was observed; how fresh that is gets decided when it is
/// read (`recording(now:)`), never stored.
public struct PendantSnapshot: Sendable, Codable, Equatable {
    public enum Link: String, Sendable, Codable {
        case connected
        /// Reconnecting or searching.
        case connecting
        case notConnected
        case bluetoothOff
    }

    public typealias Microphone = RecordingGlance.Microphone

    /// A pause or resume asked for in lifelog, until the Pendant confirms it or it fails.
    public struct Request: Sendable, Codable, Equatable {
        public var intent: RecordingIntent
        public var since: Date
        public var failed: Bool

        public init(intent: RecordingIntent, since: Date, failed: Bool) {
            self.intent = intent
            self.since = since
            self.failed = failed
        }
    }

    public struct Storage: Sendable, Codable, Equatable {
        public var freePages: UInt64
        public var totalPages: UInt64
    }

    public var link: Link
    public var lastContact: Date?
    /// The Pendant's last report, kept across disconnects and relaunches.
    public var microphone: Observed<Microphone>?
    /// `microphone` was confirmed on the connection that is still up: no disconnect since. `nil` in snapshots written
    /// before this existed, read as false.
    public var confirmedOnLink: Bool?
    public var request: Request?
    public var battery: Observed<Int>?
    /// True only when the Pendant said it is charging; other readings are unverified (`ChargingState`).
    public var charging: Observed<Bool>?
    public var storage: Observed<Storage>?
    /// Pages still on the Pendant.
    public var backlog: Observed<UInt64>?

    public init(
        link: Link, lastContact: Date? = nil, microphone: Observed<Microphone>? = nil, confirmedOnLink: Bool? = nil,
        request: Request? = nil, battery: Observed<Int>? = nil, charging: Observed<Bool>? = nil,
        storage: Observed<Storage>? = nil, backlog: Observed<UInt64>? = nil
    ) {
        self.link = link
        self.lastContact = lastContact
        self.microphone = microphone
        self.confirmedOnLink = confirmedOnLink
        self.request = request
        self.battery = battery
        self.charging = charging
        self.storage = storage
        self.backlog = backlog
    }

    /// From the capture status. Evidence the status doesn't have yet (after a relaunch) is kept from `previous`.
    public init(_ status: CaptureStatus, previous: PendantSnapshot?) {
        link =
            switch status.connection {
            case .ready: .connected
            case .scanning, .connecting, .discovering, .pairingPending, .disconnected: .connecting
            case .bluetoothOff, .unauthorized, .unsupported: .bluetoothOff
            case .idle, .busyElsewhere, .resting: .notConnected
            }
        lastContact = status.lastContact ?? previous?.lastContact
        microphone =
            status.lastKnownRecording.map {
                let microphone: Microphone =
                    switch $0.value {
                    case .recording: .recording
                    case .paused: .paused
                    case .unrecognized: .unrecognized
                    }
                return Observed(microphone, at: $0.at)
            } ?? previous?.microphone
        // The machine's state is only ever confirmed by this connection's evidence: a disconnect resets it to unknown.
        confirmedOnLink =
            switch status.recording {
            case .recording, .paused: link == .connected
            default: false
            }
        request =
            switch status.recording {
            case .pauseRequested(let since): Request(intent: .pause, since: since, failed: false)
            case .resumeRequested(let since): Request(intent: .resume, since: since, failed: false)
            case .failed(.rejected(let intent, _), let at), .failed(.unconfirmed(let intent), let at):
                Request(intent: intent, since: at, failed: true)
            default: nil
            }
        battery = status.batteryPercent ?? previous?.battery
        charging = status.charging.map { Observed($0.value == .charging, at: $0.at) } ?? previous?.charging
        storage =
            status.storage.map {
                Observed(Storage(freePages: $0.value.freePages, totalPages: $0.value.totalPages), at: $0.at)
            }
            ?? previous?.storage
        backlog = status.backlog.map { Observed($0.value.pages, at: $0.at) } ?? previous?.backlog
    }

    public typealias RecordingReading = RecordingGlance.Reading

    /// Never fresher than the evidence: only a connected Pendant's recent report is current, or a pause the link still
    /// holds (`holdsPause`).
    public func recording(now: Date) -> RecordingReading {
        guard let microphone else { return .unknown }
        return EvidenceFreshness.isCurrent(microphone.at, connected: link == .connected, now: now) || holdsPause
            ? .confirmed(microphone.value, at: microphone.at) : .lastKnown(microphone.value, at: microphone.at)
    }

    /// A pause confirmed on the link that is still up stays current however old its report. A paused Pendant sends
    /// nothing (no pages, no status pushes) and the app runs no timer in the background, so no newer evidence comes.
    /// But only a long press or a command ends a pause, and either makes the Pendant push a status at once over that
    /// same link (docs/decisions.md). Recording gets no such hold: the firmware can stop without a press.
    /// ponytail: if the app is force-quit, nothing writes that the link dropped and a pause reads as current until
    /// the next launch; a pause, not "recording", so it never claims capture that isn't happening.
    private var holdsPause: Bool {
        link == .connected && confirmedOnLink == true && microphone?.value == .paused
    }

    /// Current only from a connected Pendant within one sync cycle. Otherwise it is the last known level: paused, off
    /// and out of reach look the same from here (a dropped link says nothing about why), so it is never hidden.
    public func batteryIsCurrent(now: Date) -> Bool {
        battery.map { EvidenceFreshness.isCurrent($0.at, connected: link == .connected, now: now) } == true
    }

    /// When a current level turns last known, for surfaces that judge it on their own clock.
    public func batteryCurrentUntil(now: Date) -> Date? {
        guard let battery, batteryIsCurrent(now: now) else { return nil }
        return EvidenceFreshness.currentUntil(battery.at)
    }

    /// A request still waiting for the Pendant. One the app never resolved (it was killed) stops counting.
    public func pendingRequest(now: Date) -> RecordingIntent? {
        guard let request, !request.failed, now.timeIntervalSince(request.since) < Self.requestExpiry else {
            return nil
        }
        return request.intent
    }

    /// When the current reading turns from confirmed to last known, if it will.
    public func recordingTurnsStale(now: Date) -> Date? {
        guard case .confirmed(_, let at) = recording(now: now) else { return nil }
        // Not with time: when the link drops, which the app writes.
        if holdsPause { return .distantFuture }
        return EvidenceFreshness.currentUntil(at)
    }

    public static let requestExpiry: TimeInterval = 60

    // MARK: Throttling

    /// ponytail: contact and evidence times move with every page and status report; persist them at most this often,
    /// well inside `EvidenceFreshness.freshFor`.
    static let evidenceStep: TimeInterval = 60

    /// Worth writing: a value changed, or the newest evidence moved by a step. Fresher times alone wait for the step.
    public func isWorthWriting(over old: PendantSnapshot?) -> Bool {
        guard let old else { return true }
        if let newest = newestEvidence,
            newest.timeIntervalSince(old.newestEvidence ?? .distantPast) >= Self.evidenceStep
        {
            return true
        }
        return old.timeless != timeless
    }

    private var newestEvidence: Date? {
        [lastContact, microphone?.at, battery?.at, charging?.at, storage?.at, backlog?.at].compactMap(\.self).max()
    }

    /// The same values with every evidence time dropped. Storage and backlog are counters that move with every page
    /// the Pendant records, so they wait for the evidence step like the times do (a write per status report was a
    /// third of the phone's disk writes, Oct 17).
    private var timeless: PendantSnapshot {
        var copy = self
        copy.lastContact = nil
        copy.microphone?.at = .distantPast
        copy.battery?.at = .distantPast
        copy.charging?.at = .distantPast
        copy.storage = nil
        copy.backlog = nil
        return copy
    }

    /// Worth a widget reload now: what a widget or control shows changed.
    public func changesDisplay(from old: PendantSnapshot?, now: Date) -> Bool {
        guard let old else { return true }
        return link != old.link || recording(now: now).microphone != old.recording(now: now).microphone
            || request != old.request || charging?.value != old.charging?.value
            || battery.map { $0.value / 5 } != old.battery.map { $0.value / 5 }
    }

    /// The same state with current evidence where the shown one has gone "last known". Reloads are budgeted, so the
    /// app spends one on this only every so often; in between a widget honestly says "last known".
    public func refreshesEvidence(over old: PendantSnapshot?, now: Date) -> Bool {
        guard case .confirmed = recording(now: now) else { return false }
        guard let old, case .confirmed = old.recording(now: now) else { return true }
        return false
    }
}
