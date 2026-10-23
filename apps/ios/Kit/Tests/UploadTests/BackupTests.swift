import AVFoundation
import AudioPipeline
import CryptoKit
import Foundation
import Library
@testable import ServerAPI
import SourceStore
import Testing
import Timeline
@testable import Upload

// MARK: Raw backup

private func backupUploader(_ fixture: ScannerFixture, host: String) throws -> Uploader {
    try Uploader(
        source: fixture.source, scanner: try fixture.scanner(), client: RebuildServer.client(host),
        directory: fixture.directory.appending(path: "upload"),
        canRunHeavyWork: { true })
}

private func puts(_ host: String, _ prefix: String) -> [(path: String, body: Data, sha: String?)] {
    RebuildServer.hosts.withLock { $0[host]?.requests ?? [] }.filter { $0.method == "PUT" && $0.path.hasPrefix(prefix) }
        .map { ($0.path, $0.body, $0.sha) }
}

private func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

/// What the store holds and would ACK: unchanged by anything the backup does.
private func ackState(_ fixture: ScannerFixture) async throws -> [String] {
    let packs = fixture.directory.appending(path: "source/packs")
    let files = try FileManager.default.contentsOfDirectory(atPath: packs.path).sorted()
    return try files.map { "\($0) \(hex(try Data(contentsOf: packs.appending(path: $0))))" } + [
        "\(try await fixture.source.pages(deviceID: "pendant-1", afterSeq: 0, limit: .max).map(\.seq))",
        "\(try await fixture.source.ackableIndex(deviceID: "pendant-1", startingAt: 0) ?? 0)",
        "\(try await fixture.source.incidents().count)",
    ]
}

@Test func aPackThatCantBeReadNowGoesNextRound() async throws {
    let host = "unreadable-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<5)
    let packs = fixture.directory.appending(path: "source/packs")
    try Data("open".utf8).write(to: packs.appending(path: "2.pack"))
    let sealed = packs.appending(path: "1.pack").path
    let uploader = try backupUploader(fixture, host: host)
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: sealed)
    try await uploader.backUp(library: fixture.library)
    #expect(puts(host, "/backup/packs/").isEmpty)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: sealed)
    try await uploader.backUp(library: fixture.library)
    #expect(puts(host, "/backup/packs/").map(\.path) == ["/backup/packs/pendant-1/1"])
}

@Test func aSealedPackGoesUpOnceTheOpenOneWaitsAndTheStoreIsOnlyRead() async throws {
    let host = "packs-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<5)
    var uploader = try backupUploader(fixture, host: host)

    // One pack, still open: only today's snapshot of the receipts goes.
    let before = try await ackState(fixture)
    try await uploader.backUp(library: fixture.library)
    #expect(puts(host, "/backup/packs/").isEmpty)
    let snapshot = try #require(puts(host, "/backup/source-db/pendant-1").first)
    #expect(snapshot.sha == hex(snapshot.body))
    #expect(try await uploader.backupStatus() == .init(packs: 0, jobs: 0))

    // The store rolls to a second pack: the first is sealed and goes once, with its hash.
    let packs = fixture.directory.appending(path: "source/packs")
    try Data("open".utf8).write(to: packs.appending(path: "2.pack"))
    #expect(try await uploader.backupStatus() == .init(packs: 1, jobs: 0))
    try await uploader.backUp(library: fixture.library)
    let sent = puts(host, "/backup/packs/")
    #expect(sent.map(\.path) == ["/backup/packs/pendant-1/1"])
    let first = try Data(contentsOf: packs.appending(path: "1.pack"))
    #expect(sent.first?.body == first)
    #expect(sent.first?.sha == sent.first.map { hex($0.body) })

    // A relaunch sends nothing again, nor does a reinstall whose server already holds both.
    uploader = try backupUploader(fixture, host: host)
    try await uploader.backUp(library: fixture.library)
    try FileManager.default.removeItem(at: fixture.directory.appending(path: "upload"))
    let pack = try #require(sent.first)
    let today = Date.now.formatted(.iso8601.year().month().day())
    RebuildServer.hosts.withLock {
        $0[host]?.backup = """
            {"packs":[{"name":"1","sha256":"\(hex(pack.body))","bytes":\(pack.body.count)}],
             "latestSnapshot":{"date":"\(today)","sha256":"\(snapshot.sha ?? "")","bytes":1,"uploadedAt":"2026-10-14T00:00:00.000Z"}}
            """
    }
    uploader = try backupUploader(fixture, host: host)
    #expect(try await uploader.backupStatus() == .init(packs: 1, jobs: 0), "not known before the server is asked")
    try await uploader.backUp(library: fixture.library)
    #expect(puts(host, "/backup/").count == 2)
    #expect(try await uploader.backupStatus() == .init(packs: 0, jobs: 0))

    try FileManager.default.removeItem(at: packs.appending(path: "2.pack"))
    #expect(try await ackState(fixture) == before, "the backup never writes the source store")
}

/// A 16 kHz mono file, as an imported recording's audio.
private func writeRecording(_ url: URL, seconds: Int) throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(seconds * 16_000)))
    buffer.frameLength = buffer.frameCapacity
    for index in 0..<Int(buffer.frameLength) {
        buffer.floatChannelData![0][index] = 0.2 * sin(2 * .pi * 220 * Float(index) / 16_000)
    }
    try file.write(from: buffer)
}

