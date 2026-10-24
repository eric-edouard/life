import Foundation
import Testing

@testable import SourceStore

private let device = "pendant-1"

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "source-store-\(UUID().uuidString)")
}

private func key(_ index: UInt64) -> PageKey { PageKey(deviceID: device, index: index) }

private func page(_ index: UInt64, payload: String? = nil) -> RawPage {
    RawPage(
        key: key(index), session: 3, deviceTimeMillis: 1_790_000_000_000 + Int64(index) * 1000,
        payload: Data((payload ?? "page \(index)").utf8), receivedAt: .now)
}

private func fileSize(_ url: URL) throws -> Int {
    try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1
}

@Test func ackCoversOnlyTheContiguousDurableRun() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    for index: UInt64 in [10, 11, 13] {
        #expect(try await store.persist(page(index)) == .stored)
    }
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 9) == nil)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 10) == 11)
    #expect(try await store.ackableIndex(deviceID: "other", startingAt: 10) == nil)
}

@Test func corruptPageBecomesAGapAndSyncProceeds() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    _ = try await store.persist(page(0))
    _ = try await store.persist(page(2))
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 0)

    try await store.recordGap(key(1), reason: .deviceCorrupt, evidence: Data([0x38, 0x02]))
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 2)
    #expect(try await store.storageStats().gapCountByDevice == [device: 1])
}

@Test func unreadableReplayOfAStoredPageRecordsNothing() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    _ = try await store.persist(page(1))

    #expect(try await store.recordGap(key(1), reason: .deviceReadFailed, evidence: Data([0x38, 0x01])) == false)
    #expect(try await store.gaps(deviceID: device).isEmpty)
    #expect(try await store.incidents().isEmpty)
    #expect(try await store.page(key(1))?.payload == page(1).payload)
}

@Test func replayIsDeduplicated() async throws {
    let directory = temporaryDirectory()
    let store = try SourceStore(directory: directory)
    #expect(try await store.persist(page(5)) == .stored)
    #expect(try await store.persist(page(5)) == .duplicate)

    #expect(try fileSize(directory.appending(path: "packs/1.pack")) == page(5).payload.count)
    #expect(try await store.storageStats().sessions.map(\.pageCount) == [1])
    #expect(try await store.page(key(5))?.payload == page(5).payload)
}

@Test func conflictingReplayIsKeptAsEvidenceAndBlocksAck() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    for index: UInt64 in 0...2 { _ = try await store.persist(page(index)) }

    #expect(try await store.persist(page(1, payload: "after a reset")) == .conflict)
    #expect(try await store.persist(page(1, payload: "after a reset")) == .conflict)
    #expect(try await store.page(key(1))?.payload == page(1).payload)
    #expect(try await store.incidents().map(\.kind) == [.replayConflict])
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 0)
}

@Test func crashBetweenPackWriteAndReceiptLeavesARecoverableTail() async throws {
    let directory = temporaryDirectory()
    let pack = directory.appending(path: "packs/1.pack")
    do {
        let store = try SourceStore(directory: directory)
        _ = try await store.persist(page(0))
    }
    // Bytes written and synced, but the process died before the receipt committed.
    let handle = try FileHandle(forWritingTo: pack)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data("page 1, torn".utf8))
    try handle.close()

    let store = try SourceStore(directory: directory)
    #expect(try fileSize(pack) == page(0).payload.count)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 0)
    #expect(try await store.persist(page(1)) == .stored)
    #expect(
        try await store.pages(deviceID: device, from: 0, limit: 10).map(\.payload) == [0, 1].map { page($0).payload })
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 1)
}

@Test func checksumFailureIsReportedNotSkipped() async throws {
    let directory = temporaryDirectory()
    let store = try SourceStore(directory: directory)
    _ = try await store.persist(page(0))
    let handle = try FileHandle(forWritingTo: directory.appending(path: "packs/1.pack"))
    try handle.write(contentsOf: Data("X".utf8))
    try handle.close()

    await #expect(throws: SourceStoreError.checksumMismatch(key(0))) { try await store.page(key(0)) }
    #expect(try await store.incidents().map(\.kind) == [.checksumMismatch])
}

