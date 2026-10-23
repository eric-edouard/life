import Foundation
import PendantProtocol
import SourceStore
import Testing

@testable import Capture

/// A coordinator draining a simulated Omi into a real source store. Its records are pages at their ring numbers.
private struct OmiHarness {
    let fake: FakeOmiTransport
    let sink = TestSink()
    let coordinator: DrainCoordinator

    init(capacity: UInt64 = 10_000, freesOnDelivery: Bool = true, ackBatchSize: Int = 25) {
        fake = FakeOmiTransport(capacity: capacity, freesOnDelivery: freesOnDelivery)
        coordinator = DrainCoordinator(
            transport: fake, sink: sink, deviceID: { _ in Harness.deviceID },
            configuration: CaptureConfiguration(
                ackPolicy: .acknowledge, ackBatchSize: ackBatchSize, pageIdleTimeout: .milliseconds(500),
                resyncInterval: .seconds(3600)))
    }

    func run(_ body: () async throws -> Void) async rethrows {
        let coordinator = coordinator
        let runner = Task { await coordinator.run() }
        defer { runner.cancel() }
        await coordinator.reconnect()
        try await body()
    }

    /// The drain settled and the phone let go of the Omi.
    func rested() async -> Bool {
        await eventually {
            let status = await coordinator.status
            guard case .resting = status.connection else { return false }
            return status.sync.isCaughtUp
        }
    }

    var advances: [UInt64] {
        get async { await fake.commands.compactMap { if case .advance(let to) = $0 { to } else { nil } } }
    }

    var reads: [UInt64] {
        get async { await fake.commands.compactMap { if case .read(let from) = $0 { from } else { nil } } }
    }

    /// Store indices of every page held, in the Omi's own ring numbers for the current flash life.
    var stored: [UInt64] {
        get async {
            let base = await sink.base
            return await sink.pages.map(\.key.index).filter { $0 >= base }.map { $0 - base }
        }
    }
}

