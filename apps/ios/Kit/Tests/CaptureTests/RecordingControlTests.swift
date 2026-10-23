import Foundation
import PendantProtocol
import Testing
import Timeline

@testable import Capture

@Suite struct RecordingMachine {
    private let t0 = Date(timeIntervalSince1970: 1_750_000_000)

    private func recordingMachine() -> RecordingControl {
        var machine = RecordingControl()
        _ = machine.handle(.telemetry(.recording, at: t0, answersControl: false))
        return machine
    }

    @Test func pauseIsPendingUntilTheStatusReplyConfirmsIt() {
        var machine = recordingMachine()
        #expect(machine.handle(.requested(.pause, at: t0)) == [.send(.stopRecording), .confirmByStatusQuery])
        #expect(machine.state == .pauseRequested(pendingSince: t0))
        // Unsolicited telemetry (or a successful write) is not a confirmation.
        _ = machine.handle(.telemetry(.notRecording, at: t0, answersControl: false))
        #expect(machine.state == .pauseRequested(pendingSince: t0))
        let effects = machine.handle(.telemetry(.notRecording, at: t0 + 1, answersControl: true))
        #expect(machine.state == .paused(confirmedAt: t0 + 1))
        #expect(!effects.contains(.alertUnexpectedStop), "a deliberate pause is never a failure")
    }

    @Test func unconfirmedPauseFailsInsteadOfSucceeding() {
        var machine = recordingMachine()
        _ = machine.handle(.requested(.pause, at: t0))
        _ = machine.handle(.confirmationTimedOut(at: t0 + 10))
        #expect(machine.state == .failed(.unconfirmed(.pause), at: t0 + 10))
        _ = machine.handle(.telemetry(.recording, at: t0 + 20, answersControl: false))
        #expect(machine.state == .failed(.unconfirmed(.pause), at: t0 + 10), "a late RECORDING confirms the failure")
        #expect(machine.lastObserved == Observed(.recording, at: t0 + 20), "and still tells the truth")
        _ = machine.handle(.connectionLost)
        _ = machine.handle(.telemetry(.recording, at: t0 + 30, answersControl: false))
        #expect(machine.state == .failed(.unconfirmed(.pause), at: t0 + 10), "a reconnect doesn't meet the request")
    }

    @Test func aFailedRequestClearsOnlyWhenTheOwnerIsServed() {
        // The Pendant paused late: NOT_RECORDING alone may be a silence, its flash says idle mode.
        var machine = recordingMachine()
        _ = machine.handle(.requested(.pause, at: t0))
        _ = machine.handle(.confirmationTimedOut(at: t0 + 10))
        _ = machine.handle(.telemetry(.notRecording, at: t0 + 20, answersControl: false))
        #expect(machine.state == .failed(.unconfirmed(.pause), at: t0 + 10))
        #expect(machine.handle(.flash(Observed(false, at: t0 + 20))) == [.confirmed(.paused, at: t0 + 20)])
        #expect(machine.state == .paused(confirmedAt: t0 + 20))
        // The owner asks again, or the other way.
        machine = recordingMachine()
        _ = machine.handle(.requested(.pause, at: t0))
        _ = machine.handle(.confirmationTimedOut(at: t0 + 10))
        #expect(machine.handle(.requested(.resume, at: t0 + 20)) == [.send(.startRecording), .confirmByStatusQuery])
        #expect(machine.state == .resumeRequested(pendingSince: t0 + 20))
        // The owner holds the button: the Pendant's answer to that is the truth.
        machine = recordingMachine()
        _ = machine.handle(.requested(.pause, at: t0))
        _ = machine.handle(.confirmationTimedOut(at: t0 + 10))
        _ = machine.handle(.firmwareToggle(at: t0 + 20))
        _ = machine.handle(.telemetry(.recording, at: t0 + 21, answersControl: false))
        #expect(machine.state == .recording(confirmedAt: t0 + 21))
    }

