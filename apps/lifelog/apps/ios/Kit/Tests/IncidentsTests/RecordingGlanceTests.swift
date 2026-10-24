import Capture
import Foundation
import Glance
import Testing

@testable import Incidents

private let t0 = Date(timeIntervalSince1970: 1_750_000_000)

/// A glance as the app builds it, from a snapshot taken `at` seconds after t0.
private func glance(
    _ microphone: PendantSnapshot.Microphone? = .recording, link: PendantSnapshot.Link = .connected,
    at seconds: TimeInterval, battery: Int = 80, sound: SoundActivity? = nil, request: PendantSnapshot.Request? = nil
) -> RecordingGlance {
    let now = t0 + seconds
    let snapshot = PendantSnapshot(
        link: link, microphone: microphone.map { Observed($0, at: now) }, request: request,
        battery: Observed(battery, at: now))
    return RecordingGlance(
        snapshot, sound: sound.map { Observed($0, at: now) }, lowBatteryPercent: 20, now: now)
}

/// What the Watch hears of a change, by kind.
@Suite struct RecordingGlanceChanges {
    @Test func steadyRecordingOnlyRefreshesItsEvidence() {
        #expect(glance(at: 5).change(from: glance(at: 0)) == .none)
        #expect(glance(at: RecordingGlance.refreshAfter).change(from: glance(at: 0)) == .evidence)
        // A refresh lands before the shown evidence goes stale.
        #expect(RecordingGlance.refreshAfter < Double(EvidenceFreshness.freshFor.components.seconds))
    }

    @Test func batteryDrainIsNotAChangeButCrossingTheThresholdIs() {
        #expect(glance(at: 5, battery: 79).change(from: glance(at: 0, battery: 80)) == .none)
        #expect(glance(at: 5, battery: 20).change(from: glance(at: 0, battery: 60)) == .state)
    }

    @Test func pauseResumeAndTheLinkChangeAtOnce() {
        let asked = PendantSnapshot.Request(intent: .pause, since: t0 + 5, failed: false)
        #expect(glance(at: 5, request: asked).change(from: glance(at: 0)) == .state)
        #expect(glance(.paused, at: 7).change(from: glance(at: 0)) == .state)
        #expect(glance(link: .connecting, at: 0).change(from: glance(at: 0)) == .state)
    }

    @Test func soundIsItsOwnChangeAndOnlyShownWhileRecording() {
        let quiet = glance(at: 0, sound: .quiet(since: t0))
        #expect(glance(at: 5, sound: .hearing(since: t0)).change(from: quiet) == .sound)
        #expect(glance(.paused, at: 0, sound: .hearing(since: t0)).heard == nil)
    }
}

@Suite struct RecordingGlanceReading {
    @Test func neverFresherThanTheEvidence() {
        let shown = glance(at: 0)
        #expect(shown.reading(now: t0 + 60) == .confirmed(.recording, at: t0))
        #expect(shown.reading(now: t0 + 400) == .lastKnown(.recording, at: t0))
        #expect(glance(link: .connecting, at: 0).reading(now: t0) == .lastKnown(.recording, at: t0))
        #expect(glance(nil, at: 0).reading(now: t0) == .unknown)
    }

    @Test func aRequestStopsWaitingWhenItExpires() {
        let asked = PendantSnapshot.Request(intent: .pause, since: t0, failed: false)
        let pending = glance(at: 0, request: asked)
        #expect(pending.pendingRequest(now: t0 + 10) == .pause)
        #expect(pending.pendingRequest(now: t0 + PendantSnapshot.requestExpiry) == nil)
        #expect(pending.changeDates.min() == t0 + PendantSnapshot.requestExpiry)
    }

    @Test func batteryIsKeptAsLastKnownAndJudgedOnTheWatchsClock() {
        let snapshot = PendantSnapshot(
            link: .connected, microphone: Observed(.recording, at: t0), battery: Observed(10, at: t0))
        let sent = RecordingGlance(snapshot, sound: nil, lowBatteryPercent: 20, now: t0)
        #expect(sent.batteryIsCurrent(now: t0 + 60) && sent.batteryIsLow(now: t0 + 60))
        // Later on the Watch, no newer glance: the same level, last known, never "low".
        #expect(!sent.batteryIsCurrent(now: t0 + 400) && !sent.batteryIsLow(now: t0 + 400))
        #expect(sent.changeDates.contains(sent.batteryCurrentUntil!))
        // Off or out of reach when sent: last known from the start.
        var off = snapshot
        off.link = .notConnected
        let lost = RecordingGlance(off, sound: nil, lowBatteryPercent: 20, now: t0)
        #expect(lost.battery == 10 && lost.batteryCurrentUntil == nil && !lost.batteryLow)
    }

    @Test func aGlanceFromAnOlderPhoneDecodesAsLastKnown() throws {
        let old = try JSONDecoder().decode(
            RecordingGlance.self, from: Data(#"{"connected":true,"battery":12,"batteryLow":true}"#.utf8))
        #expect(old.battery == 12 && !old.batteryIsCurrent(now: t0) && !old.batteryIsLow(now: t0))
    }
}
