import Foundation
import Library
@testable import ServerAPI
import Synchronization
import Testing
@testable import Upload

/// The server's real answers (`fixtures/wire/`, written by `apps/server/src/wire.test.ts`), read with the phone's
/// types. A drift on either side fails the gate.
private let wire = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "fixtures/wire")

func wireFile(_ name: String) throws -> Data { try Data(contentsOf: wire.appending(path: "\(name).json")) }

/// What the phone sends equals the fixture the server's test posts. `WRITE_WIRE=1` rewrites it.
func expectWire(_ name: String, _ data: Data) throws {
    if ProcessInfo.processInfo.environment["WRITE_WIRE"] != nil {
        let object = try JSONSerialization.jsonObject(with: data)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
            .write(to: wire.appending(path: "\(name).json"))
        return
    }
    let sent = try JSONSerialization.jsonObject(with: data) as? NSDictionary
    let fixture = try JSONSerialization.jsonObject(with: try wireFile(name)) as? NSDictionary
    #expect(sent == fixture, "the phone's \(name) body drifted from fixtures/wire/\(name).json")
}

private let client = ServerClient(server: { URL(string: "https://wire.test") }) { "t" }
private let live = "00000000-0000-4000-8000-000000000001"
private let job = "00000000-0000-4000-8000-000000000003"

/// Collects what the library reports, so a row that doesn't decode fails the test.
private final class Reports: Sendable {
    let errors = Mutex<[String]>([])
    func add(_ error: any Error) { errors.withLock { $0.append("\(error)") } }
}

/// Every row of the server's page goes through the cache's own reads, each field set: a type the phone decodes wrong
/// fails here, never as an empty screen.
@Test func everyRowOfTheFeedDecodesThroughTheCachesReads() async throws {
    let reports = Reports()
    let library = try LibraryStore(
        directory: FileManager.default.temporaryDirectory.appending(path: "wire-\(UUID().uuidString)"),
        report: reports.add)
    let gone = UUID(uuidString: "00000000-0000-4000-8000-000000000005")!
    try await library.apply(feed: Data(#"{"cursor":"0","people":[{"id":"\#(gone)","name":"Old"}]}"#.utf8)) { _ in }
    let withdrawn = Mutex<[String]>([])
    let applied = try await library.apply(feed: try wireFile("changes")) { rows in
        withdrawn.withLock { $0 = rows.map { "\($0.sourceId) \($0.firstPage)" } }
    }
    #expect(!applied.more)
    #expect(withdrawn.withLock { $0 } == ["pendant-1 200"], "a withdrawn fragment's row")

    let conversation = try #require(try await library.conversation(UUID(uuidString: live)!))
    #expect(try await library.conversation(UUID(uuidString: "00000000-0000-4000-8000-000000000002")!) == conversation)
    #expect(try await library.conversations(before: nil, limit: 10) == [conversation], "the retired one isn't listed")
    #expect(conversation.ownerTitle != nil && conversation.title != nil && conversation.tldr != nil)
    #expect(conversation.place != nil && conversation.waiting?.since != nil)
    #expect(conversation.splitSuggestions?.isEmpty == false)
    // The server's one state, and the summary shown, which Generate names as seen.
    #expect(conversation.state == .summarized && conversation.runId != nil)

    let turns = try await library.turns(of: conversation.id)
    #expect(turns.map(\.turnIndex) == [0, 1])
    // The server's one name per voice: the owner by name, as the summaries say it.
    #expect(turns.map(\.speaker.displayName) == ["Dave", "Marie-Jo"])
    #expect(turns.allSatisfy { $0.language != nil && $0.speaker.personId != nil })
    // "Remember the plumber.": "the" is spoken from 1 s, without the space before it.
    #expect(turns[0].words?.spoken(at: 1200, in: turns[0].text) == NSRange(location: 9, length: 3))
    #expect(turns[0].words?.spoken(at: -1, in: turns[0].text) == nil)
    #expect(turns[1].words == [])
    #expect(turns[0].speaker.source == .owner)
    #expect(turns[1].speaker.source == .inferred)
    #expect(turns[1].speaker.inference?.confidence == 0.99)
    #expect(turns[1].speaker.inference?.evidence.first?.quote == "Monday at nine.")
    #expect(try await library.chapters(of: conversation.id).map(\.title) == ["Plumber"])
    let people = try await library.people()
    #expect(people.map(\.name) == ["Dave", "Marie-Jo"], "the person merged away is gone")
    #expect(people.contains { $0.isOwner } && people.contains { $0.aliases == ["Mari"] })
    let edits = try await library.edits(
        [8, 13, 14].map { UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", $0))! })
    #expect(edits.map(\.kind) == [.split, .merge, .undo])
    #expect(edits[1].from != nil && edits[1].to != nil && edits[1].undoneAt != nil)
    #expect(try await library.quietRanges(in: conversation.range).count == 1)
    #expect(try await library.waiting() == [.macAway: 1])

    let feed = try await library.feed()
    #expect(feed.switches?.engine == .claude && feed.pulledAt != nil)
    #expect(feed.mac?.llm != nil)
    #expect(feed.mac?.subscriptions?.claude == nil)
    #expect(feed.mac?.subscriptions?.codex?.sevenDay?.usedPercent == 42.5)
    #expect(feed.mac?.subscriptions?.codex?.fiveHour?.usedPercent == 0)
    #expect(feed.vocabulary == ["Oakridge"])
    #expect(reports.errors.withLock { $0 }.isEmpty, "every row decodes")
}

@Test func heldPagesDecodeWithTheUploadersTypes() throws {
    let held = try client.decode(ServerClient.SourceBlocks.self, try wireFile("blocks"))
    #expect(held.handedOver)
    #expect(held.blocks.map(\.ranges) == [[0...19, 40...59], [200...210, 213...220]], "an open fragment's pages too")
    #expect(held.sentThrough == Date(timeIntervalSince1970: 1_791_968_400.615))
}
