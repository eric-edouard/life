import Capture
import Foundation
import Glance
import PendantProtocol
import Testing

@testable import Incidents

private let t0 = Date(timeIntervalSince1970: 1_750_000_000)
private let pendant = UUID()

private func status(_ change: (inout CaptureStatus) -> Void) -> CaptureStatus {
    var status = CaptureStatus()
    change(&status)
    return status
}

private func reported(_ state: KnownRecording, at: Date) -> CaptureStatus {
    status {
        $0.connection = .ready(pendant)
        $0.lastKnownRecording = Observed(state, at: at)
    }
}

/// The recording machine and the change notices together, as the app runs them: status after each event.
private struct Pipeline {
    var machine = RecordingControl()
    var changes = PendantChangeReducer()
    var incidents: Set<CaptureIncident> = []

    mutating func send(_ event: RecordingEvent, now: Date) -> [IncidentEffect] {
        if machine.handle(event).contains(.alertUnexpectedStop) { incidents.insert(.recordingStoppedUnexpectedly) }
        var status = CaptureStatus()
        status.connection = .ready(pendant)
        status.recording = machine.state
        status.lastKnownRecording = machine.lastObserved
        status.incidents = incidents
        return changes.reduce(status, now: now)
    }
}

@Suite struct DetectorPauses {
    @Test func detectorSilenceNeverPausesNotifiesOrAlerts() {
        var pipeline = Pipeline()
        _ = pipeline.send(.telemetry(.recording, at: t0, answersControl: false), now: t0)
        for second in stride(from: 3.0, to: 60, by: 6) {
            let quiet = pipeline.send(
                .telemetry(.notRecording, at: t0 + second, answersControl: false), now: t0 + second)
            let sound = pipeline.send(
                .telemetry(.recording, at: t0 + second + 3, answersControl: false), now: t0 + second + 3)
            #expect(quiet.isEmpty && sound.isEmpty)
            #expect(pipeline.machine.state == .recording(confirmedAt: t0 + second + 3))
        }
        #expect(pipeline.incidents.isEmpty)
    }

    @Test func longPressStopPausesAndNotifies() {
        var pipeline = Pipeline()
        _ = pipeline.send(.telemetry(.recording, at: t0, answersControl: false), now: t0)
        _ = pipeline.send(.firmwareToggle(at: t0 + 10), now: t0 + 10)
        let effects = pipeline.send(.telemetry(.notRecording, at: t0 + 11, answersControl: false), now: t0 + 11)
        #expect(pipeline.machine.state == .paused(confirmedAt: t0 + 11))
        #expect(effects == [.clear(.recordingResumedOnPendant), .post(.recordingPausedOnPendant)])
        #expect(pipeline.incidents.isEmpty, "a press is deliberate")
    }

    @Test func appPausePausesQuietly() {
        var pipeline = Pipeline()
        _ = pipeline.send(.telemetry(.recording, at: t0, answersControl: false), now: t0)
        pipeline.changes.appRequested(.pause, at: t0 + 10)
        _ = pipeline.send(.requested(.pause, at: t0 + 10), now: t0 + 10)
        let effects = pipeline.send(.telemetry(.notRecording, at: t0 + 11, answersControl: true), now: t0 + 11)
        #expect(pipeline.machine.state == .paused(confirmedAt: t0 + 11))
        #expect(effects.isEmpty)
        #expect(pipeline.incidents.isEmpty)
        // And a silence after the owner resumes stays a silence.
        pipeline.changes.appRequested(.resume, at: t0 + 20)
        _ = pipeline.send(.requested(.resume, at: t0 + 20), now: t0 + 20)
        _ = pipeline.send(.telemetry(.recording, at: t0 + 21, answersControl: true), now: t0 + 21)
        #expect(pipeline.send(.telemetry(.notRecording, at: t0 + 30, answersControl: false), now: t0 + 30).isEmpty)
        #expect(pipeline.machine.state == .recording(confirmedAt: t0 + 30))
    }
}