@Suite(.timeLimit(.minutes(1))) struct OmiDrain {
    @Test func storesRecordsSplitAcrossNotificationsThenLetsGo() async throws {
        let harness = OmiHarness()
        await harness.fake.record(60)
        await harness.run {
            #expect(await harness.rested())
        }
        #expect(await harness.stored == Array(0..<60))
        #expect(await harness.advances.last == 60, "ADVANCE frees below the number: one past the last stored")
        #expect(await harness.fake.ring.isEmpty)
        #expect(await harness.fake.clockSets == 1)
        #expect(try await harness.sink.store.clockSyncs(deviceID: Harness.deviceID).isEmpty, "no uptime to anchor")
        let status = await harness.coordinator.status
        #expect(status.deviceKind == .omi)
        #expect(status.firmwareRevision == "3.0.21")
        let first = try #require(await harness.sink.page(at: 0))
        #expect(first.payload.count == OmiRecord.size)
        #expect(first.deviceTimeMillis % 1000 == 0, "a whole UTC second")
    }

    @Test func aSyncConnectsAgainAndReadsOnlyWhatIsNew() async throws {
        let harness = OmiHarness()
        await harness.fake.record(10)
        await harness.run {
            #expect(await harness.rested())
            await harness.fake.record(5)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.stored.count == 15 })
            #expect(await harness.rested())
        }
        #expect(await harness.fake.connectionCount == 2)
        #expect(await harness.reads == [0, 10])
        #expect(await harness.sink.duplicates == 0)
    }

    @Test func resumesFromTheRingsNumberAfterADroppedLink() async throws {
        // The fix: only ADVANCE frees. The link drops mid-read; the reconnect reads from the oldest record not
        // advanced past, re-sending the ones stored since, which dedupe.
        let harness = OmiHarness(freesOnDelivery: false, ackBatchSize: 10)
        await harness.fake.record(100)
        await harness.fake.dropLink(afterSendingRecords: 35)
        await harness.run {
            #expect(await harness.rested())
        }
        #expect(await harness.stored == Array(0..<100))
        // The second read starts where the last ADVANCE before it left the ring.
        var resumeFrom: UInt64 = 0
        var reads: [UInt64] = []
        for command in await harness.fake.commands {
            switch command {
            case .advance(let to) where reads.count < 2: resumeFrom = to
            case .read(let from): reads.append(from)
            default: break
            }
        }
        #expect(reads == [0, resumeFrom] && resumeFrom <= 35, "\(reads)")
        let advances = await harness.advances
        #expect(advances == advances.sorted() && advances.last == 100)
        #expect(await harness.fake.ring.isEmpty)
    }

    @Test func onReleasedFirmwareTheRingFreesWhatItDelivered() async throws {
        // 3.0.21: the ring frees on delivery. A drop mid-read resumes after what was delivered, and nothing the
        // phone stored is asked for again. A record delivered but not stored would be gone: the custody risk.
        let harness = OmiHarness(freesOnDelivery: true)
        await harness.fake.record(100)
        await harness.fake.dropLink(afterSendingRecords: 35)
        await harness.run {
            #expect(await harness.rested())
        }
        #expect(await harness.stored == Array(0..<100))
        let reads = await harness.reads
        #expect(reads.first == 0 && reads.last.map { $0 >= 35 } == true, "\(reads)")
    }

    @Test func neverAdvancesPastWhatIsNotStored() async throws {
        let harness = OmiHarness(freesOnDelivery: false, ackBatchSize: 1)
        await harness.fake.record(20)
        await harness.sink.failPersists(CocoaError(.fileWriteOutOfSpace))
        await harness.run {
            #expect(
                await eventually {
                    if case .failed(.storage) = await harness.coordinator.status.sync { true } else { false }
                })
            #expect(
                await eventually {
                    if case .resting = await harness.coordinator.status.connection { true } else { false }
                })
        }
        #expect(await harness.advances.isEmpty)
        #expect(await harness.fake.ring.count == 20, "the fix keeps them for the next drain")
    }

    @Test func recordsTheRingOverwroteBecomeAHole() async throws {
        // The ring holds 20. The phone has 0..<10; 30 more overwrite 10..<20 before it connects again.
        let harness = OmiHarness(capacity: 20)
        await harness.fake.record(10)
        await harness.run {
            #expect(await harness.rested())
            await harness.fake.record(30)
            #expect(await harness.fake.dropped == 10)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.stored.count == 30 })
            #expect(await harness.rested())
        }
        #expect(await harness.stored == Array(0..<10) + Array(20..<40))
        #expect(await harness.reads == [0, 20])
        #expect(await harness.advances.allSatisfy { $0 <= 10 || $0 > 20 }, "never across the hole")
        #expect(await harness.sink.lives.count == 1, "the same ring")
    }

    @Test func aClearedRingStartsANewFlashLife() async throws {
        let harness = OmiHarness()
        await harness.fake.record(10)
        await harness.run {
            #expect(await harness.rested())
            await harness.fake.clear()
            await harness.fake.record(4)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.sink.lives.count == 2 })
            #expect(await eventually { await harness.stored == Array(0..<4) })
            #expect(await harness.rested())
        }
        #expect(await harness.sink.pages.count == 14, "the first ring's records stay in their own life")
        #expect(try await harness.sink.store.incidents().isEmpty, "found from the numbers, not from a clash")
    }

    @Test func aClearedRingWithMoreRecordsThanThePhoneHeldLosesNothing() async throws {
        // The numbers don't give it away (the ring writes past what the phone holds), so record 0 clashes. On 3.0.21
        // the ring freed it on delivery: the drain carries on into a new flash life instead of reading again.
        let harness = OmiHarness(freesOnDelivery: true)
        await harness.fake.record(10)
        await harness.run {
            #expect(await harness.rested())
            await harness.fake.clear()
            await harness.fake.record(15)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.stored == Array(0..<15) })
            #expect(await harness.rested())
        }
        #expect(await harness.sink.lives.count == 2)
        #expect(await harness.sink.pages.count == 25)
        #expect(await harness.fake.ring.isEmpty)
        #expect(await harness.advances.last == 15)
    }

    @Test func aClearedRingBelowAHighFirstLifeIsNewToo() async throws {
        // A friend's Omi the Omi app drained first: Life's first life starts at 500. Cleared, it writes 0..<15,
        // below anything the life holds, so nothing clashes: only the numbers tell.
        let harness = OmiHarness()
        await harness.fake.record(500)
        await harness.fake.drainedByAnotherApp()
        await harness.fake.record(10)
        await harness.run {
            #expect(await harness.rested())
            await harness.fake.clear()
            await harness.fake.record(15)
            await harness.coordinator.syncNow()
            #expect(await eventually { await harness.sink.lives.count == 2 })
            #expect(await eventually { await harness.stored == Array(0..<15) })
            #expect(await harness.rested())
        }
        #expect(await harness.sink.pages.count == 25)
        #expect(try await harness.sink.store.incidents().isEmpty)
    }

    @Test func aNewLifeThatFailsToStartInAStatusLetsGo() async throws {
        let harness = OmiHarness()
        await harness.fake.record(10)
        await harness.run {
            #expect(await harness.rested())
            await harness.fake.clear()
            await harness.fake.record(4)
            await harness.sink.failNewLives(CocoaError(.fileWriteOutOfSpace))
            await harness.coordinator.syncNow()
            #expect(await harness.failedAndRested())
        }
        #expect(await harness.fake.ring.count == 4, "nothing was read")
    }

    @Test func aCarryWhoseNewLifeFailsToStartLetsGo() async throws {
        // 15 records past the 10 the phone holds: the numbers don't tell, record 0 clashes, and the carry's new life
        // fails. The storage failure path ends the drain and lets go, instead of a drain left half done.
        let harness = OmiHarness(freesOnDelivery: false)
        await harness.fake.record(10)
        await harness.run {
            #expect(await harness.rested())
            await harness.fake.clear()
            await harness.fake.record(15)
            await harness.sink.failNewLives(CocoaError(.fileWriteOutOfSpace))
            await harness.coordinator.syncNow()
            #expect(await harness.failedAndRested())
        }
        #expect(await harness.advances.allSatisfy { $0 <= 10 }, "nothing of the new ring was ADVANCEd")
        #expect(await harness.fake.ring.count == 15)
    }
}

extension OmiHarness {
    /// A storage failure ended the drain and the phone let go of the Omi.
    fileprivate func failedAndRested() async -> Bool {
        await eventually {
            let status = await coordinator.status
            guard case .resting = status.connection, case .failed(.storage) = status.sync else { return false }
            return true
        }
    }
}
