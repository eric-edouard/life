import Capture
import Foundation
import PendantProtocol
import Testing

@testable import Incidents

private let now = Date(timeIntervalSince1970: 1_750_000_000)
private let pendant = UUID()

/// A connected Pendant that reported recording 6 s ago, with room on its flash.
private func healthy() -> CaptureStatus {
    var status = CaptureStatus()
    status.connection = .ready(pendant)
    status.recording = .recording(confirmedAt: now - 6)
    status.lastKnownRecording = Observed(.recording, at: now - 6)
    status.batteryPercent = Observed(82, at: now - 6)
    status.storage = Observed(
        StorageState(oldestPage: 0, newestPage: 100, session: 1, freePages: 30_000, totalPages: 40_000), at: now - 6)
    status.lastContact = now - 6
    status.lastReply = now - 6
    return status
}

private func reading(
    _ status: CaptureStatus, since: TimeInterval = 3_600, known: Bool = true, lowBattery: Int? = 20,
    recordingSince: Date? = nil
) -> PendantReading {
    PendantReading(
        status: status, context: CaptureContext(hasKnownPendant: known, connectionSince: now - since),
        recordingSince: recordingSince, lowBatteryPercent: lowBattery, now: now)
}

@Suite struct PendantReadings {
    @Test func aConfirmedRecordingIsRecordingWithItsStart() {
        let began = now - 1_920
        let recording = reading(healthy(), recordingSince: began)
        #expect(recording.state == .recording)
        #expect(!recording.isFlag && recording.conditions.isEmpty && recording.lowBattery == nil)
        #expect(recording.since == began)
    }

    @Test func aPauseOnThePendantSaysWhenItWasPressed() {
        var status = healthy()
        status.recording = .paused(confirmedAt: now - 20)
        status.lastKnownRecording = Observed(.paused, at: now - 20)
        status.lastButton = Observed(.long, at: now - 24)
        let paused = reading(status, recordingSince: now - 1_000)
        #expect(paused.state == .notRecording)
        #expect(paused.pausedAt == now - 24)
        #expect(paused.since == nil)
        #expect(!paused.isFlag)
        status.lastButton = Observed(.long, at: now - 3_000)
        #expect(reading(status).pausedAt == nil)
    }

    @Test func outOfReachIsOutOfRangeAndFlagged() {
        var status = healthy()
        status.connection = .disconnected(pendant, .linkLost(nil))
        status.recording = .unknown
        let lost = reading(status, since: 600)
        #expect(lost.state == .outOfRange)
        #expect(lost.isFlag)
        #expect(lost.needs == 0)
    }

    @Test func aLinkBlockerIsNotConnected() {
        var status = healthy()
        status.connection = .bluetoothOff
        status.recording = .unknown
        let off = reading(status)
        #expect(off.state == .notConnected)
        #expect(off.isFlag && off.conditions == [.bluetoothOff])
    }

    @Test func noPendantHasNoProblemsOfItsOwn() {
        var status = CaptureStatus()
        status.connection = .idle
        let none = reading(status, known: false)
        #expect(none.state == .noPendant)
        #expect(none.conditions.isEmpty && !none.isFlag)
    }

    @Test func fullStorageOnAConnectedPendantIsFull() {
        var status = healthy()
        status.storage = Observed(
            StorageState(oldestPage: 0, newestPage: 100, session: 1, freePages: 0, totalPages: 40_000), at: now - 6)
        let full = reading(status)
        #expect(full.state == .full)
        #expect(full.isFlag && full.conditions == [.pendantStorageFull])
    }

    @Test func aLowBatteryNamesItsLevelOnlyWhileCurrentAndOn() {
        var status = healthy()
        status.batteryPercent = Observed(12, at: now - 6)
        #expect(reading(status).lowBattery == 12)
        #expect(reading(status, lowBattery: nil).lowBattery == nil)
        status.charging = Observed(.charging, at: now - 6)
        #expect(reading(status).lowBattery == nil)
    }

    @Test func onlyOwnerWorkCountsForTheItem() {
        var status = healthy()
        status.sync = .failed(.incomplete(missingFrom: 7))
        #expect(reading(status).needs == 1)
    }
}
