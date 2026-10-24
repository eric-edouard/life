import Foundation
import QuietCore
import Testing

// The dictation rules are the server's (apps/server/src/dictation.test.ts); the helper only keeps its events.

private func object(_ frame: String) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any])
}

private let encoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = .sortedKeys
    return encoder
}()

private let decoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
}()

@Test func anUnackedEventGoesAgainOnEverySocketUntilAcked() throws {
    var outbox = Outbox()
    let at = Date(timeIntervalSince1970: 1_790_000_000)
    let on = outbox.add(capturing: ["com.FluidApp.app", "com.apple.FaceTime"], at: at)
    let sleep = outbox.add(capturing: nil, at: at)
    #expect(on.seq == 1_790_000_000_000 && sleep.seq == on.seq + 1, "the time in ms, else one more")
    // Each new socket sends them whole, in order; nothing but an ack removes one.
    let first = outbox.frames(using: encoder)
    #expect(first == outbox.frames(using: encoder), "a reconnect sends the same frames, same seqs")
    let mic = try object(try #require(first.first))
    #expect(Set(mic.keys) == ["type", "seq", "at", "capturing"])
    #expect(mic["type"] as? String == "mic" && mic["seq"] as? Int == on.seq)
    #expect(mic["capturing"] as? [String] == ["com.FluidApp.app", "com.apple.FaceTime"])
    let asleep = try object(try #require(first.last))
    #expect(Set(asleep.keys) == ["type", "seq", "at"] && asleep["type"] as? String == "sleep")
    // A message that isn't an ack leaves them.
    #expect(!outbox.ack(message: #"{"type":"llm","seq":\#(on.seq)}"#) && !outbox.ack(message: "not json"))
    #expect(outbox.events == [on, sleep])
    // The server's ack clears its seq and any before it.
    outbox.ack(message: #"{"type":"ack","seq":\#(on.seq)}"#)
    #expect(outbox.events == [sleep])
    // A file read again keeps counting from where it was.
    var again = try Outbox.read(try encoder.encode(outbox), using: decoder)
    #expect(again == outbox)
    #expect(again.add(capturing: [], at: at).seq == sleep.seq + 1)
}

@Test func aLostFileWithAClockBehindIsNumberedAboveWhatTheServerApplied() throws {
    // The file is gone and the clock runs behind the server's count: these would read as resends.
    var outbox = Outbox()
    let behind = Date(timeIntervalSince1970: 1)
    outbox.add(capturing: ["claude"], at: behind)
    outbox.add(capturing: [], at: behind)
    #expect(outbox.events.map(\.seq) == [1000, 1001])
    let applied = try #require(Outbox.welcome(message: #"{"type":"welcome","lastSeq":5000}"#))
    outbox.rebase(above: applied)
    #expect(outbox.events.map(\.seq) == [5001, 5002], "in order, above it")
    #expect(outbox.add(capturing: nil, at: behind).seq == 5003, "and every later one")
    #expect(Outbox.welcome(message: #"{"type":"ack","seq":1}"#) == nil)
    #expect(outbox.refused(reason: "invalid event", capturing: [], at: behind)?.seq == 5001)
}

@Test func eventsAppliedWhoseAcksWereLostKeepTheirSeqs() throws {
    // A numbered file: [off at T1, on at T2], both applied, both acks lost.
    var outbox = Outbox()
    outbox.rebase(above: 0)
    let off = outbox.add(capturing: [], at: Date(timeIntervalSince1970: 1_790_000_000))
    let on = outbox.add(capturing: ["claude"], at: Date(timeIntervalSince1970: 1_790_000_010))
    outbox.rebase(above: on.seq)
    // Same seqs: the server acks both as resends. Renumbered, the off would apply after the on and close it.
    #expect(outbox.events.map(\.seq) == [off.seq, on.seq])
    #expect(outbox.add(capturing: nil, at: Date(timeIntervalSince1970: 1)).seq == on.seq + 1)
    // The file read again stays numbered.
    let again = try Outbox.read(try encoder.encode(outbox), using: decoder)
    #expect(again.known && again == outbox)
}

@Test func aSeqBehindRenumbersAtTheNextWelcomeInsteadOfStallingForGood() {
    // A numbered file whose seqs the server already passed by another path (its database replaced).
    var outbox = Outbox()
    outbox.rebase(above: 0)
    let event = outbox.add(capturing: ["claude"], at: Date(timeIntervalSince1970: 1_790_000_000))
    outbox.rebase(above: event.seq + 100)
    #expect(outbox.events.map(\.seq) == [event.seq], "kept: it reads as applied")
    #expect(outbox.refused(reason: "seq behind", capturing: [], at: .now) == nil)
    #expect(!outbox.known)
    outbox.rebase(above: event.seq + 100)
    #expect(outbox.events.map(\.seq) == [event.seq + 101], "above it, so it applies")
}

@Test func anInvalidEventIsDroppedAndTheCaptureSetFollowsAtOnce() {
    var outbox = Outbox()
    let bad = outbox.add(capturing: ["claude"], at: Date(timeIntervalSince1970: 1_790_000_000))
    let next = outbox.add(capturing: [], at: Date(timeIntervalSince1970: 1_790_000_100))
    let now = Date(timeIntervalSince1970: 1_790_000_200)
    #expect(outbox.refused(reason: "invalid event", capturing: ["claude"], at: now) == bad)
    // The span of unknown source ends with the next event the server applies: the one queued, then this one now.
    #expect(outbox.events.map(\.capturing) == [next.capturing, ["claude"]])
    #expect(outbox.events.last?.at == now)
    // A database failure changes nothing: the same event goes again.
    let before = outbox
    #expect(outbox.refused(reason: "event not stored", capturing: [], at: now) == nil && outbox == before)
}

@Test func anOutboxWrittenBeforeKnownReadsAsNotNumberedYet() throws {
    let file = #"{"events":[{"seq":7,"at":"2026-10-20T10:00:00Z","capturing":[]}],"lastSeq":7}"#
    let outbox = try Outbox.read(Data(file.utf8), using: decoder)
    #expect(!outbox.known && outbox.events.map(\.seq) == [7] && outbox.lastSeq == 7)
}

@Test func namesAndListsAreTrimmedToWhatTheServerTakes() {
    var outbox = Outbox()
    let long = String(repeating: "x", count: 300)
    let event = outbox.add(capturing: [long] + (0..<250).map { "app\($0)" }, at: .now)
    #expect(event.capturing?.count == 200 && event.capturing?.allSatisfy { $0.count <= 200 } == true)
}

@Test func protocolOnesRangesBecomeTheEventsThatMakeThem() throws {
    let file = """
        [{"id":"\(UUID().uuidString)","startedAt":"2026-10-20T10:00:00Z","endedAt":"2026-10-20T10:00:12Z",
          "source":"com.FluidApp.app"}]
        """
    let outbox = try Outbox.read(Data(file.utf8), using: decoder)
    let start = try #require(ISO8601DateFormatter().date(from: "2026-10-20T10:00:00Z"))
    #expect(outbox.events.map(\.capturing) == [["com.FluidApp.app"], []])
    // The server pads them back: 1 s before, 1.5 s after.
    #expect(outbox.events.map { $0.at.timeIntervalSince(start) } == [1, 10.5])
    #expect(throws: (any Error).self) { try Outbox.read(Data("nonsense".utf8), using: decoder) }
}

@Test func theHelloListsTheEnginesAndTheCallsStillRunning() throws {
    let hello = try object(helloMessage(running: ["b", "a"]))
    #expect(hello["type"] as? String == "hello" && hello["engines"] as? [String] == ["claude", "codex"])
    #expect(hello["running"] as? [String] == ["a", "b"])
}

@Test func reconnectsBackOffAndAnOpenSocketResetsThem() {
    var backoff = Backoff()
    #expect((0..<8).map { _ in backoff.next() } == [1, 2, 4, 8, 16, 32, 60, 60])
    for _ in 0..<100 { _ = backoff.next() }
    #expect(backoff.next() == 60, "never overflows")
    backoff.reset()
    #expect(backoff.next() == 1)
}
