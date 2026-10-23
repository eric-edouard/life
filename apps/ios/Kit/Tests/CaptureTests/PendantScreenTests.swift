import Foundation
import PendantProtocol
import Testing
import Timeline

@testable import Capture

@Suite(.timeLimit(.minutes(1))) struct LightBrightnessSteps {
    @Test func stepsBrightenFromOff() {
        #expect(LightBrightness.allCases.map(\.level) == [0, 10, 35, 65, 100], "the command takes 0 to 100")
    }

    @Test func aStepIsSentToTheConnectedPendant() async {
        let harness = Harness(.observe)
        #expect(await !harness.coordinator.setLightBrightness(.low), "nothing to send to while disconnected")
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            #expect(await harness.coordinator.setLightBrightness(.dimmest))
            #expect(await eventually { await harness.fake.ledBrightness == 10 })
            #expect(await harness.fake.commands.contains(.setLEDBrightness(10)))
            #expect(await harness.coordinator.setLightBrightness(.off))
            #expect(await eventually { await harness.fake.ledBrightness == 0 })
        }
    }
}

@Suite struct RecordingSince {
    private let t0 = Date(timeIntervalSince1970: 1_750_000_000)

    private func change(_ kind: RecordingChange.Kind, _ seconds: TimeInterval) -> RecordingChange {
        RecordingChange(kind, at: CaptureInstant(millis: Int64((t0.timeIntervalSince1970 + seconds) * 1000)))
    }

    private func status(_ recording: RecordingState) -> CaptureStatus {
        var status = CaptureStatus()
        status.recording = recording
        return status
    }

    @Test func theLatestConfirmedResumeStartsTheStretch() {
        let recording = status(.recording(confirmedAt: t0 + 600))
        let changes = [change(.paused, 100), change(.resumed, 300), change(.resumed, 50)]
        #expect(recording.recordingSince(changes) == t0 + 300)
    }

    @Test func unknownWhenNothingSaysWhenItStarted() {
        let recording = status(.recording(confirmedAt: t0 + 600))
        #expect(recording.recordingSince([]) == nil, "it was already recording when Life first heard")
        #expect(
            recording.recordingSince([change(.resumed, 100), change(.paused, 200)]) == nil,
            "it came back on without a confirmed resume")
    }

    @Test func onlyWhileConfirmedRecording() {
        let changes = [change(.resumed, 100)]
        #expect(status(.paused(confirmedAt: t0 + 600)).recordingSince(changes) == nil)
        #expect(status(.unknown).recordingSince(changes) == nil)
        #expect(status(.pauseRequested(pendingSince: t0 + 600)).recordingSince(changes) == nil)
    }
}