    @Test func rejectedCommandFails() {
        var machine = recordingMachine()
        _ = machine.handle(.requested(.pause, at: t0))
        _ = machine.handle(.commandRejected("busy", at: t0 + 1))
        #expect(machine.state == .failed(.rejected(.pause, "busy"), at: t0 + 1))
    }

    @Test func longPressIsReflectedNeverReversed() {
        var machine = recordingMachine()
        #expect(machine.handle(.firmwareToggle(at: t0)) == [.refreshStatus])
        let effects = machine.handle(.telemetry(.notRecording, at: t0 + 1, answersControl: false))
        #expect(effects == [.confirmed(.paused, at: t0 + 1)], "no command and no alert")
        #expect(machine.state == .paused(confirmedAt: t0 + 1))
    }

    @Test func detectorPausesAreNeverAPause() {
        var machine = recordingMachine()
        // The firmware reports NOT_RECORDING at every silence, then RECORDING when sound comes back.
        for second in stride(from: 5.0, to: 60, by: 10) {
            #expect(machine.handle(.telemetry(.notRecording, at: t0 + second, answersControl: false)).isEmpty)
            #expect(machine.state == .recording(confirmedAt: t0 + second))
            #expect(machine.lastObserved?.value == .recording, "recording stays on; the silence is the sound line's")
            #expect(machine.handle(.telemetry(.recording, at: t0 + second + 5, answersControl: false)).isEmpty)
        }
    }