@Test func openingFailsClosed() async throws {
    let directory = temporaryDirectory()
    let database = directory.appending(path: "source.sqlite")
    do {
        let store = try SourceStore(directory: directory)
        _ = try await store.persist(page(0))
    }
    try SQLite(path: database.path).execute("PRAGMA user_version = 99")
    #expect(throws: SourceStoreError.unknownSchemaVersion(99)) { try SourceStore(directory: directory) }

    for suffix in ["", "-wal", "-shm"] {
        try? FileManager.default.removeItem(at: URL(filePath: database.path + suffix))
    }
    #expect(throws: SourceStoreError.missingDatabase) { try SourceStore(directory: directory) }
}

@Test func failedDerivedJobNeverAffectsAck() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    for index: UInt64 in 0...2 { _ = try await store.persist(page(index)) }

    let job = try #require(try await store.claimJob())
    #expect(job.indices == 0...2)
    try await store.failJob(job.id, error: "decode failed")
    #expect(try await store.claimJob() == nil)

    #expect(try await store.persist(page(3)) == .stored)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 3)

    let retry = try await store.claimJob(now: .now + 3600)
    #expect(retry?.indices == 0...2)
    #expect(retry?.attempts == 2)

    try await store.releaseJob(try #require(retry).id)
    #expect(try await store.claimJob(now: .now + 3600)?.attempts == 2, "a cancelled run costs no attempt")
}

@Test func ownerKeepingTheStoredCopyUnblocksAck() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    for index: UInt64 in 0...2 { _ = try await store.persist(page(index)) }
    let replay = page(1, payload: "replay")
    #expect(try await store.persist(replay) == .conflict)
    let incident = try #require(try await store.incidents().first)

    try await store.resolveIncident(incident.id, keeping: .storedCopy)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 2)
    #expect(try await store.persist(replay) == .duplicate, "a resolved replay is known, not a new conflict")
    #expect(try await store.page(key(1))?.payload == page(1).payload)
    #expect(try await store.incidents().map(\.evidence) == [replay.payload], "the other copy is kept")
}

@Test func ownerKeepingTheReplayKeepsTheStoredCopyAsEvidence() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    for index: UInt64 in 0...2 { _ = try await store.persist(page(index)) }
    var replay = page(1, payload: "replay")
    replay.deviceTimeMillis += 7
    #expect(try await store.persist(replay) == .indexReused)
    let incident = try #require(try await store.incidents().first)

    try await store.resolveIncident(incident.id, keeping: .replayCopy)
    let kept = try #require(try await store.page(key(1)))
    #expect(kept.payload == replay.payload && kept.deviceTimeMillis == replay.deviceTimeMillis)
    #expect(try await store.incidents().map(\.evidence) == [page(1).payload])
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 2)
    #expect(try await store.persist(replay) == .duplicate)
    #expect(try await store.persist(page(1)) == .duplicate)
}

@Test(arguments: [HeldReason.encrypted, .undecodable(detail: "truncated")])
func heldPageBecomesAGapOnlyWhenTheOwnerSays(reason: HeldReason) async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    _ = try await store.persist(page(0))
    _ = try await store.persist(page(2))
    let evidence = Data("held".utf8)
    #expect(try await store.recordHeld(key(1), reason: reason, evidence: evidence) == false)
    #expect(try await store.recordHeld(key(1), reason: reason, evidence: evidence) == false)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 0)
    #expect(try await store.savedIndex(deviceID: device, startingAt: 0) == 2, "held is on the phone, not acked")
    let incident = try #require(try await store.incidents().first)
    #expect(try await store.incidents().count == 1, "a re-send adds nothing")
    #expect(incident.kind == (reason == .encrypted ? .encryptedAudio : .undecodablePage))

    await #expect(throws: SourceStoreError.resolutionNotAllowed) {
        try await store.resolveIncident(incident.id, keeping: .storedCopy)
    }
    try await store.resolveIncident(incident.id, keeping: .gap)
    #expect(try await store.gaps(deviceID: device) == [1: reason.gap])
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 2)
    #expect(try await store.recordHeld(key(1), reason: reason, evidence: evidence) == true)
    #expect(try await store.recordHeld(key(1), reason: reason, evidence: Data("other".utf8)) == false)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 0, "other bytes are held again")
}

