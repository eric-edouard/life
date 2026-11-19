import Capture
import Incidents
import Library
import OwnerSettings
import PendantProtocol
import ServerAPI
import SourceStore
import SwiftUI
import Timeline
import Upload

/// A device fact with how much to trust it, decided once where `now` is known so rows never need a clock.
enum Fact<Value: Equatable>: Equatable {
    /// Reported by a connected Pendant within one sync cycle.
    case current(Value, at: Date)
    /// True when reported, maybe not now.
    case lastKnown(Value, at: Date)
    case unknown

    var value: Value? {
        switch self {
        case .current(let value, _), .lastKnown(let value, _): value
        case .unknown: nil
        }
    }

    var at: Date? {
        switch self {
        case .current(_, let at), .lastKnown(_, let at): at
        case .unknown: nil
        }
    }
}

extension Fact where Value: Sendable {
    init(_ observed: Observed<Value>?, connected: Bool, now: Date) {
        guard let observed else {
            self = .unknown
            return
        }
        self =
            EvidenceFreshness.isCurrent(observed.at, connected: connected, now: now)
            ? .current(observed.value, at: observed.at) : .lastKnown(observed.value, at: observed.at)
    }
}

/// What capture knows, as plain values.
struct CaptureFacts: Equatable {
    var status: CaptureStatus
    var context: CaptureContext
    var lastCaughtUp: Date?
    var lastSaved: Date?
    var phoneFreeBytes: Int64?
    var archiveBytes: Int64?
    var incidents: [IncidentItem] = []
    /// When the recording going on now began, if the Pendant confirmed it (`CaptureStatus.recordingSince`).
    var recordingSince: Date?
    var batteryLife = BatteryLife()
    /// The owner dictating to the Mac since then (the feed's `mac.dictatingSince`), shown beside capture's facts.
    var macDictatingSince: Date?
    /// The paired pendant's kind, kept from before this launch (`CaptureStore.pairedKind`).
    var pairedKind = DeviceKind.limitless
    /// Where the uploader stands, `nil` until it said (`SyncStore.uploads`).
    var uploads: UploadStatus?
}

extension CaptureFacts {
    init(_ capture: CaptureStore, macDictatingSince: Date?, uploads: UploadStatus? = nil) {
        self.init(
            status: capture.shown, context: capture.context, lastCaughtUp: capture.lastCaughtUp,
            lastSaved: capture.lastSavedCapture, phoneFreeBytes: capture.phoneFreeBytes,
            archiveBytes: capture.archive?.totalBytes,
            incidents: capture.openIncidents.map { IncidentItem($0, audioAt: capture.incidentAudioTimes[$0.id]) }
                .grouped(),
            recordingSince: capture.shown.recordingSince(capture.recordingChanges), batteryLife: capture.batteryLife,
            macDictatingSince: macDictatingSince, pairedKind: CaptureStore.pairedKind, uploads: uploads)
    }

    /// The moments a shown fact could change without any new event: evidence going stale, a scan or reconnect
    /// lasting long enough to say so. The screen re-reads only then; the "N sec ago" texts count on their own.
    func boundaries(after now: Date) -> [Date] {
        let since = context.connectionSince
        let observed: [Date?] = [
            status.recording.reportedAt, status.lastKnownRecording?.at, status.batteryPercent?.at,
            status.storage?.at, status.backlog?.at, status.lastContact ?? since,
        ]
        var dates = observed.compactMap { $0.map(EvidenceFreshness.currentUntil) }
        if let report = status.recording.reportedAt {
            dates.append(report.addingTimeInterval(Double(EvidenceFreshness.onScreenFor.components.seconds) + 1))
        }
        dates += [
            CaptureCondition.checkingFor, CaptureCondition.noPendantAfter, CaptureCondition.notReadyAfter,
            CaptureCondition.outOfReachAfter,
        ]
        .map { since.addingTimeInterval($0 + 1) }
        if let press = status.lastButton?.at { dates.append(press.addingTimeInterval(PendantReading.longPressWindow)) }
        return [now] + dates.filter { $0 > now }.sorted()
    }
}

extension RecordingState {
    /// When the Pendant reported the state shown, if it did.
    var reportedAt: Date? {
        switch self {
        case .recording(let at), .paused(let at): at
        default: nil
        }
    }
}

/// What the server, the driver and the Mac say that the Pendant screen shows.
struct TranscriptionFacts: Equatable {
    var isPaired = true
    /// The owner's switches, `nil` until the server said.
    var switches: ServerClient.Switches?
    /// Live conversations waiting, by the feed's reason.
    var waiting: [WaitingReason: Int] = [:]
    var macLlm: ServerClient.MacLLM?

    /// Why conversations wait for the Mac, as the Mac itself says it.
    var macDetail: String {
        switch macLlm?.reason {
        case .auth?:
            switches?.engine == .codex
                ? "Your Mac needs a ChatGPT login: Lifelog Host → Settings → Summaries."
                : "Your Mac needs a Claude login: Lifelog Host → Settings → Summaries."
        case .limit?: "Your subscription limit is reached; it resumes when the limit resets."
        default: "They go on once your Mac is awake and online."
        }
    }
}

/// "1 conversation", "5 conversations".
func conversationCount(_ count: Int) -> String {
    String(AttributedString(localized: "^[\(count) conversation](inflect: true)").characters)
}

extension TranscriptionFacts {
    init(_ sync: SyncStore) {
        self.init(
            isPaired: sync.isPaired, switches: sync.switches,
            waiting: sync.waiting, macLlm: sync.feed.mac?.llm)
    }
}

extension NotOnTheMac {
    /// "12 min on the pendant, 4 min on this phone": what is held back, as far as it is known.
    var words: String? {
        func time(_ duration: Duration) -> String { duration.shortWords }
        var parts: [String] = []
        if let pages = pendantPages, pages > 0 {
            parts.append(pendantDuration.map { "\(time($0)) on the pendant" } ?? "Audio still on the pendant")
        }
        if phoneDuration > .zero { parts.append("\(time(phoneDuration)) on this phone") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// A sentence about what is held back, "The 42 min still on this pendant and 4 min on this phone are <tail>", or
    /// `nil` when nothing is known to be held.
    func sentence(_ tail: String) -> String? {
        var parts: [String] = []
        var isPlural = true
        if let pages = pendantPages, pages > 0 {
            if let duration = pendantDuration {
                parts.append("\(duration.shortWords) still on this pendant")
            } else {
                parts.append("audio still on this pendant")
                isPlural = false
            }
        }
        if phoneDuration > .zero { parts.append("\(phoneDuration.shortWords) on this phone") }
        guard !parts.isEmpty else { return nil }
        return "The \(parts.joined(separator: " and ")) \(isPlural || parts.count > 1 ? "are" : "is") \(tail)"
    }
}

extension Duration {
    /// "42 min", "1 hr 5 min".
    var shortWords: String { formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, maximumUnitCount: 2)) }
}
