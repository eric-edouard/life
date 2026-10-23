import Capture
import Foundation
import PendantProtocol
import Testing

@testable import Incidents

private let t0 = Date(timeIntervalSince1970: 1_750_000_000)

@Suite struct Freshness {
    @Test func neverObservedIsUnknown() {
        #expect(EvidenceFreshness(observedAt: nil, now: t0) == .unknown)
    }

    @Test func withinOneCycleIsFreshThenStale() {
        #expect(EvidenceFreshness(observedAt: t0, now: t0 + 360) == .fresh)
        #expect(EvidenceFreshness(observedAt: t0, now: t0 + 361) == .stale)
        #expect(EvidenceFreshness(observedAt: t0, now: t0 + 30, freshFor: .seconds(10)) == .stale)
    }

    @Test func onScreenEvidenceOutlivesMissedRefreshes() {
        let refresh = Double(DrainCoordinator.liveRefresh.components.seconds)
        let onScreen = EvidenceFreshness.onScreenFor
        #expect(EvidenceFreshness(observedAt: t0, now: t0 + 2 * refresh, freshFor: onScreen) == .fresh)
        #expect(EvidenceFreshness(observedAt: t0, now: t0 + 75, freshFor: onScreen) == .fresh)
        #expect(EvidenceFreshness(observedAt: t0, now: t0 + 76, freshFor: onScreen) == .stale)
        #expect(onScreen < EvidenceFreshness.freshFor)
    }
}

@Suite struct IncidentNotifications {
    private func status(_ change: (inout CaptureStatus) -> Void) -> CaptureStatus {
        var status = CaptureStatus()
        change(&status)
        return status
    }

    @Test func unexpectedStopNotifiesOnceAndClearsOnlyWhenRecordingResumes() {
        var reducer = IncidentReducer()
        let stopped = status { $0.incidents = [.recordingStoppedUnexpectedly] }
        #expect(reducer.reduce(stopped, phoneFreeBytes: nil) == [.post(.recordingStopped)])
        #expect(reducer.reduce(stopped, phoneFreeBytes: nil).isEmpty, "warn once")
        // A disconnect resets the recording state to unknown: not a recovery.
        #expect(reducer.reduce(status { $0.recording = .unknown }, phoneFreeBytes: nil).isEmpty)
        let resumed = status { $0.recording = .recording(confirmedAt: t0) }
        #expect(reducer.reduce(resumed, phoneFreeBytes: nil) == [.clear(.recordingStopped)])
        #expect(reducer.reduce(stopped, phoneFreeBytes: nil) == [.post(.recordingStopped)], "a new incident")
    }

    @Test func deliberatePauseAndShortDisconnectsNeverNotify() {
        var reducer = IncidentReducer()
        let quiet = [
            status { $0.recording = .paused(confirmedAt: t0) },
            status { $0.recording = .pauseRequested(pendingSince: t0) },
            status { $0.connection = .disconnected(UUID(), .linkLost("out of range")) },
            status { $0.connection = .bluetoothOff },
        ]
        for snapshot in quiet { #expect(reducer.reduce(snapshot, phoneFreeBytes: nil).isEmpty) }
    }

    @Test func freshLaunchIsNotRecovery() throws {
        var reducer = IncidentReducer()
        _ = reducer.reduce(status { $0.incidents = [.storageWriteFailed("disk full")] }, phoneFreeBytes: nil)
        // Relaunch: state restored, snapshot empty. Neither cleared nor re-notified.
        var relaunched = try JSONDecoder().decode(IncidentReducer.self, from: JSONEncoder().encode(reducer))
        #expect(relaunched.reduce(CaptureStatus(), phoneFreeBytes: nil).isEmpty)
        #expect(
            relaunched.reduce(status { $0.incidents = [.storageWriteFailed("again")] }, phoneFreeBytes: nil).isEmpty)
        let caughtUp = status { $0.sync = .caughtUp(at: t0) }
        #expect(relaunched.reduce(caughtUp, phoneFreeBytes: nil) == [.clear(.storageWriteFailed)])
    }

    @Test func integrityLatchesAcrossManyIndices() {
        var reducer = IncidentReducer()
        let one = status { $0.incidents = [.integrityConflict(index: 5)] }
        let many = status { $0.incidents = [.integrityConflict(index: 5), .encryptedAudio(index: 9)] }
        #expect(reducer.reduce(one, phoneFreeBytes: nil) == [.post(.integrity)])
        #expect(reducer.reduce(many, phoneFreeBytes: nil).isEmpty)
        #expect(reducer.reduce(status { $0.sync = .caughtUp(at: t0) }, phoneFreeBytes: nil).isEmpty)
    }

    @Test func storageHasHysteresis() {
        var reducer = IncidentReducer()
        func pendant(free: UInt64) -> CaptureStatus {
            status {
                let state = StorageState(oldestPage: 0, newestPage: 0, session: 1, freePages: free, totalPages: 100)
                $0.storage = Observed(state, at: t0)
            }
        }
        #expect(
            reducer.reduce(pendant(free: 5), phoneFreeBytes: 500 << 20) == [
                .post(.pendantStorageLow), .post(.phoneStorageLow),
            ])
        #expect(reducer.reduce(pendant(free: 15), phoneFreeBytes: 1500 << 20).isEmpty, "between thresholds")
        #expect(
            reducer.reduce(pendant(free: 20), phoneFreeBytes: 3 << 30) == [
                .clear(.pendantStorageLow), .clear(.phoneStorageLow),
            ])
    }

    @Test func noContactIsADeadManSwitch() {
        var reducer = IncidentReducer()
        let day = IncidentReducer.noContactAfter
        func contact(_ at: Date) -> CaptureStatus { status { $0.lastContact = at } }
        #expect(
            reducer.reduce(contact(t0), phoneFreeBytes: nil) == [
                .clear(.noContact), .schedule(.noContact, at: t0 + day),
            ])
        #expect(reducer.reduce(contact(t0 + 60), phoneFreeBytes: nil).isEmpty, "throttled")
        let later = t0 + IncidentReducer.rescheduleStep
        #expect(reducer.reduce(contact(later), phoneFreeBytes: nil) == [.schedule(.noContact, at: later + day)])
        // Contact again after the deadline passed: the delivered alert recovers.
        let back = later + day + 1
        #expect(
            reducer.reduce(contact(back), phoneFreeBytes: nil) == [
                .clear(.noContact), .schedule(.noContact, at: back + day),
            ])
        let busy = status {
            $0.lastContact = back + 600
            $0.connection = .busyElsewhere(UUID())
        }
        #expect(reducer.reduce(busy, phoneFreeBytes: nil) == [.unschedule(.noContact)])
        #expect(reducer.reduce(busy, phoneFreeBytes: nil).isEmpty)
    }
}