@Test func undecodablePageStoredLaterIsRepaired() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    _ = try await store.persist(page(0))
    #expect(try await store.recordHeld(key(1), reason: .undecodable(detail: "truncated"), evidence: Data()) == false)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 0)
    #expect(try await store.persist(page(1)) == .stored)
    #expect(try await store.incidents().map(\.resolution) == [.repaired])
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 1)
}

@Test func flashLivesFollowTheGenerationEvidence() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    let first = try await store.flashLife(deviceID: device, evidence: "serial A, storage_instance 1")
    #expect(first.number == 1)
    #expect(try await store.flashLife(deviceID: device, evidence: "serial A, storage_instance 1") == first)
    #expect(try await store.flashLife(deviceID: device, evidence: nil) == first, "no evidence keeps the current life")
    _ = try await store.persist(page(first.base + 100))

    let second = try await store.flashLife(deviceID: device, evidence: "serial A, storage_instance 2")
    #expect(second.number == 2)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: second.base + 100) == nil)
    let third = try await store.startNewFlashLife(deviceID: device, reason: "index 100 came back with another time")
    #expect(third.number == 3)
    #expect(try await store.flashLife(deviceID: device, evidence: "serial A, storage_instance 2") == third)
}

@Test func anIndexBackWithAnotherDeviceTimeIsReused() async throws {
    let store = try SourceStore(directory: temporaryDirectory())
    _ = try await store.persist(page(1))
    var restarted = page(1, payload: "after a clear")
    restarted.deviceTimeMillis += 1
    #expect(try await store.persist(restarted) == .indexReused)
    #expect(try await store.incidents().map(\.kind) == [.replayConflict])
}

private func corrupt(_ directory: URL, at offset: UInt64) throws {
    let handle = try FileHandle(forWritingTo: directory.appending(path: "packs/1.pack"))
    try handle.seek(toOffset: offset)
    try handle.write(contentsOf: Data("X".utf8))
    try handle.close()
}

@Test func rottedBytesBlockAck() async throws {
    let directory = temporaryDirectory()
    let store = try SourceStore(directory: directory)
    for index: UInt64 in 0...2 { _ = try await store.persist(page(index)) }
    try corrupt(directory, at: UInt64(page(0).payload.count))

    await #expect(throws: SourceStoreError.checksumMismatch(key(1))) { try await store.page(key(1)) }
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 0)
}

@Test func replayRepairsRottedBytes() async throws {
    let directory = temporaryDirectory()
    let store = try SourceStore(directory: directory)
    for index: UInt64 in 0...1 { _ = try await store.persist(page(index)) }
    try corrupt(directory, at: 0)

    #expect(try await store.persist(page(0)) == .stored, "stored bytes no longer verify, so the replay is kept")
    #expect(try await store.page(key(0))?.payload == page(0).payload)
    #expect(try await store.ackableIndex(deviceID: device, startingAt: 0) == 1)
    #expect(try await store.incidents().map(\.kind) == [.checksumMismatch], "the rot stays on record")
}

extension SourceStore {
    fileprivate func failAfterNextCommit() {
        var fired = false
        afterReceiptCommit = {
            guard !fired else { return }
            fired = true
            throw SourceStoreError.sqlite(code: 10, message: "disk I/O error after commit")
        }
    }
}

@Test func errorAfterCommitNeverCutsCommittedBytes() async throws {
    let directory = temporaryDirectory()
    let store = try SourceStore(directory: directory)
    await store.failAfterNextCommit()
    await #expect(throws: SourceStoreError.self) { try await store.persist(page(0)) }
    _ = try await store.persist(page(1))

    #expect(
        try await store.pages(deviceID: device, from: 0, limit: 10).map(\.payload) == [0, 1].map { page($0).payload })
    #expect(try await SourceStore(directory: directory).page(key(0))?.payload == page(0).payload)
}