@Suite struct RecordingOrigin {
    @Test func buttonChangesNotifyAndAppRequestsDont() {
        var changes = PendantChangeReducer()
        #expect(changes.reduce(reported(.recording, at: t0), now: t0).isEmpty, "first report is not a change")
        // Long press on the Pendant.
        #expect(
            changes.reduce(reported(.paused, at: t0 + 10), now: t0 + 10) == [
                .clear(.recordingResumedOnPendant), .post(.recordingPausedOnPendant),
            ])
        // Resume from Life (app, Shortcut or control): confirmed a few seconds later, quietly.
        changes.appRequested(.resume, at: t0 + 20)
        #expect(changes.reduce(reported(.recording, at: t0 + 23), now: t0 + 23).isEmpty)
        // The request was used up: the next long press notifies again.
        #expect(
            changes.reduce(reported(.paused, at: t0 + 30), now: t0 + 30) == [
                .clear(.recordingResumedOnPendant), .post(.recordingPausedOnPendant),
            ])
        #expect(
            changes.reduce(reported(.recording, at: t0 + 40), now: t0 + 40) == [
                .clear(.recordingPausedOnPendant), .post(.recordingResumedOnPendant),
            ])
    }

    @Test func requestOnlyCoversItsDirectionAndWindow() {
        var changes = PendantChangeReducer()
        _ = changes.reduce(reported(.recording, at: t0), now: t0)
        changes.appRequested(.resume, at: t0)
        #expect(
            changes.reduce(reported(.paused, at: t0 + 5), now: t0 + 5) == [
                .clear(.recordingResumedOnPendant), .post(.recordingPausedOnPendant),
            ], "a pause while a resume was asked for came from the Pendant")
        changes.appRequested(.pause, at: t0 + 10)
        _ = changes.reduce(reported(.recording, at: t0 + 11), now: t0 + 11)
        let late = t0 + 10 + PendantChangeReducer.requestWindow + 1
        #expect(
            changes.reduce(reported(.paused, at: late), now: late) == [
                .clear(.recordingResumedOnPendant), .post(.recordingPausedOnPendant),
            ], "too long after the request to be its outcome")
    }

    @Test func unexpectedStopKeepsItsOwnAlertAndUnrecognizedStatesSayNothing() {
        var changes = PendantChangeReducer()
        _ = changes.reduce(reported(.recording, at: t0), now: t0)
        var stopped = reported(.paused, at: t0 + 5)
        stopped.incidents = [.recordingStoppedUnexpectedly]
        #expect(changes.reduce(stopped, now: t0 + 5).isEmpty)
        #expect(changes.reduce(reported(.unrecognized(7), at: t0 + 9), now: t0 + 9).isEmpty)
        #expect(changes.reduce(reported(.paused, at: t0 + 12), now: t0 + 12).isEmpty, "still off")
    }

    @Test func survivesRelaunch() throws {
        var changes = PendantChangeReducer()
        _ = changes.reduce(reported(.recording, at: t0), now: t0)
        var relaunched = try JSONDecoder().decode(
            PendantChangeReducer.self, from: JSONEncoder().encode(changes))
        // Paused on the Pendant while Life wasn't running; seen at the first report after relaunch.
        #expect(
            relaunched.reduce(reported(.paused, at: t0 + 600), now: t0 + 600).contains(
                .post(.recordingPausedOnPendant)))
    }
}

@Suite struct Disconnects {
    private let lost = status { $0.connection = .disconnected(pendant, .linkLost("out of range")) }
    private let ready = status { $0.connection = .ready(pendant) }
    private let after = PendantChangeReducer.disconnectAfter

    @Test func shortDisconnectStaysQuiet() {
        var changes = PendantChangeReducer()
        #expect(changes.reduce(ready, now: t0).isEmpty)
        #expect(changes.reduce(lost, now: t0 + 1) == [.schedule(.pendantDisconnected, at: t0 + 1 + after)])
        #expect(changes.reduce(lost, now: t0 + 5).isEmpty, "scheduled once")
        #expect(changes.reduce(status { $0.connection = .discovering(pendant) }, now: t0 + 30).isEmpty)
        #expect(changes.reduce(ready, now: t0 + 31) == [.unschedule(.pendantDisconnected)])
    }

