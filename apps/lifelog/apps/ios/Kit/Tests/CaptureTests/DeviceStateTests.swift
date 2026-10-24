import Foundation
import PendantProtocol
import SourceStore
import Testing

@testable import Capture

// The fake Pendant's pages start at index 100.

@Suite(.timeLimit(.minutes(1))) struct Reconnection {
    @Test func knownPendantIsAPendingConnectThatCompletesBackInRange() async {
        let harness = Harness(.observe)
        await harness.fake.setInRange(false)
        await harness.fake.record(pages: 5)
        await harness.run(knownDevice: harness.fake.id) {
            #expect(await eventually { await harness.status().connection == .connecting(harness.fake.id) })
            #expect(await harness.fake.isScanning == false, "a known Pendant is connected to, never scanned for")
            await harness.fake.setInRange(true)
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.sink.pages.count == 5)
    }

    @Test func scanFindsAPendantThatComesIntoRangeLater() async {
        let harness = Harness(.observe)
        await harness.fake.setInRange(false)
        await harness.run {
            #expect(await eventually { await harness.status().connection == .scanning })
            await harness.fake.setInRange(true)
            #expect(await eventually { await harness.status().connection == .ready(harness.fake.id) })
            #expect(await harness.fake.isScanning == false)
        }
    }

    @Test func pairingWhileScanningConnectsToThePairedPendant() async {
        let harness = Harness(.observe)
        await harness.fake.setInRange(false)
        await harness.run {
            #expect(await eventually { await harness.status().connection == .scanning })
            await harness.coordinator.reconnect(to: harness.fake.id)
            #expect(await harness.status().connection == .connecting(harness.fake.id))
            #expect(await harness.fake.isScanning == false)
        }
    }
}

@Suite(.timeLimit(.minutes(1))) struct FirstEvidence {
    @Test func droppedMessagesAreCounted() async {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 3)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.fake.sendGarbage()
            #expect(await eventually { await harness.status().droppedMessages == 2 })
        }
        #expect(await harness.sink.pages.count == 3)
    }

    @Test func nothingIsReportedUntilThePendantAnswers() async {
        let harness = Harness(.observe)
        await harness.fake.setBusyWithOtherClient(true)
        await harness.run {
            #expect(await eventually { await harness.status().connection == .ready(harness.fake.id) })
            #expect(await harness.status().lastReply == nil)
        }
    }

    @Test func busyElsewhereIsDetectedBeforeTheReplyTimeout() async {
        let harness = Harness(.observe, replyTimeout: .seconds(30), handshakeTimeout: .milliseconds(200))
        await harness.fake.record(pages: 5)
        await harness.fake.setBusyWithOtherClient(true)
        await harness.run {
            #expect(
                await eventually(.seconds(2)) { await harness.status().connection == .busyElsewhere(harness.fake.id) })
        }
    }

    @Test func aHealthyPendantAnswersBeforeTheHandshakeTimeout() async {
        let harness = Harness(.observe, handshakeTimeout: .milliseconds(200))
        await harness.fake.record(pages: 5)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.advanceClock(by: .milliseconds(300))
            await harness.quiesce()
            #expect(await harness.status().connection == .ready(harness.fake.id))
            #expect(await harness.status().lastReply != nil)
        }
    }
}

@Suite(.timeLimit(.minutes(1))) struct Battery {
    @Test func batteryAndChargingArriveWithTheConnection() async {
        let harness = Harness(.observe)
        await harness.fake.setBattery(percent: 64, charging: true)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            #expect(await eventually { await harness.status().batteryPercent?.value == 64 })
            #expect(await harness.status().charging?.value == .charging)
            await harness.fake.setBattery(percent: 63, charging: false)
            #expect(await eventually { await harness.status().batteryPercent?.value == 63 })
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.status().charging?.value == .unverified(0) })
        }
    }

    @Test func aSteadyLevelStaysCurrentWhilePaused() async throws {
        let harness = Harness(.observe)
        try await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.coordinator.requestPause()
            #expect(await eventually { await harness.status().recording.isPaused })
            let before = try #require(await harness.status().batteryPercent)
            // Ten minutes in idle mode: the level hasn't moved, so 0x2A19 never notifies.
            await harness.advanceClock(by: .seconds(600))
            await harness.coordinator.refreshStatus()
            #expect(
                await eventually { await harness.status().batteryPercent?.at ?? .distantPast >= before.at + 600 },
                "re-read, not left to go stale")
            #expect(await harness.status().batteryPercent?.value == 82)
            #expect(await harness.status().recording.isPaused)
        }
    }

    @Test func statusCarriesTheLevelWithoutTheBatteryService() async {
        let harness = Harness(.observe, hasBatteryService: false)
        await harness.fake.setBattery(percent: 57, charging: false)
        await harness.run {
            #expect(await eventually { await harness.status().batteryPercent?.value == 57 })
            await harness.fake.setBattery(percent: 56, charging: false)
            await harness.coordinator.refreshStatus()
            #expect(await eventually { await harness.status().batteryPercent?.value == 56 })
        }
        #expect(await harness.fake.batteryReads == 0)
    }
}