    @Test func idleModeNobodyAskedForAlertsOnce() {
        var machine = recordingMachine()
        _ = machine.handle(.telemetry(.notRecording, at: t0 + 1, answersControl: false))
        // The flash then shows the firmware switching to idle mode, with no press or command seen.
        #expect(
            machine.handle(.flash(Observed(false, at: t0 + 2)))
                == [.alertUnexpectedStop, .confirmed(.paused, at: t0 + 1)])
        #expect(machine.handle(.telemetry(.notRecording, at: t0 + 40, answersControl: false)).isEmpty)
    }

    @Test func firstReportInASilenceWaitsForTheFlash() {
        var quiet = RecordingControl()
        #expect(quiet.handle(.telemetry(.notRecording, at: t0, answersControl: false)).isEmpty)
        #expect(quiet.state == .unknown, "a detector pause and a real pause look the same here")
        #expect(quiet.handle(.flash(Observed(true, at: t0 - 20))).isEmpty)
        #expect(quiet.state == .recording(confirmedAt: t0))

        var idle = RecordingControl()
        _ = idle.handle(.telemetry(.notRecording, at: t0, answersControl: false))
        #expect(idle.handle(.flash(Observed(false, at: t0 - 600))) == [.confirmed(.paused, at: t0)])
        #expect(idle.state == .paused(confirmedAt: t0))

        var blank = RecordingControl()
        _ = blank.handle(.telemetry(.notRecording, at: t0, answersControl: false))
        _ = blank.handle(.flash(nil))
        #expect(blank.state == .unknown, "a silent night leaves nothing on flash: no evidence is no pause")
    }

    @Test func aDrainThatSaysNothingKeepsTheModeFromBefore() {
        var quiet = recordingMachine()
        _ = quiet.handle(.connectionLost)
        _ = quiet.handle(.telemetry(.notRecording, at: t0 + 600, answersControl: false))
        #expect(quiet.handle(.flash(nil)).isEmpty)
        #expect(quiet.state == .recording(confirmedAt: t0 + 600), "still on, the detector is just quiet")

        var paused = recordingMachine()
        _ = paused.handle(.requested(.pause, at: t0 + 1))
        _ = paused.handle(.telemetry(.notRecording, at: t0 + 2, answersControl: true))
        _ = paused.handle(.connectionLost)
        _ = paused.handle(.connectionLost)
        _ = paused.handle(.telemetry(.notRecording, at: t0 + 600, answersControl: false))
        _ = paused.handle(.flash(nil))
        #expect(paused.state == .paused(confirmedAt: t0 + 600), "still paused, across two reconnects")
    }

    @Test func replayedHistoryNeverOverridesNewerEvidence() {
        var machine = recordingMachine()
        _ = machine.handle(.telemetry(.notRecording, at: t0 + 5, answersControl: false))
        // An idle switch from an hour ago, re-sent by an observe-mode drain.
        #expect(machine.handle(.flash(Observed(false, at: t0 - 3600))).isEmpty)
        #expect(machine.state == .recording(confirmedAt: t0 + 5))
    }

    @Test func aNewConnectionLearnsTheModeAfresh() {
        var machine = recordingMachine()
        _ = machine.handle(.connectionLost)
        // A long press while out of reach is possible: the earlier "on" no longer counts.
        _ = machine.handle(.telemetry(.notRecording, at: t0 + 600, answersControl: false))
        #expect(machine.state == .unknown)
    }

    @Test func disconnectKeepsLastKnown() {
        var machine = recordingMachine()
        _ = machine.handle(.connectionLost)
        #expect(machine.state == .unknown)
        #expect(machine.lastObserved == Observed(.recording, at: t0))
    }

    @Test func onlyAConfirmedPauseIsAPause() {
        // The server's grouping splits at the pauses the timeline carries: only confirmed ones.
        func pauses(_ effects: [RecordingEffect]) -> Int {
            effects.count { if case .confirmed = $0 { true } else { false } }
        }
        var machine = recordingMachine()
        var effects = machine.handle(.requested(.pause, at: t0 + 61))
        effects += machine.handle(.confirmationTimedOut(at: t0 + 62))
        #expect(pauses(effects) == 0, "an unconfirmed request is not a pause")

        effects = machine.handle(.requested(.pause, at: t0 + 63))
        effects += machine.handle(.telemetry(.notRecording, at: t0 + 64, answersControl: true))
        #expect(pauses(effects) == 1)
    }

    @Test func listeningIsRecordingWithTheDetectorWaiting() {
        var machine = RecordingControl()
        _ = machine.handle(.telemetry(.listening, at: t0, answersControl: false))
        #expect(machine.state == .recording(confirmedAt: t0))
        _ = machine.handle(.telemetry(.notRecording, at: t0 + 5, answersControl: false))
        #expect(machine.state == .recording(confirmedAt: t0 + 5))
    }

    @Test func aResumeConfirmedByListeningIsLastKnownAsRecording() {
        var machine = RecordingControl()
        _ = machine.handle(.requested(.resume, at: t0))
        _ = machine.handle(.telemetry(.listening, at: t0 + 1, answersControl: true))
        #expect(machine.lastObserved == Observed(.recording, at: t0 + 1))
    }

    @Test func aStateLifelogDoesNotKnowIsLastKnownAsUnrecognized() {
        var machine = recordingMachine()
        _ = machine.handle(.telemetry(.unknown(9), at: t0 + 1, answersControl: false))
        #expect(machine.state == .unknown)
        #expect(machine.lastObserved == Observed(.unrecognized(9), at: t0 + 1))
    }
}

