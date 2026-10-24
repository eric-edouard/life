import Capture
import Incidents
import Library
import OwnerSettings
import PendantProtocol
import ServerAPI
import SourceStore
import SwiftUI
import Timeline

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
}

extension CaptureFacts {
    init(_ capture: CaptureStore, macDictatingSince: Date?) {
        self.init(
            status: capture.shown, context: capture.context, lastCaughtUp: capture.lastCaughtUp,
            lastSaved: capture.lastSavedCapture, phoneFreeBytes: capture.phoneFreeBytes,
            archiveBytes: capture.archive?.totalBytes,
            incidents: capture.openIncidents.map { IncidentItem($0, audioAt: capture.incidentAudioTimes[$0.id]) }
                .grouped(),
            recordingSince: capture.shown.recordingSince(capture.recordingChanges), batteryLife: capture.batteryLife,
            macDictatingSince: macDictatingSince, pairedKind: CaptureStore.pairedKind)
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
        if let sound = status.soundActivity?.at { dates.append(sound.addingTimeInterval(SoundActivity.freshFor + 1)) }
        if let report = status.recording.reportedAt {
            dates.append(report.addingTimeInterval(Double(EvidenceFreshness.onScreenFor.components.seconds) + 1))
        }
        dates += [
            CaptureCondition.checkingFor, CaptureCondition.noPendantAfter, CaptureCondition.notReadyAfter,
            CaptureCondition.outOfReachAfter,
        ]
        .map { since.addingTimeInterval($0 + 1) }
        if let press = status.lastButton?.at { dates.append(press.addingTimeInterval(HeroReading.longPressWindow)) }
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
    /// What lifelog spent, `nil` until the server answered.
    var spending: Spending?

    /// Something the owner can act on; the rest of processing shows in the status and its sheet.
    var needsOwner: Bool {
        !isPaired || switches?.transcription == false || switches?.ai == false
            || waiting[.creditsOut] != nil || waiting[.macAway] != nil
    }

    /// The server's estimates at list prices.
    struct Spending: Equatable {
        /// Everything spent today: transcription, summaries, place names and search.
        var today: Double
        /// Transcription this month.
        var monthTranscription: Double
    }
}

extension TranscriptionFacts {
    init(_ sync: SyncStore) {
        self.init(
            isPaired: sync.isPaired, switches: sync.switches,
            waiting: sync.waiting, macLlm: sync.feed.mac?.llm,
            spending: sync.spending.map {
                Spending(today: $0.today.totalUsd, monthTranscription: $0.thisMonth.transcription.usd)
            })
    }
}
