import Export
import Foundation
import Library
import SourceStore
import Testing
import Timeline

private let device = "pendant"
private let base: Int64 = 1_790_000_000_000
private let conversation = ConversationID(anchor: CaptureInstant(millis: base)).serverID

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "backup-\(UUID().uuidString)", directoryHint: .isDirectory)
}

private func payload(_ index: UInt64) -> Data { Data("raw page \(index)".utf8) }

/// A small live lifelog folder: three raw pages, one titled conversation in the cache and one derived
/// sidecar beside its (rebuildable) audio.
private func liveStores() async throws -> URL {
    let live = temporaryDirectory()
    let source = try SourceStore(directory: live.appending(path: "source"))
    for index: UInt64 in 0..<3 {
        _ = try await source.persist(
            RawPage(
                key: PageKey(deviceID: device, index: index), session: 1, deviceTimeMillis: base + Int64(index) * 1000,
                payload: payload(index), receivedAt: .now))
    }
    let library = try LibraryStore(directory: live.appending(path: "library"))
    try await library.apply(
        feed: Data(
            #"""
            {"cursor":"1","conversations":[{"id":"\#(conversation.uuidString.lowercased())",
             "startAt":"2026-09-21T14:13:20.000Z","endAt":"2026-09-21T14:13:23.000Z","kind":"conversation",
             "ownerTitle":"Lunch with Mai","retired":null}]}
            """#.utf8), withdrawn: { _ in })
    let derived = live.appending(path: "derived/\(device)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: derived, withIntermediateDirectories: true)
    try Data(
        #"""
        {"deviceID":"pendant","file":"0-2.m4a","pages":[0,2],"interval":[{"millis":\#(base)},{"millis":\#(base + 3000)}],
         "decodeGaps":[],"windows":[]}
        """#.utf8
    ).write(to: derived.appending(path: "0-2.segment.json"))
    try Data("rebuildable audio".utf8).write(to: derived.appending(path: "0-2.m4a"))
    return live
}

private func backup() async throws -> URL {
    let root = temporaryDirectory()
    try await Backup.write(from: try await liveStores(), to: root, appVersion: "test", createdAt: .now)
    return root
}

@Test func backupRestoresIntoAFreshFolderAndAReplayWritesNothing() async throws {
    let root = temporaryDirectory()
    let manifest = try await Backup.write(from: try await liveStores(), to: root, appVersion: "test", createdAt: .now)
    #expect(manifest.kind == .backup)
    #expect(
        manifest.files.map(\.path) == [
            "sources.json", "stores/derived/pendant/0-2.segment.json", "stores/library/library.sqlite",
            "stores/source/packs/1.pack", "stores/source/source.sqlite",
        ])
    let input = try snapshot(root)
    let area = temporaryDirectory()

    let report = try await Importer.restore(root, into: area)
    #expect(!report.alreadyRestored && report.pages == 3 && report.conversations == 1 && report.unsupported.isEmpty)
    let source = try SourceStore(directory: report.location.appending(path: "source"))
    #expect(try await source.pages(deviceID: device, from: 0, limit: 10).map(\.payload) == (0..<3).map(payload))
    let library = try LibraryStore(directory: report.location.appending(path: "library"))
    #expect(try await library.conversation(conversation)?.shownTitle == "Lunch with Mai")
    #expect(!FileManager.default.fileExists(atPath: report.location.appending(path: "derived/pendant/0-2.m4a").path))

    let replay = try await Importer.restore(root, into: area)
    #expect(replay.alreadyRestored && replay.location == report.location)
    #expect(try FileManager.default.contentsOfDirectory(atPath: area.path) == [report.location.lastPathComponent])
    #expect(try snapshot(root) == input)
}

@Test func restoreRejectsAnUnknownFutureVersion() async throws {
    let root = try await backup()
    let url = root.appending(path: "manifest.json")
    let text = try String(contentsOf: url, encoding: .utf8)
    try Data(text.replacing("\"version\" : 1", with: "\"version\" : 2").utf8).write(to: url)
    await #expect(throws: ImportError.unsupportedVersion(2)) {
        try await Importer.restore(root, into: temporaryDirectory())
    }
}

@Test func restoreRejectsATamperedPack() async throws {
    let root = try await backup()
    let pack = root.appending(path: "stores/source/packs/1.pack")
    var bytes = try Data(contentsOf: pack)
    bytes[0] ^= 0xFF
    try bytes.write(to: pack)
    let area = temporaryDirectory()
    await #expect(throws: ImportError.hashMismatch("stores/source/packs/1.pack")) {
        try await Importer.restore(root, into: area)
    }
    #expect(!FileManager.default.fileExists(atPath: area.path))
}

@Test func aScheduledSwitchKeepsTheLiveLibraryOnFailureAndMovesItAsideOnSuccess() async throws {
    let files = FileManager.default
    let support = temporaryDirectory()
    let swap = LibrarySwitch(support: support)
    let report = try await Importer.restore(try await backup(), into: swap.restores)
    do {
        // The live store had derived its audio, so no job was left; the backup brought the sidecar, not the audio.
        let source = try SourceStore(directory: report.location.appending(path: "source"))
        try await source.completeJob(try #require(try await source.claimJob()).id)
    }
    try files.createDirectory(at: swap.live, withIntermediateDirectories: true)
    try Data("current".utf8).write(to: swap.live.appending(path: "current"))

    try await swap.schedule(report.location)
    // The restored folder can't leave its parent, so moving it into place fails after the live one moved aside.
    try files.setAttributes([.posixPermissions: 0o555], ofItemAtPath: swap.restores.path)
    let failed = swap.applyScheduled()
    try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: swap.restores.path)
    guard case .failed(let reason) = failed else {
        Issue.record("expected a failed switch, got \(String(describing: failed))")
        return
    }
    #expect(reason.contains("could not be moved into place"))
    #expect(files.fileExists(atPath: swap.live.appending(path: "current").path))
    #expect(files.fileExists(atPath: report.location.path))
    #expect(Set(try files.contentsOfDirectory(atPath: support.path)) == ["lifelog", "lifelog-restores"])
    #expect(swap.applyScheduled() == nil)

    try await swap.schedule(report.location)
    try await swap.schedule(report.location)
    let previous = support.appending(path: "lifelog-previous-1800000000", directoryHint: .isDirectory)
    #expect(swap.applyScheduled(now: Date(timeIntervalSince1970: 1_800_000_000)) == .switched(previous: previous))
    #expect(files.fileExists(atPath: previous.appending(path: "current").path))
    #expect(!files.fileExists(atPath: report.location.path))
    let source = try SourceStore(directory: swap.live.appending(path: "source"))
    let rebuild = try #require(try await source.claimJob())
    #expect(rebuild.deviceID == device && rebuild.indices == 0...2)
    #expect(try await source.claimJob() == nil)
}

private func snapshot(_ root: URL) throws -> [String: Data] {
    let paths = FileManager.default.subpaths(atPath: root.path) ?? []
    return try paths.reduce(into: [:]) { result, path in
        var directory: ObjCBool = false
        let url = root.appending(path: path)
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), !directory.boolValue {
            result[path] = try Data(contentsOf: url)
        }
    }
}