@Suite(.timeLimit(.minutes(1))) struct RecordingWithPendant {
    @Test func pauseAndResumeAreConfirmedByTheDevice() async {
        let harness = Harness(.observe)
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.coordinator.requestPause()
            #expect(await eventually { await harness.status().recording.isPaused })
            #expect(await harness.fake.isRecording == false)
            #expect(await harness.status().incidents.isEmpty)
            await harness.coordinator.requestResume()
            #expect(await eventually { await harness.status().recording.isRecording })
        }
    }

    @Test func firmwareLongPressIsNotUndone() async {
        let harness = Harness(.observe)
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.fake.longPress()
            #expect(await eventually { await harness.status().recording.isPaused })
        }
        let controls = await harness.fake.commands.filter { $0 == .startRecording || $0 == .stopRecording }
        #expect(controls.isEmpty)
        #expect(await harness.fake.isRecording == false)
        #expect(await harness.status().incidents.isEmpty)
    }

    @Test func resumeDuringALongCatchUpIsWrittenAndConfirmedAtOnce() async throws {
        // About 4 s of backlog at 20 ms a page, paused by a hold before the phone connected: the report says
        // NOT_RECORDING and only the end of the drain could say why.
        let harness = Harness(.observe, pageInterval: .milliseconds(20))
        await harness.fake.longPress()
        await harness.fake.record(pages: 200)
        let newest = 100 + UInt64(await harness.fake.flash.count) - 1
        await harness.run {
            #expect(
                await eventually {
                    if case .downloading(let progress) = await harness.status().sync {
                        progress.received >= 20
                    } else {
                        false
                    }
                })
            #expect(await harness.status().recording == .unknown, "the screen says Checking… here")
            let asked = ContinuousClock.now
            await harness.coordinator.requestResume()
            #expect(ContinuousClock.now - asked < .seconds(1), "written without waiting for the download")
            #expect(await harness.fake.commands.contains(.startRecording))
            #expect(await harness.fake.isRecording)
            #expect(await eventually { await harness.status().recording.isRecording })
            if case .downloading = await harness.status().sync {
            } else {
                Issue.record("confirmed mid-drain, not after it: \(await harness.status().sync)")
            }
            #expect(await eventually(.seconds(20)) { await harness.status().sync.isCaughtUp })
        }
        let base = await harness.sink.base
        let stored = await harness.sink.pages.map { $0.key.index - base }
        #expect(Set(100...newest).isSubset(of: Set(stored)), "no page lost")
        #expect(await harness.sink.duplicates == 0, "none sent twice")
        #expect(await harness.status().recording.isRecording, "the wake on flash agrees with the confirmation")
        #expect(await harness.fake.commands.filter { $0 == .startRecording }.count == 1)
    }

    @Test func firmwareThatIgnoresTheCommandLeavesItUnconfirmed() async {
        // The deadline outlasts the one reply to the confirmation query, and no re-check is in flight when it passes.
        let harness = Harness(.observe, replyTimeout: .seconds(1), confirmationPollInterval: .seconds(2))
        await harness.fake.setIgnoresRecordingCommands(true)
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.coordinator.requestPause()
            #expect(
                await eventually {
                    if case .failed(.unconfirmed(.pause), _) = await harness.status().recording { true } else { false }
                })
            // A re-check answered after the deadline, still recording: it confirms the failure.
            let failedAt = Date()
            #expect(
                await eventually {
                    await harness.coordinator.refreshStatus()
                    return await harness.status().storage.map { $0.at > failedAt } ?? false
                })
            #expect(await harness.status().lastKnownRecording?.value == .recording)
            if case .failed(.unconfirmed(.pause), _) = await harness.status().recording {
            } else {
                Issue.record("the late report cleared the failure: \(await harness.status().recording)")
            }
        }
        #expect(await harness.status().incidents.contains(.recordingControlFailed(.unconfirmed(.pause))))
    }

    @Test func retryingAFailedPauseClearsTheAlert() async {
        let harness = Harness(.observe, replyTimeout: .seconds(1), confirmationPollInterval: .seconds(2))
        await harness.fake.setIgnoresRecordingCommands(true)
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.coordinator.requestPause()
            #expect(await eventually { !(await harness.status().incidents.isEmpty) })
            await harness.fake.setIgnoresRecordingCommands(false)
            await harness.coordinator.requestPause()
            #expect(await eventually { await harness.status().recording.isPaused })
            #expect(await harness.status().incidents.isEmpty)
        }
    }

    @Test func aQuickPressWhilePausedOnlyResumesRecording() async {
        let harness = Harness(.observe)
        var presses = harness.coordinator.quickPresses.makeAsyncIterator()
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.fake.pressButton()
            #expect(await presses.next() != nil)
            #expect(await harness.status().recording.isRecording, "a press while recording changes nothing")
            await harness.coordinator.requestPause()
            #expect(await eventually { await harness.status().recording.isPaused })
            await harness.fake.pressButton()
            // Confirmed by the Pendant like any resume.
            #expect(await eventually { await harness.status().recording.isRecording })
            #expect(await harness.fake.isRecording)
            await harness.fake.pressButton()
            #expect(await presses.next() != nil, "the press while paused asked for nothing: this one is the next")
        }
    }
}

