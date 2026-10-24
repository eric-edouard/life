import Foundation
import Testing

@testable import Capture

@Suite struct FreezeWatchTests {
    private let start = Date(timeIntervalSince1970: 1_000_000)

    /// Fires every `period` for `seconds`, the beat stamped by `beat` at each fire; returns whether any said frozen.
    private func run(seconds: TimeInterval, every gap: TimeInterval = FreezeDetector.period, beat: (Date) -> Date)
        -> Bool
    {
        var detector = FreezeDetector()
        var frozen = false
        for t in stride(from: 0, through: seconds, by: gap) {
            let now = start + t
            frozen = detector.fire(at: now, beat: beat(now)) || frozen
        }
        return frozen
    }

    private let beat = TimeInterval(DrainCoordinator.beatInterval.components.seconds)

    @Test func aBeatingCoordinatorIsNeverFrozen() {
        // The coordinator beats every `beatInterval`, the watch fires twice as often: every other fire sees the same beat.
        #expect(!run(seconds: 3600) { now in now - now.timeIntervalSince(start).truncatingRemainder(dividingBy: beat) })
    }

    @Test func noBeatForTwoMinutesOfRunningIsFrozen() {
        #expect(!run(seconds: FreezeDetector.limit - FreezeDetector.period) { _ in start })
        #expect(run(seconds: FreezeDetector.limit) { _ in start })
    }

    @Test func timeSpentSuspendedNeverCounts() {
        // A phone asleep, woken once every 10 minutes: a stuck beat adds nothing, as each fire follows a suspension.
        #expect(!run(seconds: 24 * 3600, every: 600) { _ in start })
    }

    @Test func aFreezeAcrossShortWakesIsStillFound() {
        // On Oct 21 iOS resumed the frozen app for 10 s to 6 min at a time (152 s first): each wake adds its running
        // time but its first fire. Woken 45 s every 5 minutes, it is found on the third wake.
        var detector = FreezeDetector()
        var frozenAt: Int?
        for wake in 0..<10 {
            for t in stride(from: 0.0, through: 45, by: FreezeDetector.period) {
                if detector.fire(at: start + Double(wake) * 300 + t, beat: start), frozenAt == nil { frozenAt = wake }
            }
        }
        #expect(frozenAt == 2, "45 + 45 + 30 s of running")
    }

    @Test func theCoordinatorBeatsWhileItRuns() async {
        let harness = Harness(.observe)
        await harness.run {
            #expect(await eventually { harness.coordinator.lastBeat != .distantPast })
            let first = harness.coordinator.lastBeat
            await harness.advanceClock(by: DrainCoordinator.beatInterval)
            #expect(await eventually { harness.coordinator.lastBeat > first })
        }
    }
}
