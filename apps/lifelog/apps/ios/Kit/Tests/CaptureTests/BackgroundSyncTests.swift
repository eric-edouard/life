import Foundation
import PendantProtocol
import Testing
import Upload

@testable import Capture

// The fake Pendant's pages start at index 100. Harnesses never resync on a timer (`resyncInterval` is an hour), so
// whatever is saved here was driven by Pendant events alone, as in a background wake.

@Suite(.timeLimit(.minutes(1))) struct BackgroundSync {
    @Test func pagesSealedAfterTheBacklogArePushedAndSavedWithoutAWrite() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            let sent = await harness.fake.commands.count
            await harness.fake.recordVoice(pages: 3)
            await harness.fake.recordVoice(pages: 3)
            #expect(await eventually { await harness.sink.pages.count == 16 })
            #expect(await eventually { await harness.status().saved.pushed == 6 })
            await harness.quiesce()
            // The stream stayed open and was current at every status push: nothing to ask, switch or retry.
            #expect(await harness.fake.commands.count == sent)
        }
        #expect(await harness.status().saved.pulled == 10)
        #expect(await harness.acks.isEmpty, "observe mode never ACKs")
    }

    @Test func aStatusPushTriggersExactlyOneDrain() async throws {
        let harness = Harness(.observe, pushesSealedPages: false)
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.fake.record(pages: 5)
            for _ in 0..<3 { await harness.fake.sendUnsolicitedStatus() }
            #expect(await eventually { await harness.sink.pages.count == 15 })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.quiesce()
        }
        let modes = await harness.fake.commands.filter { if case .setDownloadMode = $0 { true } else { false } }
        #expect(modes == [.setDownloadMode(.download), .setDownloadMode(.download)], "the first drain, then one more")
        #expect(await harness.status().saved.duplicates == 10, "observe mode re-sends from the oldest page")
        #expect(await harness.acks.isEmpty)
    }

    @Test func aConnectionParkedOnAWriteIsDroppedAndReconnected() async throws {
        let harness = Harness(.observe, pushesSealedPages: false, stallTimeout: .seconds(300))
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            // 20 Oct: a write never completed, so the run loop handled nothing more while the link stayed up.
            await harness.fake.setHangsWrites(true)
            await harness.fake.record(pages: 5)
            await harness.fake.sendUnsolicitedStatus()
            #expect(await eventually { await harness.fake.hungWriteCount == 1 })
            await harness.fake.setHangsWrites(false)
            await harness.advanceClock(by: .seconds(301))
            #expect(await eventually { await harness.sink.pages.count == 15 })
        }
        let stall = try #require(await harness.status().lastStall)
        #expect(stall.value.silentSeconds >= 300)
        #expect(stall.value.parkedIn?.hasPrefix("notification") == true)
        #expect(stall.value.writesInFlight == 1)
    }

    @Test func aStallDropsOnlyAReadyConnectionAndLetsTheDisconnectReconnect() {
        let id = UUID()
        var machine = ConnectionMachine()
        _ = machine.handle(.availability(.poweredOn))
        _ = machine.handle(.start(knownDevice: id))
        #expect(machine.handle(.stalled(id)) == [], "not connected yet")
        _ = machine.handle(.linkUp(id))
        _ = machine.handle(.ready(id))
        #expect(machine.handle(.stalled(id)) == [.sessionEnded(generation: 1), .disconnect])
        #expect(machine.handle(.disconnected(id, .cancelled)) == [.connect(id)])
    }

    @Test func aSecondLinkUpKeepsAReadyConnectionReady() {
        // 25 Oct: a relaunch connected twice; the second link-up left the session running under "not ready yet".
        let id = UUID()
        var machine = ConnectionMachine()
        _ = machine.handle(.availability(.poweredOn))
        _ = machine.handle(.start(knownDevice: id))
        _ = machine.handle(.linkUp(id))
        _ = machine.handle(.ready(id))
        #expect(machine.handle(.linkUp(id)) == [])
        #expect(machine.state == .ready(id))
    }

    @Test func aPendantThatSpeaksEveryFewMinutesNeverStalls() async throws {
        let harness = Harness(.observe, stallTimeout: .seconds(300))
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            for _ in 0..<5 {
                await harness.advanceClock(by: .seconds(130))
                await harness.fake.sendUnsolicitedStatus()
                await harness.quiesce()
            }
        }
        #expect(await harness.status().lastStall == nil)
    }

    @Test func aStatusAheadOfTheSealedPageDoesNotPull() async throws {
        let harness = Harness(.observe)
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            // The status outruns the stream by the page being written and the one just sealed.
            await harness.fake.withhold(index: 110)
            await harness.fake.withhold(index: 111)
            await harness.fake.record(pages: 2)
            await harness.fake.sendUnsolicitedStatus()
            await harness.quiesce()
        }
        let modes = await harness.fake.commands.filter { if case .setDownloadMode = $0 { true } else { false } }
        #expect(modes == [.setDownloadMode(.download)], "only the first drain")
    }

    @Test func savedThroughFollowsEachStatusOnceItsPagesLand() async throws {
        let harness = Harness(.acknowledge)
        await harness.fake.record(pages: 10)
        try await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            for newest in [111, 113] {
                await harness.advanceClock(by: .seconds(60))
                // The Pendant pushes its status as it seals a page, before that page is saved.
                await harness.sink.holdPersists()
                await harness.fake.record(pages: 2)
                await harness.fake.sendUnsolicitedStatus()
                #expect(
                    await eventually {
                        let status = await harness.status()
                        return status.storage?.value.newestPage == Int64(newest)
                            && status.backlog?.at == status.storage?.at
                    })
                let status = await harness.status()
                #expect(status.backlog?.value.pages == 2)
                #expect(FactsBuilder.savedThrough(status) == nil, "two pages are still on the Pendant")
                await harness.sink.releasePersists()
                let at = try #require(status.storage?.at)
                let saved = at.addingTimeInterval(-Double(FactsBuilder.savedMarginMillis) / 1000)
                #expect(await eventually { await FactsBuilder.savedThrough(harness.status()) == saved })
            }
        }
    }

    @Test func eachDetectorStretchIsFetchedWhenTheStreamStaysSilent() async throws {
        let harness = Harness(.observe, pushesSealedPages: false)
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            // The status the Pendant pushes when its detector stops is the only trigger.
            await harness.fake.recordVoice(pages: 3)
            #expect(await eventually { await harness.sink.pages.count == 13 })
            // Two pages behind could still be in flight (`aStatusAheadOfTheSealedPageDoesNotPull`); three are not.
            await harness.fake.recordVoice(pages: 3)
            #expect(await eventually { await harness.sink.pages.count == 16 })
            #expect(await eventually { await harness.status().sync.isCaughtUp })
            await harness.quiesce()
        }
        let modes = await harness.fake.commands.filter { if case .setDownloadMode = $0 { true } else { false } }
        #expect(modes == Array(repeating: .setDownloadMode(.download), count: 3), "one drain per stretch, never off")
        #expect(await harness.acks.isEmpty)
    }

    @Test func pushedPagesAckInBatchesOnTheVerifiedRun() async throws {
        let harness = Harness(.acknowledge, ackBatchSize: 5)
        await harness.fake.record(pages: 10)
        await harness.run {
            #expect(await eventually { await harness.fake.flash.isEmpty })
            await harness.fake.record(pages: 12)
            #expect(await eventually { await harness.sink.pages.count == 22 })
            #expect(await eventually { await harness.acks.last == 119 })
        }
        #expect(await harness.fake.flash.map(\.index) == [120, 121], "the rest waits for the next batch")
        #expect(await harness.acks == (await harness.acks).sorted())
    }
}

@Test func wakeLogGroupsUpdatesIntoWakesAndCountsWhatEachSaved() {
    var log = WakeLog()
    let start = Date(timeIntervalSince1970: 1_000_000)
    var before = SavedPages()
    var after = SavedPages()
    after.pushed = 2
    after.bytes = 600
    let first = log.record(saved: after, previous: before, at: start)
    before = after
    after.pulled = 3
    let second = log.record(saved: after, previous: before, at: start + 4)
    let third = log.record(saved: after, previous: after, at: start + 60)
    #expect(first && !second && third, "4 s apart: one wake; a minute later: a new one")
    #expect(log.wakes.count == 2)
    #expect(log.wakes[0].end.timeIntervalSince(log.wakes[0].start) == 4)
    #expect(log.wakes[0].saved.pushed == 2 && log.wakes[0].saved.pulled == 3 && log.wakes[0].saved.bytes == 600)
    #expect(log.wakes[1].saved == SavedPages())
}
