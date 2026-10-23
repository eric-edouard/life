import Capture
import Foundation
import PendantProtocol
import Testing

@testable import Incidents

private let now = Date(timeIntervalSince1970: 1_750_000_000)
private let pendant = UUID()

private func evaluate(
    _ connection: ConnectionState, since: TimeInterval = 0, _ change: (inout CaptureStatus) -> Void = { _ in },
    context: (inout CaptureContext) -> Void = { _ in }
) -> [CaptureCondition] {
    var status = CaptureStatus()
    status.connection = connection
    status.lastContact = now
    status.lastReply = now
    change(&status)
    var capture = CaptureContext(connectionSince: now - since)
    context(&capture)
    return CaptureCondition.evaluate(status, context: capture, now: now)
}

@Suite struct Conditions {
    @Test func anIdleAppWithNoPendantAsksToSetOneUp() {
        let fresh = evaluate(
            .idle,
            {
                $0.lastContact = nil
                $0.lastReply = nil
            }, context: { $0.hasKnownPendant = false })
        #expect(fresh == [.neverConfigured])
    }

    @Test func archiveProblemsHideEverythingElse() {
        #expect(evaluate(.bluetoothOff, context: { $0.archiveError = "locked" }) == [.archiveUnavailable("locked")])
        let locked = evaluate(
            .bluetoothOff,
            context: {
                $0.archiveError = "locked"
                $0.protectedDataAvailable = false
            })
        #expect(locked == [.protectedDataUnavailable])
    }

    @Test func bluetoothPermissionIsToldApartByItsCause() {
        #expect(
            evaluate(.idle, context: { $0.bluetoothPermission = .notDetermined }) == [.bluetoothPermissionNotDetermined]
        )
        #expect(evaluate(.idle).isEmpty, "still starting")
        #expect(evaluate(.unauthorized, context: { $0.bluetoothPermission = .denied }) == [.bluetoothDenied])
        #expect(evaluate(.unauthorized, context: { $0.bluetoothPermission = .restricted }) == [.bluetoothRestricted])
        #expect(evaluate(.bluetoothOff) == [.bluetoothOff])
    }

    @Test func scanningIsNeverConfiguredThenNotFound() {
        let fresh = evaluate(.scanning, { $0.lastContact = nil }, context: { $0.hasKnownPendant = false })
        #expect(fresh == [.neverConfigured])
        #expect(evaluate(.scanning, since: 10).isEmpty)
        #expect(evaluate(.scanning, since: 61) == [.noPendantFound(since: now - 61)])
    }

    @Test func shortDisconnectionsStayQuiet() {
        #expect(evaluate(.disconnected(pendant, .linkLost(nil)), since: 30).isEmpty)
        #expect(evaluate(.connecting(pendant), since: 121) == [.outOfReach(lastContact: now)])
        #expect(evaluate(.discovering(pendant), since: 5).isEmpty)
        #expect(evaluate(.discovering(pendant), since: 31) == [.notReady(since: now - 31)])
    }

    @Test func aKnownPendantOutOfRangeAtLaunchSaysWhenItWasLastSeen() {
        let earlier = now - 3600
        func atLaunch(_ connection: ConnectionState, since: TimeInterval) -> [CaptureCondition] {
            evaluate(
                connection, since: since,
                {
                    $0.lastContact = nil
                    $0.lastReply = nil
                }, context: { $0.lastContact = earlier })
        }
        #expect(atLaunch(.connecting(pendant), since: 3) == [.checking(since: now - 3)])
        #expect(atLaunch(.connecting(pendant), since: 11) == [.outOfReach(lastContact: earlier)])
        #expect(atLaunch(.scanning, since: 3).isEmpty, "known, so never 'not set up'")
    }

    @Test func nothingIsAllGoodBeforeThePendantAnswers() {
        let first: (inout CaptureStatus) -> Void = { $0.lastReply = nil }
        #expect(evaluate(.ready(pendant), since: 2, first) == [.checking(since: now - 2)])
        #expect(evaluate(.discovering(pendant), since: 2, first) == [.checking(since: now - 2)])
        #expect(evaluate(.discovering(pendant), since: 31, first) == [.notReady(since: now - 31)])
    }

    @Test func readyNeedsFreshTelemetry() {
        #expect(evaluate(.ready(pendant)).isEmpty)
        let stale = evaluate(.ready(pendant)) {
            $0.lastContact = now - 400
            $0.lastReply = now - 400
        }
        #expect(stale == [.staleTelemetry(lastContact: now - 400)])
    }

    @Test func storageAndRecordingProblemsStackOnTheConnection() {
        let conditions = evaluate(
            .busyElsewhere(pendant),
            {
                $0.sync = .failed(.storage("disk full"))
                $0.incidents = [.storageWriteFailed("disk full"), .recordingStoppedUnexpectedly]
            }, context: { $0.phoneFreeBytes = 100 })
        #expect(
            conditions == [
                .busyElsewhere, .recordingStopped, .storageWriteFailed("disk full"), .phoneStorageLow(freeBytes: 100),
            ])
        let incomplete = evaluate(.ready(pendant)) { $0.sync = .failed(.incomplete(missingFrom: 7)) }
        #expect(incomplete == [.transferIncomplete(missingFrom: 7)])
    }
}

@Suite struct Sync {
    private let small = DrainProgress(expected: 12, received: 3, settled: 2)
    private let large = DrainProgress(expected: 5000, received: 900, settled: 800)

    @Test func routineTransfersKeepTheLastUpToDateLine() {
        let earlier = now - 60
        #expect(SyncSummary(.downloading(small), lastCaughtUp: earlier) == .upToDate(earlier))
        #expect(SyncSummary(.requestingStatus, lastCaughtUp: earlier) == .upToDate(earlier))
        #expect(SyncSummary(.acking(throughIndex: 4), lastCaughtUp: earlier) == .upToDate(earlier))
        #expect(SyncSummary(.downloading(small), lastCaughtUp: nil) == .syncing)
        #expect(SyncSummary(.idle, lastCaughtUp: nil) == .notYet)
    }

    @Test func aRealCatchUpShowsProgressAndFailuresShow() {
        #expect(SyncSummary(.downloading(large), lastCaughtUp: now) == .catchingUp(large))
        #expect(SyncSummary(.persisting(large), lastCaughtUp: now) == .catchingUp(large))
        #expect(SyncSummary(.failed(.noReply), lastCaughtUp: now) == .failed(.noReply))
        #expect(SyncSummary(.caughtUp(at: now), lastCaughtUp: nil) == .upToDate(now))
    }
}
