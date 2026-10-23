import Foundation
import PendantProtocol
import SourceStore
import Testing

@testable import Capture

// The fake Pendant's pages start at index 100.

@Suite(.timeLimit(.minutes(1))) struct Drain {
    @Test func observeModeNeverSendsAnAck() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 60)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.acks.isEmpty)
        #expect(await harness.fake.flash.count == 60, "the old app still gets every page")
        #expect(await harness.sink.pages.count == 60)
    }

    @Test func recordsWhereEachClockSyncStarts() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 60)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(
            try await harness.sink.store.clockSyncs(deviceID: Harness.deviceID).first?.firstPageIndex
                == (await harness.sink.base) + 160,
            "the page after the newest at the set")
    }

    @Test func acksTheDurablePrefixInBatches() async throws {
        let harness = Harness(.acknowledge)
        await harness.fake.record(pages: 60)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        let acks = await harness.acks
        #expect(acks.last == 159)
        #expect(acks == acks.sorted() && acks.count <= 4, "batched, never per page: \(acks)")
        #expect(await harness.fake.flash.isEmpty)
        #expect(await harness.status().lastAcknowledgedIndex == 159)
    }

    @Test func pagesQueuedWhenTheLinkDropsAreStoredAndAckedNextDrain() async throws {
        let harness = Harness(.acknowledge)
        await harness.fake.record(pages: 40)
        await harness.sink.holdPersists()
        await harness.run {
            #expect(
                await eventually {
                    if case .downloading(let progress) = await harness.status().sync {
                        progress.received == 40
                    } else {
                        false
                    }
                })
            await harness.fake.setInRange(false)
            await harness.sink.releasePersists()
            await harness.coordinator.waitForPersistence()
            #expect(await harness.sink.pages.count == 40, "stored though the link that brought them is gone")
            #expect(await harness.acks.isEmpty)
            await harness.fake.setInRange(true)
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.acks.last == 139)
        #expect(await harness.fake.flash.isEmpty)
    }

    @Test func neverAcksPastAPageThatNeverArrived() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 10)
        await harness.fake.withhold(index: 105)
        await harness.run {
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 105)) })
        }
        #expect(await harness.acks.allSatisfy { $0 < 105 })
        #expect(await harness.fake.flash.map(\.index) == Array(105...109))
    }

    @Test func everyAckIsAPrefixTheSinkHolds() async throws {
        // A gap, a dropped link and a page that never arrives, with an ACK after every settled page.
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 40)
        await harness.fake.corrupt(index: 107, as: .corrupt)
        await harness.fake.dropLink(afterSendingPages: 15)
        await harness.fake.withhold(index: 130)
        await harness.run {
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 130)) })
        }
        let acks = await harness.acks
        let base = await harness.sink.base
        let ackable = try await harness.sink.ackableIndex(deviceID: "pendant-test", startingAt: base + 100)
        #expect(acks.last == 129)
        #expect(acks.allSatisfy { base + $0 <= (ackable ?? 0) }, "\(acks)")
        for index: UInt64 in 100...129 {
            let page = await harness.sink.page(at: index)
            let gap = await harness.sink.gap(at: index)
            let held = page != nil || gap != nil
            #expect(held, "page \(index) was ACKed")
        }
        #expect(await harness.fake.flash.map(\.index) == Array(130...139))
    }

    @Test func corruptPageIsRecordedAsAGapThenSyncContinues() async throws {
        let harness = Harness(.acknowledge)
        await harness.fake.record(pages: 10)
        await harness.fake.corrupt(index: 103, as: .readFailed)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        let gap = try #require(await harness.sink.gap(at: 103))
        #expect(gap.reason == .deviceReadFailed)
        #expect(
            try StorageBuffer(decoding: try #require(gap.evidence)).error == .readFailed, "evidence is the raw envelope"
        )
        #expect(await harness.sink.pages.count == 9)
        #expect(await harness.acks.last == 109)
    }

    @Test func aStorageWriteFailureStopsTheStreamAndAcksNothing() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 10)
        await harness.sink.failPersists(SourceStoreError.io(errno: ENOSPC))
        await harness.run {
            #expect(
                await eventually { if case .failed(.storage) = await harness.status().sync { true } else { false } })
            #expect(
                await harness.status().incidents.contains { if case .storageWriteFailed = $0 { true } else { false } })
            #expect(
                await harness.fake.commands.contains(.setDownloadMode(.recordOnly)),
                "the stream stops while nothing can be saved")
            #expect(await harness.acks.isEmpty)
            await harness.sink.failPersists(nil)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.acks.last == 109)
        #expect(await harness.status().incidents.isEmpty, "the next saved page clears it")
        #expect(await harness.sink.pages.count == 10)
    }

    @Test func aPageThatComesLateIsStoredAfterThePagesAboveItAndAckedOnlyThen() async throws {
        // 105 comes a download later than 106…109. Processing follows store order, so it still reaches a conversation.
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 10)
        await harness.fake.withhold(index: 105)
        await harness.run {
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 105)) })
            #expect(await harness.acks.last == 104)
            await harness.fake.release(index: 105)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.acks.last == 109)
        let late = try #require(await harness.sink.page(at: 105))
        let above = try #require(await harness.sink.page(at: 109))
        let after = try await harness.sink.store.pages(deviceID: Harness.deviceID, afterSeq: above.seq, limit: 10)
        #expect(after.map(\.key) == [late.key], "a reader following store order finds it after 109")
    }

    @Test func storedPageReplayedUnreadableStaysKept() async throws {
        // The owner's Pendant re-sent 43 pages it had already cleared, each as READ_FAILED with no bytes.
        let harness = Harness(.observe, pushesSealedPages: false)
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.fake.corrupt(index: 103, as: .readFailed)
            await harness.fake.record(pages: 2)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.sink.pages.count == 12 })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.sink.gaps.isEmpty)
        #expect(await harness.sink.duplicates == 9)
    }

    @Test func replayedPagesDedupe() async throws {
        // A Pendant that sends nothing after its backlog: the new pages need a second download, which re-sends all.
        let harness = Harness(.observe, pushesSealedPages: false)
        await harness.fake.record(pages: 20)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.fake.record(pages: 5)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.sink.pages.count == 25 })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        // Nothing was ACKed, so the Pendant re-sent the first 20 pages; each one deduped.
        #expect(await harness.sink.duplicates == 20)
    }

    @Test func progressCountsOnlyUnsavedPages() async throws {
        // Nothing ACKed, so the second download re-sends all 55 pages: only 5 are a catch-up.
        let harness = Harness(.observe, pageInterval: .milliseconds(20), pushesSealedPages: false)
        await harness.fake.record(pages: 50)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.fake.record(pages: 5)
            await harness.coordinator.syncNow()
            #expect(
                await eventually {
                    if case .downloading(let progress) = await harness.status().sync {
                        progress.expected == 5 && progress.settled <= 5
                    } else {
                        false
                    }
                })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
    }

    @Test func pagesStillArrivingAfterADownloadEndedEarlyAreNotCaughtUp() async throws {
        // A Pendant slower than the idle timeout: the download ends after its first page, the rest still stream.
        let harness = Harness(.observe, pageIdleTimeout: .milliseconds(150), pageInterval: .milliseconds(500))
        await harness.fake.record(pages: 8)
        let newest: UInt64 = 107
        try await harness.run {
            var endedEarly = false
            let deadline = ContinuousClock.now + .seconds(15)
            while ContinuousClock.now < deadline, await harness.sink.page(at: newest) == nil {
                let sync = await harness.status().sync
                if case .failed(.incomplete) = sync { endedEarly = true }
                // The newest page and one in flight may still be on their way (`sealedPageInFlight`).
                if sync.isCaughtUp, await harness.sink.page(at: newest - 2) == nil {
                    let stored = await harness.sink.pages.count
                    Issue.record("caught up with \(stored) of 8 pages saved")
                    break
                }
                try await Task.sleep(for: .milliseconds(5))
            }
            #expect(endedEarly, "the download should have ended before its last page")
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.sink.pages.count == 8)
    }

    @Test func linkDropMidDrainResumesWithoutLosingPages() async throws {
        let harness = Harness(.acknowledge)
        await harness.fake.record(pages: 60)
        await harness.fake.dropLink(afterSendingPages: 30)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.fake.connectionCount == 2)
        #expect(await harness.sink.pages.count == 60)
        #expect(await harness.fake.flash.isEmpty)
        #expect(await harness.acks == (await harness.acks).sorted())
    }

    @Test func replayConflictStopsTheAck() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 10)
        // A receipt for 105 from before, with the same device time but other bytes.
        let time = try #require(await harness.fake.flash.first { $0.index == 105 }).timestampMillis
        try await harness.sink.preload(105...105, evidence: await harness.fake.info.flashLifeEvidence) { _ in
            Int64(time)
        }
        await harness.run {
            #expect(await eventually { await harness.status().incidents.contains(.integrityConflict(index: 105)) })
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 105)) })
        }
        #expect(await harness.acks.last == 104)
    }

    @Test func encryptedPageHoldsTheAckUntilTheOwnerAcceptsAGap() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 10)
        await harness.fake.encrypt(index: 105)
        try await harness.run {
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 105)) })
            #expect(await harness.acks.last == 104)
            try await harness.sink.acceptHeld(105)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.acks.last == 109)
        #expect(await harness.sink.gap(at: 105)?.reason == .encrypted)
    }

    @Test func undecodablePageHoldsTheAckUntilTheOwnerAcceptsAGap() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 10)
        await harness.fake.garble(index: 105)
        try await harness.run {
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 105)) })
            #expect(await harness.status().incidents.contains(.undecodablePage(index: 105)))
            #expect(await harness.acks.last == 104, "the Pendant keeps the page")
            let incident = try #require(await harness.sink.incidents(at: 105).first)
            #expect(incident.kind == .undecodablePage && incident.resolution == nil)
            #expect(
                try StorageBuffer(decoding: try #require(incident.evidence)).index == 105,
                "evidence is the raw envelope")
            try await harness.sink.acceptHeld(105)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.acks.last == 109)
        guard case .undecodable? = await harness.sink.gap(at: 105)?.reason else {
            Issue.record("105 is not an undecodable gap: \(String(describing: await harness.sink.gap(at: 105)))")
            return
        }
    }

    @Test func anUndecodablePageThatComesBackReadableIsStoredAndAcked() async throws {
        // A newer app, or a clean re-send, reads the page: it's stored, and nobody has to accept a gap.
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 10)
        await harness.fake.garble(index: 105)
        await harness.run {
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 105)) })
            await harness.fake.garble(index: 105, false)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.acks.last == 109)
        #expect(await harness.sink.page(at: 105) != nil)
        #expect(await harness.sink.incidents(at: 105).map(\.resolution) == [.repaired])
        #expect(await harness.sink.gaps.isEmpty)
    }

    @Test func staleReceiptsNeverAuthorizeAnAck() async throws {
        // Receipts 100…109 are from an earlier flash life. The Pendant restarted its indices and now holds new
        // pages 100…119: 100…104 never arrive, 105…109 conflict with the stale receipts, 110…119 are stored.
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 20)
        for index: UInt64 in 100...104 { await harness.fake.withhold(index: index) }
        // Same device times, other bytes: 105…109 conflict.
        let times = Dictionary(uniqueKeysWithValues: await harness.fake.flash.map { ($0.index, $0.timestampMillis) })
        try await harness.sink.preload(100...109, evidence: await harness.fake.info.flashLifeEvidence) { index in
            Int64(times[index] ?? 0)
        }
        await harness.run {
            #expect(await eventually { await harness.status().sync == .failed(.incomplete(missingFrom: 100)) })
        }
        let base = await harness.sink.base
        #expect(
            try await harness.sink.ackableIndex(deviceID: Harness.deviceID, startingAt: base + 100) == base + 104,
            "the store alone would allow 100…104")
        #expect(await harness.acks.isEmpty, "nothing from 100 was settled by this drain")
        #expect(await harness.fake.flash.count == 20)
    }

    @Test func observeModeDownloadsDespiteStaleReceipts() async throws {
        // Every index the Pendant holds has a stale receipt its identity doesn't reveal as stale.
        let harness = Harness(.observe)
        try await harness.sink.preload(100...119, evidence: await harness.fake.info.flashLifeEvidence) { _ in 1 }
        await harness.fake.record(pages: 20)
        await harness.run {
            #expect(await eventually { await harness.fake.commands.contains(.setDownloadMode(.download)) })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.sink.lives.count == 2, "the first re-used index started a new flash life")
        for index: UInt64 in 100...119 { #expect(await harness.sink.page(at: index)?.deviceTimeMillis != 1) }
    }

    @Test func clearedStorageStartsANewFlashLife() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 20)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            // Another host clears storage while we're away; indices restart and the generation says so.
            await harness.fake.setInRange(false)
            await harness.fake.clearStorage(restartingAt: 100, newStorageInstance: true)
            await harness.fake.setClockSkew(millis: -60_000)
            await harness.fake.record(pages: 10)
            await harness.fake.setInRange(true)
            #expect(await eventually { await harness.sink.pages.count == 30 })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.sink.lives.count == 2)
        #expect(await harness.status().incidents.isEmpty, "a new generation is not a conflict")
    }

    @Test func indexRestartWithTheSameGenerationStartsANewFlashLife() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 1)
        await harness.fake.record(pages: 20)
        await harness.run {
            #expect(await eventually { await harness.fake.flash.isEmpty })
            // UNVERIFIED whether storage_instance changes on a clear: here it doesn't.
            await harness.fake.setInRange(false)
            await harness.fake.clearStorage(restartingAt: 100, newStorageInstance: false)
            await harness.fake.setClockSkew(millis: -60_000)
            await harness.fake.record(pages: 20)
            await harness.fake.setInRange(true)
            #expect(await eventually { await harness.sink.pages.count == 40 })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.sink.lives.count == 2)
        #expect(await harness.acks.last == 119)
        #expect(await harness.fake.flash.isEmpty)
        for index: UInt64 in 100...119 { #expect(await harness.sink.page(at: index) != nil) }
    }

    @Test func drainsWithoutDeviceInfo() async throws {
        // The device info wait must time out, but the other replies must beat that same timeout.
        let harness = Harness(.observe, replyTimeout: .seconds(1))
        await harness.fake.setAnswersDeviceInfo(false)
        await harness.fake.record(pages: 5)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
        }
        #expect(await harness.sink.pages.count == 5)
        #expect(await harness.sink.lives == [nil])
    }

    @Test func staleDrainCannotAckAfterReconnect() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 1, replyTimeout: .seconds(30))
        await harness.fake.record(pages: 3)
        await harness.sink.holdPersists()
        await harness.run {
            // Connection 1 is mid-drain, awaiting the sink.
            #expect(await eventually { await harness.sink.waitingPersists >= 1 })
            await harness.fake.setInRange(false)
            // Connection 2 comes up; this time the Pendant drops our writes, so it never drains or ACKs.
            await harness.fake.setBusyWithOtherClient(true)
            await harness.fake.setInRange(true)
            #expect(await eventually { await harness.fake.connectionCount == 2 })
            #expect(await eventually { await harness.status().connection == .ready(harness.fake.id) })
            await harness.sink.releasePersists()
            await harness.coordinator.waitForPersistence()
        }
        #expect(await harness.sink.pages.count >= 1, "the page in flight is still saved")
        #expect(await harness.acks.isEmpty, "work from connection 1 never ACKs on connection 2")
    }

    @Test func busyElsewhereLetsGoOfTheLink() async throws {
        let harness = Harness(.acknowledge, replyTimeout: .milliseconds(200))
        await harness.fake.record(pages: 5)
        await harness.fake.setBusyWithOtherClient(true)
        await harness.run {
            #expect(await eventually { await harness.status().connection == .busyElsewhere(harness.fake.id) })
        }
        #expect(await harness.fake.connectionCount == 1)
        #expect(await harness.fake.flash.count == 5)
    }

    @Test func pairingRequiredIsReported() async throws {
        let harness = Harness(.observe)
        await harness.fake.setNeedsPairing(true)
        await harness.run {
            #expect(await eventually { await harness.status().connection == .pairingPending(harness.fake.id) })
        }
    }

    @Test func bluetoothOffThenOnReconnects() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 2)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.fake.setBluetooth(.poweredOff)
            #expect(await eventually { await harness.status().connection == .bluetoothOff })
            await harness.fake.setBluetooth(.poweredOn)
            #expect(await eventually { await harness.fake.connectionCount == 2 })
            #expect(await eventually { await harness.status().connection == .ready(harness.fake.id) })
        }
    }

    @Test func everyQuickPressIsDeliveredEvenInsideOneStatusUpdate() async throws {
        let harness = Harness(.observe)
        var presses = harness.coordinator.quickPresses.makeAsyncIterator()
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            // Back to back: the coalescing status stream may show only the second.
            await harness.fake.pressButton()
            await harness.fake.pressButton()
            await harness.fake.longPress()
            let first = await presses.next()
            let second = await presses.next()
            #expect(first != nil && second != nil && first?.id != second?.id)
        }
    }

    @Test func statusSnapshotCarriesDeviceTelemetry() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 4)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.fake.pressButton()
            #expect(await eventually { await harness.status().lastButton?.value == .short })
        }
        let status = await harness.status()
        #expect(status.storage?.value.totalPages == 120_000)
        #expect(status.backlog?.value.pages == 0)
        #expect(status.lastKnownRecording?.value == .recording)
        #expect(status.lastContact != nil)
    }
}