@Suite(.timeLimit(.minutes(1))) struct OnScreenRefresh {
    @Test func refreshAsksOnlyForStatusAndRenewsTheEvidence() async {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 5)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            guard case .recording(let before) = await harness.status().recording else {
                Issue.record("expected a recording report")
                return
            }
            let sent = await harness.fake.commands.count
            try? await Task.sleep(for: .milliseconds(20))
            await harness.coordinator.refreshStatus()
            #expect(
                await eventually {
                    if case .recording(let at) = await harness.status().recording { at > before } else { false }
                })
            // No clock set, download or control write: just the question.
            #expect(await Array(harness.fake.commands.dropFirst(sent)) == [.getDeviceStatus])
        }
    }
}

@Suite(.timeLimit(.minutes(1))) struct RecordingDelay {
    @Test func aSlowPendantShowsThePauseAsPendingThenConfirmsIt() async {
        let harness = Harness(.observe, recordingChangeDelay: .milliseconds(400))
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.coordinator.requestPause()
            if case .pauseRequested = await harness.status().recording {
            } else {
                Issue.record("pending until the Pendant reports the change: \(await harness.status().recording)")
            }
            #expect(await eventually { await harness.status().recording.isPaused })
            #expect(await harness.status().incidents.isEmpty)
        }
    }

    @Test func anOldDeadlineNeverFailsANewerRequest() async {
        let harness = Harness(.observe, replyTimeout: .milliseconds(600), recordingChangeDelay: .milliseconds(100))
        await harness.run {
            #expect(await eventually { await harness.status().recording.isRecording })
            await harness.coordinator.requestPause()
            #expect(await eventually { await harness.status().recording.isPaused })
            await harness.advanceClock(by: .milliseconds(400))
            await harness.fake.setIgnoresRecordingCommands(true)
            await harness.coordinator.requestResume()
            // The pause's deadline passes now; only the resume's own deadline may fail it.
            await harness.advanceClock(by: .milliseconds(350))
            await harness.quiesce()
            if case .resumeRequested = await harness.status().recording {
            } else {
                Issue.record("the pause's deadline failed the resume: \(await harness.status().recording)")
            }
        }
    }
}

@Suite(.timeLimit(.minutes(1))) struct CorruptPage {
    @Test func aCorruptPageIsAVisibleIncidentWithItsEvidenceAndSyncMovesOn() async throws {
        let directory = URL.temporaryDirectory.appending(path: "corrupt-\(UUID())", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try SourceStore(directory: directory)
        let fake = FakePendantTransport()
        await fake.record(pages: 40)
        await fake.corrupt(index: 110, as: .corrupt)
        let coordinator = DrainCoordinator(
            transport: fake, sink: store, deviceID: { _ in "pendant-test" },
            configuration: CaptureConfiguration(pageIdleTimeout: .milliseconds(300), resyncInterval: .seconds(3600)))
        let runner = Task { await coordinator.run() }
        defer { runner.cancel() }
        await coordinator.reconnect()
        #expect(await eventually { await coordinator.status.sync.isCaughtUp })
        // Nothing is ACKed in observe mode, so the next download re-sends the page; it stays one incident.
        await fake.record(pages: 1)
        await coordinator.syncNow()
        #expect(await eventually { await coordinator.status.sync.isCaughtUp })

        let incidents = try await store.incidents().filter { $0.kind == .unreadablePage }
        let incident = try #require(incidents.first)
        #expect(incidents.count == 1)
        #expect(incident.resolution == nil, "open until the owner has seen it")
        #expect(incident.key.index % (1 << 40) == 110)
        #expect(try StorageBuffer(decoding: try #require(incident.evidence)).error == .corrupt)
        let base = incident.key.index - 110
        #expect(
            try await store.ackableIndex(deviceID: "pendant-test", startingAt: base + 100) == base + 140,
            "a gap never holds the ACK")

        try await store.resolveIncident(incident.id, keeping: .gap)
        await coordinator.syncNow()
        #expect(await eventually { await coordinator.status.sync.isCaughtUp })
        #expect(try await store.incidents().filter { $0.kind == .unreadablePage && $0.resolution == nil }.isEmpty)
    }
}

@Test func launchNeverScansUntilTheOwnerAsksToFindAPendant() {
    var machine = ConnectionMachine()
    #expect(machine.handle(.availability(.poweredOn)).isEmpty)
    #expect(machine.handle(.start(knownDevice: nil)).isEmpty)
    #expect(machine.state == .idle)
    #expect(machine.handle(.discover) == [.scan])
    #expect(machine.state == .scanning)
}
