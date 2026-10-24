import Capture
import Foundation
import Incidents
import Testing

/// `forScreen` keeps the Pendant screen asleep through a sync: only what it shows may wake it.
struct StatusForScreenTests {
    private let start = Date(timeIntervalSince1970: 1_000_000)

    private func status(_ sync: DrainPhase, contact: TimeInterval = 0, saved: Int = 0) -> CaptureStatus {
        var status = CaptureStatus()
        status.connection = .ready(UUID(uuidString: "00000000-0000-0000-0000-000000000001")!)
        status.sync = sync
        status.lastContact = start.addingTimeInterval(contact)
        status.lastReply = start.addingTimeInterval(contact)
        status.saved.pulled = saved
        status.lastAcknowledgedIndex = UInt64(saved)
        return status
    }

    private func catchUp(_ settled: UInt64) -> DrainPhase {
        .downloading(DrainProgress(expected: 3_000, received: settled + 40, settled: settled))
    }

    @Test func pagesWithinAPercentAndAStepChangeNothingShown() {
        let shown = status(catchUp(300), saved: 300).forScreen(previous: CaptureStatus())
        let next = status(catchUp(320), contact: 1, saved: 320).forScreen(previous: shown)
        #expect(next == shown)
    }

    @Test func aWholePercentOrAStepOfContactShows() {
        let shown = status(catchUp(300), saved: 300).forScreen(previous: CaptureStatus())
        #expect(status(catchUp(330), contact: 1).forScreen(previous: shown).sync == catchUp(330))
        let later = status(catchUp(301), contact: CaptureStatus.screenStep).forScreen(previous: shown)
        #expect(later.lastContact == start.addingTimeInterval(CaptureStatus.screenStep))
    }

    /// A Pendant recording pushes a page every 1.5 s: status, download, ACK, caught up, each cycle.
    @Test func aRoutineSyncCycleChangesNothingShown() {
        let small = DrainProgress(expected: 2, received: 1, settled: 1)
        var shown = status(.requestingStatus).forScreen(previous: CaptureStatus())
        for phase: DrainPhase in [.downloading(small), .persisting(small), .acking(throughIndex: 9)] {
            let next = status(phase, contact: 1, saved: 9).forScreen(previous: shown)
            #expect(next == shown)
            shown = next
        }
        let caughtUp = status(.caughtUp(at: start), contact: 2).forScreen(previous: shown)
        #expect(caughtUp.sync == .idle)
        #expect(status(.idle, contact: 3).forScreen(previous: caughtUp) == caughtUp)
    }

    @Test func aCatchUpHoldsThroughItsAcks() {
        let shown = status(catchUp(300)).forScreen(previous: CaptureStatus())
        #expect(status(.acking(throughIndex: 300), contact: 1).forScreen(previous: shown) == shown)
        let done = status(.caughtUp(at: start), contact: 2).forScreen(previous: shown)
        #expect(done.sync == .idle)
    }

    @Test func whatScreensDoNotShowIsLeftOut() {
        let shown = status(catchUp(300), saved: 300).forScreen(previous: CaptureStatus())
        #expect(shown.saved == SavedPages())
        #expect(shown.lastAcknowledgedIndex == nil)
    }

    @Test func aFailureOrFirstReplyAlwaysShows() {
        let shown = status(catchUp(300)).forScreen(previous: CaptureStatus())
        #expect(status(.failed(.noReply), contact: 1).forScreen(previous: shown).sync == .failed(.noReply))
        var unanswered = shown
        unanswered.lastReply = nil
        #expect(status(catchUp(300), contact: 1).forScreen(previous: unanswered).lastReply != nil)
    }
}