@Test func onlyAPausedMachineResumesOnAQuickPress() {
    let t0 = Date(timeIntervalSince1970: 1_750_000_000)
    var machine = RecordingControl()
    #expect(machine.handle(.quickPress(at: t0)).isEmpty, "unknown: never guess")
    _ = machine.handle(.requested(.pause, at: t0))
    _ = machine.handle(.telemetry(.notRecording, at: t0 + 1, answersControl: true))
    #expect(machine.handle(.quickPress(at: t0 + 2)) == [.send(.startRecording), .confirmByStatusQuery])
    #expect(machine.state == .resumeRequested(pendingSince: t0 + 2))
    #expect(machine.handle(.quickPress(at: t0 + 3)).isEmpty, "a second press doesn't send again")
}

@Test func onlyALivePressResumes() {
    let phone: Int64 = 1_790_000_000_000
    func press(at stamp: Int64?, count: UInt64) -> ButtonStatus {
        ButtonStatus(event: .short, eventTimestampMillis: stamp.map(UInt64.init), shortPressesSinceBoot: count)
    }
    #expect(PressClock.isLive(press(at: phone - 600, count: 2), previousPresses: nil, receivedAtMillis: phone))
    #expect(PressClock.isLive(press(at: nil, count: 3), previousPresses: 2, receivedAtMillis: phone))
    #expect(
        !PressClock.isLive(press(at: phone - 3_600_000, count: 2), previousPresses: nil, receivedAtMillis: phone),
        "an old press replayed at connect")
    #expect(!PressClock.isLive(press(at: nil, count: 2), previousPresses: 2, receivedAtMillis: phone))
}

@Test func onlyAFreshShortPressMeasuresTheClock() {
    let phone: Int64 = 1_790_000_000_000
    func press(_ event: ButtonEvent, at stamp: Int64, count: UInt64) -> ButtonStatus {
        ButtonStatus(event: event, eventTimestampMillis: UInt64(stamp), shortPressesSinceBoot: count)
    }
    // The RTC runs 4 s fast.
    #expect(
        PressClock.offset(press(.short, at: phone + 4000, count: 3), previousPresses: 2, receivedAtMillis: phone)
            == 4000)
    #expect(
        PressClock.offset(press(.short, at: phone - 3_600_000, count: 3), previousPresses: nil, receivedAtMillis: phone)
            == nil, "the first status of a connection may replay an old press")
    #expect(
        PressClock.offset(press(.short, at: phone + 4000, count: 3), previousPresses: 3, receivedAtMillis: phone) == nil
    )
    #expect(
        PressClock.offset(press(.long, at: phone + 4000, count: 3), previousPresses: 2, receivedAtMillis: phone) == nil)
    #expect(
        PressClock.offset(press(.short, at: phone + 300, count: 3), previousPresses: 2, receivedAtMillis: phone) == nil,
        "under a second is latency, not drift")
    #expect(PressClock.offset(press(.short, at: 1000, count: 3), previousPresses: 2, receivedAtMillis: phone) == nil)
    // A press is placed at the Pendant's time, which can be seconds before it arrived; never in the future.
    #expect(
        PressClock.pressedAt(press(.short, at: phone - 11_000, count: 3), receivedAtMillis: phone) == phone - 11_000)
    #expect(PressClock.pressedAt(press(.short, at: phone + 900, count: 3), receivedAtMillis: phone) == phone)
    #expect(PressClock.pressedAt(press(.short, at: 1000, count: 3), receivedAtMillis: phone) == phone, "clock unset")
}

@Test func aPressReplayedAtConnectIsNotASecondPress() {
    var reader = PressReader()
    func press(_ millis: UInt64) -> QuickPress? {
        reader.press(
            ButtonStatus(event: .short, eventTimestampMillis: millis, shortPressesSinceBoot: millis), deviceID: "p",
            at: .now)
    }
    #expect(press(1_000) != nil)
    #expect(press(1_000) == nil, "the same press replayed")
    #expect(press(1_300) != nil, "a second press, however quick")
}
