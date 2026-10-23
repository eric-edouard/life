import Foundation
@testable import Library
import SourceStore
import Synchronization
import Testing
import Timeline

private let base: Int64 = 1_790_000_000_000

private func at(_ seconds: Int64) -> CaptureInstant { CaptureInstant(millis: base + seconds * 1000) }

private func iso(_ seconds: Int64) -> String { at(seconds).date.formatted(.iso8601) }

private func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "library-\(UUID().uuidString)")
}

private func conversation(
    _ n: Int, _ start: Int64, _ end: Int64, kind: String = "conversation", title: String? = nil,
    retiredInto: Int? = nil
) -> String {
    let retired = retiredInto.map { #"{"successorId":"\#(id($0))"}"# } ?? "null"
    let title = title.map { "\"\($0)\"" } ?? "null"
    return #"""
        {"id":"\#(id(n))","startAt":"\#(iso(start))","endAt":"\#(iso(end))","kind":"\#(kind)","title":\#(title),
         "ownerTitle":null,"tldr":null,"place":null,"waiting":null,"retired":\#(retired),"state":"closed"}
        """#
}

private func turn(
    _ index: Int, _ start: Int64, _ text: String, conversation: Int, person: String? = nil, owner: Bool = false
) -> String {
    let name = person.map { "\"\($0)\"" } ?? "null"
    let shown = person ?? "Speaker \(index % 2 + 1)"
    return #"""
        {"jobId":"\#(id(99))","turnIndex":\#(index),"conversationId":"\#(id(conversation))",
         "startAt":"\#(iso(start))","endAt":"\#(iso(start + 4))","text":"\#(text)","language":"en",
         "speaker":{"label":"speaker_\#(index % 2)","personId":null,"personName":\#(name),"isOwner":\#(owner),
                    "displayName":"\#(shown)"}}
        """#
}

private func page(_ cursor: Int, _ arrays: [String: [String]]) -> Data {
    let body = arrays.map { "\"\($0.key)\":[\($0.value.joined(separator: ","))]" }.joined(separator: ",")
    return Data(#"{"cursor":"\#(cursor)","more":false,\#(body)}"#.utf8)
}

@Test func futureSchemaFailsClosed() throws {
    let directory = temporaryDirectory()
    _ = try LibraryStore(directory: directory)
    try SQLite(path: directory.appending(path: "library.sqlite").path).execute("PRAGMA user_version = 99")
    #expect(throws: LibraryStoreError.unknownSchemaVersion(99)) { try LibraryStore(directory: directory) }
}

@Test func aConversationsOpeningWordsReadOnlyItsOwnTurns() throws {
    let directory = temporaryDirectory()
    _ = try LibraryStore(directory: directory)
    let plan = try SQLite(path: directory.appending(path: "library.sqlite").path).query(
        "EXPLAIN QUERY PLAN \(LibraryStore.openingWords)", [.text(id(1))]
    ) { $0.text(3) }
    #expect(plan == ["SEARCH feed_rows USING INDEX feed_rows_conversation (kind=? AND conversation=?)"])
}

@Test func anImportedRecordingsAudioMovesToItsOwnTableOnce() async throws {
    let directory = temporaryDirectory()
    // A library as the old app left it: every migration before the rebuild's.
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let db = try SQLite(path: directory.appending(path: "library.sqlite").path)
    let before = try #require(LibraryStore.migrations.firstIndex { $0.contains("CREATE TABLE feed_rows") })
    for sql in LibraryStore.migrations.prefix(before) { try db.execute(sql) }
    try db.execute("PRAGMA user_version = \(before)")
    let audio = ImportedAudio(recordingID: "r1", file: "r1.m4a", runs: [], captureTimeVerified: true)
    let id = ConversationID(anchor: at(0))
    try db.run(
        "INSERT INTO conversations (id, start_ms, end_ms, json) VALUES (?1, ?2, ?3, ?4)",
        [
            .int(id.anchor.millis), .int(at(0).millis), .int(at(60).millis),
            .blob(try JSONEncoder().encode(["imported": audio])),
        ])
    let library = try LibraryStore(directory: directory)
    #expect(try await library.importedAudio(of: id.serverID) == audio)
    #expect(try await library.importedAudio(of: UUID()) == nil)
    // The old pipeline's tables went once the cutover was done.
    let old = "SELECT name FROM sqlite_master WHERE name IN ('conversations', 'retired', 'owner_edits', 'vocabulary')"
    #expect(try db.query(old) { $0.text(0) }.isEmpty)
}

@Test func bookmarksLeaveTheLibraryOnce() async throws {
    let directory = temporaryDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let db = try SQLite(path: directory.appending(path: "library.sqlite").path)
    let before = try #require(LibraryStore.migrations.firstIndex { $0.contains("DROP TABLE bookmarks") })
    for sql in LibraryStore.migrations.prefix(before) { try db.execute(sql) }
    try db.execute("PRAGMA user_version = \(before)")
    try db.execute(
        #"""
        INSERT INTO feed_rows (kind, key, json) VALUES ('bookmarks', 'app:1', '{}'), ('chapters', 'c', '{}');
        INSERT INTO outbox (id, intent, created_ms) VALUES
            ('a', '{"bookmark":{"id":"app:1"}}', 0), ('b', '{"deleteBookmark":{"id":"app:1"}}', 0),
            ('c', '{"title":{"title":"Kept"}}', 0);
        """#)
    _ = try LibraryStore(directory: directory)
    #expect(try db.query("SELECT kind FROM feed_rows") { $0.text(0) } == ["chapters"])
    #expect(try db.query("SELECT id FROM outbox") { $0.text(0) } == ["c"])
    #expect(try db.query("SELECT name FROM sqlite_master WHERE name = 'bookmarks'") { $0.text(0) }.isEmpty)
}

@Test func aWaitingReleaseLeavesTheOutbox() async throws {
    let directory = temporaryDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let db = try SQLite(path: directory.appending(path: "library.sqlite").path)
    let before = try #require(LibraryStore.migrations.firstIndex { $0.contains("releaseHeld") })
    for sql in LibraryStore.migrations.prefix(before) { try db.execute(sql) }
    try db.execute("PRAGMA user_version = \(before)")
    try db.execute(
        #"""
        INSERT INTO outbox (id, intent, created_ms) VALUES
            ('a', '{"releaseHeld":{"through":0}}', 0), ('c', '{"title":{"title":"Kept"}}', 0);
        """#)
    _ = try LibraryStore(directory: directory)
    #expect(try db.query("SELECT id FROM outbox") { $0.text(0) } == ["c"])
}

@Test func aRowThatDoesntDecodeIsLeftOutAndReported() async throws {
    let reported = Mutex<[String]>([])
    let library = try LibraryStore(directory: temporaryDirectory()) { error in
        reported.withLock { $0.append("\(error)") }
    }
    let broken = #"{"id":"\#(id(2))","startAt":"\#(iso(100))","endAt":"\#(iso(160))","kind":7}"#
    try await library.apply(feed: page(1, ["conversations": [conversation(1, 0, 60), broken]])) { _ in }
    #expect(try await library.conversations(before: nil, limit: 10).map(\.id.uuidString) == [id(1).uppercased()])
    #expect(reported.withLock { $0.count } == 1)
    #expect(reported.withLock { $0.first?.hasPrefix("conversations \(id(2))") } == true)
}

@Test func theListShowsLiveConversationsNewestFirstAndARetiredOneOpensItsSuccessor() async throws {
    let library = try LibraryStore(directory: temporaryDirectory())
    try await library.apply(
        feed: page(
            1,
            [
                "conversations": [
                    conversation(1, 0, 60, title: "Plumber"), conversation(2, 100, 160, retiredInto: 1),
                    conversation(3, 200, 260, kind: "silent"), conversation(4, 300, 360),
                    conversation(5, 400, 460, kind: "dictation"),
                ]
            ]), withdrawn: { _ in })
    let listed = try await library.conversations(before: nil, limit: 10).map(\.id.uuidString)
    #expect(listed == [id(4), id(1)].map { $0.uppercased() }, "retired, silent and dictation aren't listed")
    let quiet = try await library.quietConversations(in: at(0)..<at(1000)).map(\.id.uuidString)
    #expect(quiet == [id(3), id(5)].map { $0.uppercased() }, "folded into a line a day instead")
    #expect(try await library.conversations(before: at(300), limit: 10).map(\.shownTitle) == ["Plumber"])
    #expect(try await library.conversation(UUID(uuidString: id(2))!)?.shownTitle == "Plumber")
}

@Test func aConversationsWordsAreTheOnesTheFeedPutsInIt() async throws {
    let library = try LibraryStore(directory: temporaryDirectory())
    try await library.apply(
        feed: page(
            1,
            [
                "conversations": [conversation(1, 0, 100)],
                "turns": [
                    turn(0, 10, "Remember the plumber.", conversation: 1, owner: true),
                    turn(1, 20, "Monday at nine.", conversation: 1, person: "Marie-Jo"),
                    turn(2, 70, "", conversation: 1), turn(3, 80, "Bring the keys.", conversation: 1),
                ],
            ]), withdrawn: { _ in })
    // A split at 50 s: the server sends the conversations again, and the turns it moved.
    try await library.apply(
        feed: page(
            2,
            [
                "conversations": [conversation(1, 0, 50), conversation(6, 50, 100)],
                "turns": [turn(2, 70, "", conversation: 6), turn(3, 80, "Bring the keys.", conversation: 6)],
            ]), withdrawn: { _ in })
    let first = try #require(try await library.conversation(UUID(uuidString: id(1))!))
    #expect(try await library.turns(of: first.id).map(\.text) == ["Remember the plumber.", "Monday at nine."])
    let second = try #require(try await library.conversation(UUID(uuidString: id(6))!))
    #expect(try await library.turns(of: second.id).map(\.text) == ["Bring the keys."], "empty text is hidden")

    let facts = try await library.facts(of: [first, second])
    #expect(
        facts[first.id]
            == ConversationFacts(
                people: ["Marie-Jo"], opening: "Remember the plumber. Monday at nine.", hasWords: true))
}

@Test func aRemovedRowGoesAndARowSentAgainReplacesItsSearchText() async throws {
    let library = try LibraryStore(directory: temporaryDirectory())
    try await library.apply(
        feed: page(
            1,
            [
                "conversations": [conversation(1, 0, 100, title: "Lunch with Mai"), conversation(2, 200, 300)],
                "turns": [turn(0, 210, "ต้มยำกุ้ง อร่อยมาก", conversation: 2), turn(1, 20, "See you", conversation: 1)],
            ]), withdrawn: { _ in })
    #expect(try await library.search("lunch", limit: 10).map(\.passage) == [nil], "a title opens at the top")
    let thai = try await library.search("อร่อย", limit: 10)
    #expect(thai.map(\.conversation.uuidString) == [id(2).uppercased()])
    #expect(thai.first?.passage == at(210), "words open at their turn")
    #expect(try await library.search("lu", limit: 10).isEmpty, "too short for the index")

    try await library.apply(
        feed: Data(
            #"""
            {"cursor":"2","conversations":[\#(conversation(1, 0, 100, title: "Dinner"))],
             "removed":[{"kind":"turn","ref":"\#(id(99)):0"}]}
            """#.utf8), withdrawn: { _ in })
    #expect(try await library.search("lunch", limit: 10).isEmpty)
    #expect(try await library.search("อร่อย", limit: 10).isEmpty)
    #expect(try await library.search("dinner", limit: 10).count == 1)
}

@Test func aConversationsStateIsTheFeedsUnlessItsAudioIsStillOnlyHere() {
    func state(_ server: String?, unsent: Bool = false) -> ConversationState {
        // As the feed's row decodes it.
        let decoded = server.map { try? JSONDecoder().decode(ConversationState.self, from: Data("\"\($0)\"".utf8)) }
        return ConversationState(
            CachedConversation(id: UUID(), startAt: at(0).date, endAt: at(600).date, state: decoded ?? nil),
            unsent: unsent)
    }
    #expect(state("transcribing") == .transcribing)
    #expect(state("held") == .transcribed, "a state from before limits went reads as transcribed")
    #expect(state("summarized", unsent: true) == .notUploaded, "the phone adds only Not uploaded yet")
    #expect(state(nil) == .transcribed, "a row cached before the feed said")
    #expect(state("closed") == .transcribed, "a state this app doesn't know")
}

@Test func audioNotUploadedYetIsOneRowPerGapBetweenConversationsAndPerDay() {
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = .gmt
    let day = CaptureInstant(utc.startOfDay(for: at(0).date)).advanced(by: 86_400_000)
    func t(_ seconds: Int64) -> CaptureInstant { day.advanced(by: seconds * 1000) }
    // Three blocks, a conversation, two more blocks, then an unplanned tail past midnight.
    let unsent = [t(0)..<t(10), t(20)..<t(30), t(40)..<t(50), t(200)..<t(210), t(220)..<t(230), t(300)..<t(86_500)]
    let rows = ConversationState.notUploaded(unsent, between: [t(100)..<t(150)], calendar: utc)
    #expect(rows == [t(0)..<t(50), t(200)..<t(86_400), t(86_400)..<t(86_500)])
}

@Test func uploadsLeaveOutTheFeedsQuietRangesAndThisPhonesPlaybackWhichGrowsInPlace() async throws {
    let store = try LibraryStore(directory: temporaryDirectory())
    let dictation = #"{"id":"\#(id(7))","startedAt":"\#(iso(0))","endedAt":"\#(iso(5))"}"#
    try await store.apply(feed: page(1, ["quietRanges": [dictation]])) { _ in }
    // Stored as it plays, then closed a little shorter than the last guess: one range, the latest end.
    try await store.setPlaybackQuiet(at(10)..<at(40))
    try await store.setPlaybackQuiet(at(10)..<at(70))
    try await store.setPlaybackQuiet(at(10)..<at(55))
    #expect(try await store.quietRanges(in: at(0)..<at(100)) == [at(0)..<at(5), at(10)..<at(55)])
}

@Test func locationHistoryIsSentOnceAndADepartureAgain() async throws {
    let store = try LibraryStore(directory: temporaryDirectory())
    let fix = PlaceObservation(at: at(0), latitude: 21.0, longitude: 105.8, accuracyMeters: 10)
    let arrived = LocationVisit(arrival: at(60), departure: nil, latitude: 21.0, longitude: 105.8, accuracyMeters: 30)
    try await store.record(fix)
    try await store.record(arrived)
    try await store.record(arrived)  // reported twice: still one row

    let first = try await store.unsentLocations(limit: 10)
    #expect(first.fixes == [fix] && first.visits == [arrived])
    var departed = arrived
    departed.departure = at(600)
    try await store.record(departed)  // while the first batch was on its way
    try await store.markSent(fixes: first.fixes, visits: first.visits)

    let second = try await store.unsentLocations(limit: 10)
    #expect(second.fixes.isEmpty && second.visits == [departed])
}

private func spoken(_ start: Int64, _ end: Int64) -> CachedTurn {
    CachedTurn(
        jobId: UUID(), turnIndex: Int(start), startAt: at(start).date, endAt: at(end).date, text: "\(start)",
        speaker: .init(label: "speaker_0", displayName: "Speaker 1"))
}

@Test func readingAlongHoldsATurnThroughAShortPauseOnly() {
    let turns = [spoken(0, 1), spoken(2, 3), spoken(12, 13)]
    #expect(turns.line(at: at(-1)) == nil)
    #expect(turns.line(at: at(2)) == 1, "the next turn starts exactly here")
    #expect(turns.line(at: CaptureInstant(millis: at(4).millis + 400)) == 1, "a short pause holds it")
    #expect(turns.line(at: at(5)) == nil, "a long silence highlights nothing")
    #expect(turns.line(at: at(13)) == 2)
}

@Test func photosFollowTheirTurnAndChaptersGoBeforeTheTurnTheyStartAt() {
    let turns = [spoken(1, 2), spoken(100, 101), spoken(300, 301), spoken(500, 501)]
    let photos: [Int64] = [0, 2, 100, 150, 250, 470, 510, 600]
    let grouped = turns.turns(of: photos) { at($0) }
    #expect(grouped[at(1)] == [0, 2])
    #expect(grouped[at(100)] == [100, 150, 250], "a burst into a pause stays together")
    #expect(grouped[at(300)] == [470, 510])
    #expect(grouped[at(500)] == [600])
    #expect([CachedTurn]().turns(of: photos) { at($0) }.isEmpty)

    let chapters = [
        CachedChapter(id: UUID(), startAt: at(0).date, endAt: at(200).date, title: "Greetings"),
        CachedChapter(id: UUID(), startAt: at(299).date, endAt: at(600).date, title: "Lunch"),
    ]
    let blocks = TranscriptBlock.fold(turns, chapters: chapters)
    let headings = blocks.compactMap { block -> CaptureInstant? in
        if case .chapter(_, let line) = block { line } else { nil }
    }
    #expect(headings == [at(1), at(300)])
    #expect(TranscriptBlock.fold(turns, chapters: [chapters[0]]).count == turns.count, "one chapter: no heading")

    let splits = TranscriptBlock.fold(turns, splits: [at(0).date, at(250).date]).compactMap {
        block -> CaptureInstant? in
        if case .splitSuggestion(_, let line) = block { line } else { nil }
    }
    #expect(splits == [at(300)], "before the turn the boundary falls on; never above the first turn")
}