    @Test func longDisconnectReportsReconnectWithBacklog() {
        var changes = PendantChangeReducer()
        _ = changes.reduce(ready, now: t0)
        _ = changes.reduce(lost, now: t0)
        let back = t0 + after + 60
        var reconnected = ready
        reconnected.backlog = Observed(Backlog(pages: 900, estimatedDuration: nil), at: t0 - 10)
        #expect(changes.reduce(reconnected, now: back).isEmpty, "the backlog is from before the outage")
        reconnected.backlog = Observed(Backlog(pages: 1_200, estimatedDuration: nil), at: back + 2)
        #expect(
            changes.reduce(reconnected, now: back + 2) == [
                .clear(.pendantDisconnected), .postReconnected(catchingUpPages: 1_200),
            ])
        #expect(changes.reduce(reconnected, now: back + 3).isEmpty)
    }

    @Test func reconnectWithoutBacklogStillReports() {
        var changes = PendantChangeReducer()
        _ = changes.reduce(ready, now: t0)
        _ = changes.reduce(lost, now: t0)
        let back = t0 + after
        #expect(changes.reduce(ready, now: back).isEmpty)
        #expect(
            changes.reduce(ready, now: back + PendantChangeReducer.backlogWait) == [
                .clear(.pendantDisconnected), .postReconnected(catchingUpPages: nil),
            ])
    }

    @Test func losingAPausedPendantStaysQuiet() {
        var changes = PendantChangeReducer()
        _ = changes.reduce(reported(.paused, at: t0), now: t0)
        #expect(changes.reduce(lost, now: t0 + 1).isEmpty)
        #expect(changes.reduce(ready, now: t0 + after + 60).isEmpty, "no reconnect notice either")
        _ = changes.reduce(reported(.recording, at: t0 + after + 70), now: t0 + after + 70)
        #expect(
            changes.reduce(lost, now: t0 + after + 80) == [.schedule(.pendantDisconnected, at: t0 + after * 2 + 80)],
            "recording again: losing it notifies")
    }

    @Test func phoneSideChangesAreNotPendantDisconnects() {
        var changes = PendantChangeReducer()
        _ = changes.reduce(ready, now: t0)
        _ = changes.reduce(lost, now: t0)
        #expect(
            changes.reduce(status { $0.connection = .bluetoothOff }, now: t0 + 10) == [
                .unschedule(.pendantDisconnected)
            ])
        #expect(changes.reduce(lost, now: t0 + 20).isEmpty, "never connected since")
        _ = changes.reduce(ready, now: t0 + 30)
        #expect(changes.reduce(status { $0.connection = .busyElsewhere(pendant) }, now: t0 + 40).isEmpty)
    }
}

@Suite struct ConfigurableAlerts {
    private func battery(_ percent: Int, charging: Bool = false) -> CaptureStatus {
        status {
            $0.batteryPercent = Observed(percent, at: t0)
            if charging { $0.charging = Observed(.charging, at: t0) }
        }
    }

    @Test func lowBatteryOncePerDischargeRearmedByCharging() {
        var reducer = IncidentReducer()
        #expect(reducer.reduce(battery(25), phoneFreeBytes: nil).isEmpty)
        #expect(reducer.reduce(battery(20), phoneFreeBytes: nil) == [.post(.batteryLow)])
        #expect(reducer.reduce(battery(12), phoneFreeBytes: nil).isEmpty, "once per discharge")
        #expect(reducer.reduce(battery(22), phoneFreeBytes: nil).isEmpty, "a wobble above the threshold isn't a charge")
        #expect(reducer.reduce(battery(12, charging: true), phoneFreeBytes: nil) == [.clear(.batteryLow)])
        #expect(reducer.reduce(battery(18), phoneFreeBytes: nil) == [.post(.batteryLow)], "next discharge")
        #expect(reducer.reduce(battery(35), phoneFreeBytes: nil) == [.clear(.batteryLow)], "charged elsewhere")
    }