@Test func oldJobsAudioRendersAgainToTheJobsShaImportedFirstAndAMismatchIsSkippedOnce() async throws {
    let host = "jobs-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<10)
    let timeline = try await fixture.scanner().scan()

    // An imported recording: its file and its conversation, as the old app's import left them.
    let imported = ConversationID(anchor: at(100))
    try FileManager.default.createDirectory(at: fixture.library.importedAudio, withIntermediateDirectories: true)
    try writeRecording(fixture.library.importedAudio.appending(path: "r1.wav"), seconds: 3)
    let runs = [FileRun(interval: at(100)..<at(103), fileMillis: 0)]
    let audio = ImportedAudio(recordingID: "r1", file: "r1.wav", runs: runs, captureTimeVerified: true)
    try SQLite(path: fixture.directory.appending(path: "library/library.sqlite").path).run(
        "INSERT INTO imported_audio (id, json) VALUES (?1, ?2)",
        [.int(at(100).millis), .blob(try JSONEncoder().encode(audio))])

    // The hashes the old pipeline got when it rendered these parts.
    let work = fixture.directory.appending(path: "then.ogg")
    let pendantMap = try #require(TimeMap(segments: [at(1)..<at(3), at(5)..<at(7)]))
    let pendantSha = try await PreparedAudio.render(
        pendantMap,
        from: SourceAudio(
            store: fixture.source, deviceID: "pendant-1", spans: try await timeline.spans(overlapping: at(1)..<at(7))),
        to: work
    ).sha256
    let importedMap = try #require(TimeMap(segments: [at(100)..<at(103)]))
    let importedSha = try await PreparedAudio.render(
        importedMap, from: FileAudio(url: fixture.library.importedAudio.appending(path: "r1.wav"), runs: runs), to: work
    ).sha256

    let jobs = (1...4).map { UUID(uuidString: "00000000-0000-4000-8000-00000000020\($0)")! }
    let parts = [
        PartRecord(
            conversation: ConversationID(anchor: at(0)), segments: pendantMap.segments, jobID: jobs[0],
            sha256: pendantSha, state: "completed"),
        // Rendered from audio the clock has moved since: it no longer hashes to its job's.
        PartRecord(
            conversation: ConversationID(anchor: at(8)), segments: [at(8)..<at(9)], jobID: jobs[1],
            sha256: String(repeating: "0", count: 64), state: "completed"),
        PartRecord(
            conversation: ConversationID(anchor: at(9)), segments: [at(9)..<at(10)], jobID: jobs[2],
            sha256: pendantSha, state: "failed"),
        PartRecord(
            conversation: imported, segments: importedMap.segments, jobID: jobs[3], sha256: importedSha,
            state: "completed"),
    ]
    let store = try SQLite(path: fixture.directory.appending(path: "timeline.sqlite").path)
    for (index, part) in parts.enumerated() {
        try store.run(
            "INSERT INTO parts VALUES (?1, ?2, ?3)",
            [.int(part.conversation.anchor.millis), .int(Int64(index)), .blob(try JSONEncoder().encode(part))])
    }

    var uploader = try backupUploader(fixture, host: host)
    #expect(try await uploader.backupStatus().jobs == 3, "a failed part's job has no audio to keep")
    let skipped = try await uploader.backUp(library: fixture.library)
    let sent = puts(host, "/jobs/")
    let path = { (job: UUID) in "/jobs/\(job.uuidString.lowercased())/audio" }
    #expect(sent.map(\.path) == [path(jobs[3]), path(jobs[0])], "imported first, then oldest first")
    #expect(sent.map { hex($0.body) } == [importedSha, pendantSha], "rendered again byte for byte")
    #expect(skipped.count == 1 && skipped[0].contains(jobs[1].uuidString.lowercased()))

    // Nothing is rendered or tried again, the mismatch included.
    uploader = try backupUploader(fixture, host: host)
    #expect(try await uploader.backUp(library: fixture.library).isEmpty)
    #expect(puts(host, "/jobs/").count == 2)
    #expect(try await uploader.backupStatus().jobs == 0)
}

@Test func aServerRefusalIsSkippedOnceAndAnOutageWaitsForTheNextRound() async throws {
    let host = "refusal-\(UUID().uuidString).test"
    let fixture = try ScannerFixture()
    try await fixture.store(0..<5)
    let packs = fixture.directory.appending(path: "source/packs")
    try Data("open".utf8).write(to: packs.appending(path: "2.pack"))
    RebuildServer.hosts.withLock { $0[host, default: .init()].failures["/backup/packs/pendant-1/1"] = [503, 401, 400] }
    let uploader = try backupUploader(fixture, host: host)

    try await uploader.backUp(library: fixture.library)
    #expect(try await uploader.backupStatus().packs == 1, "the bucket was down: it waits")
    try await uploader.backUp(library: fixture.library)
    #expect(try await uploader.backupStatus().packs == 1, "the token was refused: it waits")
    #expect(try await uploader.backUp(library: fixture.library).count == 1)
    try await uploader.backUp(library: fixture.library)
    #expect(puts(host, "/backup/packs/").count == 3)
}
