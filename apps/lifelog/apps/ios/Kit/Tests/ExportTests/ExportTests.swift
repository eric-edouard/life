import Export
import Foundation
import Library
import Testing
import Timeline

private let base: Int64 = 1_790_000_000_000
private let jakarta = TimeZone(identifier: "Asia/Jakarta") ?? .gmt
private let created = Date(timeIntervalSince1970: 1_790_000_100)
private let mai = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1))
private let job = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2))

private func at(_ offset: Int64) -> CaptureInstant { CaptureInstant(millis: base + offset) }

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "export-\(UUID().uuidString)", directoryHint: .isDirectory)
}

private let conversation = CachedConversation(
    id: ConversationID(anchor: at(0)).serverID, startAt: at(0).date, endAt: at(60_000).date,
    title: "Lunch plans", tldr: "Mai and you decide to get tom yum.", place: "Home")

private let turns: [CachedTurn] = [
    ("Hello Mai, how are you?", 1000, 2800, "speaker_0", nil as UUID?, true, "You"),
    ("สบายดีครับ", 3500, 4600, "speaker_1", mai, false, "Mai"),
    ("Let's get tom yum.", 10_000, 11_400, "speaker_0", nil, true, "You"),
    (
        "And a long sentence that goes on and on, past what one caption holds, so it is cut in two.", 20_000, 26_000,
        "speaker_2", nil, false, "Speaker 1"
    ),
].enumerated().map { index, turn in
    CachedTurn(
        jobId: job, turnIndex: index, startAt: at(Int64(turn.1)).date, endAt: at(Int64(turn.2)).date, text: turn.0,
        language: "en",
        speaker: .init(
            label: turn.3, displayName: turn.6, personId: turn.4, personName: turn.4 == nil ? nil : "Mai",
            isOwner: turn.5))
}

private func fixture(range: Range<CaptureInstant>? = nil, turns: [CachedTurn] = turns) -> ConversationExport {
    ConversationExport(
        conversation: conversation, range: range, turns: turns,
        chapters: [
            CachedChapter(id: UUID(), startAt: at(1000).date, endAt: at(9000).date, title: "Greetings"),
            CachedChapter(
                id: UUID(), startAt: at(10_000).date, endAt: at(60_000).date, title: "Lunch", summary: "Tom yum."),
        ],
        observations: [PlaceObservation(at: at(5000), latitude: 21.0285, longitude: 105.8542, accuracyMeters: 12)],
        unrecorded: [at(30_000)..<at(40_000)], timeZone: jakarta)
}

/// Compares with the committed golden; `RECORD_GOLDENS=1 swift test` rewrites them.
private func expectGolden(_ actual: String, _ name: String, sourceLocation: SourceLocation = #_sourceLocation) throws {
    let url = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Golden/\(name)")
    if ProcessInfo.processInfo.environment["RECORD_GOLDENS"] != nil {
        try Data(actual.utf8).write(to: url)
    }
    #expect(Data(actual.utf8) == (try Data(contentsOf: url)), "\(name) differs", sourceLocation: sourceLocation)
}

@Test func textFormatsMatchTheirGoldensByteForByte() throws {
    let item = fixture()
    try expectGolden(item.plainText(), "transcript.txt")
    try expectGolden(item.markdown(), "transcript.md")
    try expectGolden(item.srt(), "captions.srt")
    try expectGolden(item.vtt(), "captions.vtt")
    try expectGolden(try item.json(), "conversation.json")
}

@Test func anAbsentTranscriptIsStatedEverywhere() throws {
    let item = fixture(turns: [])
    let statement = "No words were transcribed in this range."
    #expect(item.plainText().hasSuffix("\n\n\(statement)\n"))
    #expect(item.markdown().hasSuffix("_\(statement)_\n"))
    #expect(item.srt() == "1\n00:00:00,000 --> 00:01:00,000\n[\(statement)]\n")
    #expect(item.vtt().hasSuffix("00:00:00.000 --> 00:01:00.000\n[\(statement)]\n"))
    let document = item.document()
    #expect(document.transcript.isEmpty && document.transcriptAbsent == statement)
}

@Test func exportCoversExactlyTheRequestedRange() throws {
    let item = fixture(range: at(3000)..<at(10_700))
    let document = item.document()
    #expect([document.start.captureMs, document.start.audioMs] == [base + 3000, 0])
    #expect([document.end.captureMs, document.end.audioMs] == [base + 10_700, 7700])
    #expect(document.transcript.map(\.text) == ["สบายดีครับ", "Let's get tom yum."])
    #expect(document.transcript.allSatisfy { (base + 3000...base + 10_700).contains($0.end.captureMs) })
    #expect(document.locations.map(\.at.audioMs) == [2000])
    #expect(document.chapters.map(\.title) == ["Lunch"])
    #expect(item.srt().hasPrefix("1\n00:00:00,500 --> 00:00:01,600\nMai: สบายดีครับ\n"))
}

@Test func importerRejectsAnUnknownFutureVersion() throws {
    let root = temporaryDirectory()
    try ExportPackage.write([fixture()], formats: [.json], to: root, appVersion: "1.0", createdAt: created)
    let manifest = root.appending(path: "manifest.json")
    let text = try String(contentsOf: manifest, encoding: .utf8)
    try Data(text.replacing("\"version\" : 1", with: "\"version\" : 2").utf8).write(to: manifest)
    #expect(throws: ImportError.unsupportedVersion(2)) { try Importer.plan(root) }
}

@Test func importerRejectsTamperedFiles() throws {
    let root = temporaryDirectory()
    let manifest = try ExportPackage.write(
        [fixture()], formats: [.json], to: root, appVersion: "1.0", createdAt: created)
    let path = try #require(manifest.items.first?.files.first?.path)
    try Data("{}".utf8).write(to: root.appending(path: path))
    #expect(throws: ImportError.hashMismatch(path)) { try Importer.plan(root) }
}

@Test func zipUsesTheSystemArchiver() throws {
    let root = temporaryDirectory()
    try ExportPackage.write([fixture()], formats: [.txt], to: root, appVersion: "1.0", createdAt: created)
    let zip = root.deletingLastPathComponent().appending(path: "\(UUID().uuidString).zip")
    try ExportPackage.zip(root, to: zip)
    #expect(try Data(contentsOf: zip).prefix(2) == Data("PK".utf8))
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