    @Test func thresholdsAndTogglesComeFromSettings() {
        var settings = AlertSettings()
        settings.lowBatteryPercent = 40
        settings.lowPendantStorage = false
        var reducer = IncidentReducer()
        var low = battery(35)
        low.storage = Observed(
            StorageState(oldestPage: 0, newestPage: 0, session: 1, freePages: 1, totalPages: 100), at: t0)
        #expect(reducer.reduce(low, phoneFreeBytes: nil, settings: settings) == [.post(.batteryLow)])
        settings.lowBattery = false
        settings.lowPendantStorage = true
        settings.lowPendantStoragePercent = 5
        #expect(reducer.reduce(low, phoneFreeBytes: nil, settings: settings) == [.post(.pendantStorageLow)])
    }
}

@Suite struct SnapshotFreshness {
    private func snapshot(_ link: PendantSnapshot.Link, reportedAt: Date) -> PendantSnapshot {
        PendantSnapshot(link: link, microphone: Observed(.recording, at: reportedAt))
    }

    @Test func decidedWhenRead() {
        let connected = snapshot(.connected, reportedAt: t0)
        #expect(connected.recording(now: t0 + 4) == .confirmed(.recording, at: t0))
        #expect(connected.recording(now: t0 + 361) == .lastKnown(.recording, at: t0), "old evidence")
        #expect(connected.recordingTurnsStale(now: t0 + 4) == t0 + 361)
        // Disconnected a second ago: still only what it last said.
        #expect(snapshot(.connecting, reportedAt: t0).recording(now: t0 + 1) == .lastKnown(.recording, at: t0))
        #expect(PendantSnapshot(link: .connected).recording(now: t0) == .unknown)
    }

    @Test func relaunchKeepsEvidenceAndPendingExpires() {
        var live = CaptureStatus()
        live.connection = .ready(pendant)
        live.lastKnownRecording = Observed(.paused, at: t0)
        live.batteryPercent = Observed(82, at: t0)
        live.recording = .resumeRequested(pendingSince: t0 + 1)
        let written = PendantSnapshot(live, previous: nil)
        #expect(written.pendingRequest(now: t0 + 3) == .resume)
        #expect(written.pendingRequest(now: t0 + 120) == nil, "never resolved: the app went away")
        let relaunched = PendantSnapshot(CaptureStatus(), previous: written)
        #expect(relaunched.link == .notConnected)
        #expect(relaunched.recording(now: t0 + 5) == .lastKnown(.paused, at: t0))
        #expect(relaunched.battery == Observed(82, at: t0))
        #expect(relaunched.request == nil)
    }

    @Test func throttlesContactButNotState() {
        let base = PendantSnapshot(link: .connected, lastContact: t0, microphone: Observed(.recording, at: t0))
        var moved = base
        moved.lastContact = t0 + 5
        #expect(!moved.isWorthWriting(over: base))
        moved.lastContact = t0 + 60
        #expect(moved.isWorthWriting(over: base))
        var reported = base
        reported.microphone = Observed(.recording, at: t0 + 5)
        reported.battery = Observed(80, at: t0 + 5)
        #expect(reported.isWorthWriting(over: base), "a new battery value")
        var fresher = reported
        fresher.lastContact = t0 + 10
        fresher.microphone?.at = t0 + 10
        fresher.battery?.at = t0 + 10
        #expect(!fresher.isWorthWriting(over: reported), "only fresher times")
        fresher.microphone?.at = t0 + 65
        #expect(fresher.isWorthWriting(over: reported))
        var counted = reported
        counted.storage = Observed(.init(freePages: 999, totalPages: 1000), at: t0 + 10)
        counted.backlog = Observed(3, at: t0 + 10)
        #expect(!counted.isWorthWriting(over: reported), "counters move with every page")
        var paused = base
        paused.microphone = Observed(.paused, at: t0 + 1)
        #expect(paused.isWorthWriting(over: base))
        #expect(paused.changesDisplay(from: base, now: t0 + 1))
        var refreshed = base
        refreshed.microphone = Observed(.recording, at: t0 + 600)
        #expect(!refreshed.changesDisplay(from: base, now: t0 + 600))
        #expect(refreshed.refreshesEvidence(over: base, now: t0 + 600))
        #expect(!refreshed.refreshesEvidence(over: refreshed, now: t0 + 600))
    }
}

/// A paused Pendant sends nothing until it changes, so its pause stays current for as long as the link that confirmed
/// it is up, and no longer.
@Suite struct HeldPause {
    /// The machine through a confirmed app pause, as the app runs it.
    private func pausedMachine() -> RecordingControl {
        var machine = RecordingControl()
        _ = machine.handle(.requested(.pause, at: t0))
        _ = machine.handle(.telemetry(.notRecording, at: t0 + 1, answersControl: true))
        return machine
    }

    private func snapshot(_ machine: RecordingControl, connected: Bool = true) -> PendantSnapshot {
        var status = CaptureStatus()
        status.connection = connected ? .ready(pendant) : .disconnected(pendant, .linkLost(nil))
        status.recording = machine.state
        status.lastKnownRecording = machine.lastObserved
        return PendantSnapshot(status, previous: nil)
    }

    private func glance(_ snapshot: PendantSnapshot, now: Date) -> RecordingGlance {
        RecordingGlance(snapshot, sound: nil, lowBatteryPercent: 20, now: now)
    }

    @Test func staysCurrentWhileTheLinkIsUp() {
        let held = snapshot(pausedMachine())
        let hourLater = t0 + 3_600
        #expect(held.recording(now: hourLater) == .confirmed(.paused, at: t0 + 1), "with the report's own time")
        #expect(held.recordingTurnsStale(now: hourLater) == .distantFuture)
        #expect(glance(held, now: t0 + 2).reading(now: hourLater) == .confirmed(.paused, at: t0 + 1))
    }

    @Test func goesLastKnownAfterADisconnect() {
        var machine = pausedMachine()
        _ = machine.handle(.connectionLost)
        let lost = snapshot(machine, connected: false)
        #expect(lost.recording(now: t0 + 2) == .lastKnown(.paused, at: t0 + 1))
        #expect(glance(lost, now: t0 + 2).reading(now: t0 + 2) == .lastKnown(.paused, at: t0 + 1))
        // Back in reach: the Pendant may have been long-pressed meanwhile, so the old pause holds nothing.
        let back = snapshot(machine)
        #expect(back.recording(now: t0 + 400) == .lastKnown(.paused, at: t0 + 1))
        #expect(glance(back, now: t0 + 400).reading(now: t0 + 400) == .lastKnown(.paused, at: t0 + 1))
    }

    @Test func recordingStillAgesOut() {
        var machine = RecordingControl()
        _ = machine.handle(.requested(.resume, at: t0))
        _ = machine.handle(.telemetry(.recording, at: t0 + 1, answersControl: true))
        let recording = snapshot(machine)
        #expect(recording.recording(now: t0 + 300) == .confirmed(.recording, at: t0 + 1))
        #expect(recording.recording(now: t0 + 400) == .lastKnown(.recording, at: t0 + 1))
        #expect(recording.recordingTurnsStale(now: t0 + 2) == t0 + 362)
        #expect(glance(recording, now: t0 + 2).reading(now: t0 + 400) == .lastKnown(.recording, at: t0 + 1))
    }

    @Test func olderSnapshotsHoldNothing() {
        let old = PendantSnapshot(link: .connected, microphone: Observed(.paused, at: t0))
        #expect(old.recording(now: t0 + 400) == .lastKnown(.paused, at: t0))
    }
}
