import Foundation
import Testing

@testable import LifeConnector

@Test func anAnswerSplitsIntoWordsAndTheBlocksThatRead() {
    let text = """
        You owe two.

        ```life:items
        ["life:card/a", "life:card/b"]
        ```
          ~~~life:table extra
          {"columns":["Who","€"],"from":"life:x","rows":[["Tomas",240],["Nora",12.5]],"total":252.5}
          ~~~
        ```life:unknown
        {}
        ```
        ```life:place
        {"name":"Clinic"}
        ```
        Done.
        """
    let parts = AnswerPart.parts(of: text)
    #expect(
        parts == [
            .markdown("You owe two."), .block(.items(["life:card/a", "life:card/b"])),
            .block(
                .table(.init(columns: ["Who", "€"], rows: [["Tomas", "240"], ["Nora", "12.5"]], total: "252.5"))),
            .markdown("Done."),
        ])
}

@Test func aFailedAskSaysItsReasonInPlainWords() {
    var entry = ThreadEntry(id: UUID(), at: Date(), words: "Hi", key: "", phase: .failed)
    #expect(entry.failure == "I couldn't answer that.")
    entry.why = "Desk is off (settings: desk)"
    #expect(entry.failure == "Life's agents are off, so nothing can answer yet.")
    entry.why = "The Mac is asleep."
    #expect(entry.failure == "The Mac is asleep.")
}

@MainActor @Test func anAskGetsItsAnswerAndAnOfflineOneWaits() async throws {
    let life = FakeLife()
    life.asked = { progress in
        progress(Data(#"{"kind":"reaction","with":"👀"}"#.utf8))
        progress(Data(#"{"kind":"step","verb":"Reading","what":"the card"}"#.utf8))
        progress(Data(#"{"kind":"words","text":"Friday "}"#.utf8))
        return #"{"kind":"reply","entry":4,"text":"Friday works.","refs":[],"acts":[]}"#
    }
    let thread = LifeThread(api: life)
    thread.ask("  Does Friday work?  ", screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(200))
    let e = try #require(thread.entries.first)
    #expect(e.words == "Does Friday work?" && e.phase == .answered && e.entry == 4)
    #expect(e.answer == "Friday works." && e.lifeReaction == "👀" && thread.live.isEmpty)
    life.asked = { _ in throw MCPError.offline }
    thread.ask("Hello", screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(200))
    #expect(thread.entries.last?.phase == .waiting)
    #expect(life.askedKeys.withLock { $0.count } == 2)
}

private let replyText = #"{"kind":"reply","entry":4,"text":"Done.","refs":[],"acts":[]}"#

@MainActor @Test func aRetryReusesItsKeyAndTwoSendsNeverSendTwice() async throws {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.timedOut }
    let thread = LifeThread(api: life)
    thread.ask("Hello", screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(100))
    #expect(thread.entries[0].phase == .waiting)
    // A slow call: two sendWaiting runs at once send one.
    life.asked = { _ in
        try await Task.sleep(for: .milliseconds(150))
        return replyText
    }
    async let a: Void = thread.sendWaiting(screen: MainSessionScreen())
    async let b: Void = thread.sendWaiting(screen: MainSessionScreen())
    _ = await (a, b)
    let keys = life.askedKeys.withLock { $0 }
    #expect(keys.count == 2 && keys[0] == keys[1] && thread.entries[0].phase == .answered)
}

@MainActor @Test func anUnansweredReplayKeepsLifeWorking() async throws {
    let life = FakeLife()
    life.asked = { _ in #"{"entry":4}"# }
    let thread = LifeThread(api: life)
    thread.ask("Hello", screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(100))
    #expect(thread.entries[0].phase == .sending && thread.entries[0].why == nil)
}

@MainActor @Test func aReactionAndAStopSendNoWordsAndNeverAnswerACheck() async throws {
    let life = FakeLife()
    life.asked = { _ in
        try await Task.sleep(for: .milliseconds(150))
        return replyText
    }
    let thread = LifeThread(api: life)
    thread.ask("Hello", screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(50))
    await thread.stop()
    try await Task.sleep(for: .milliseconds(250))
    await thread.react(thread.entries[0].id, with: "👍")
    let sent = life.askedRequests.withLock { $0 }
    #expect(sent.dropFirst().allSatisfy { $0.words == nil })
    #expect(sent.contains { $0.stop == true } && sent.contains { $0.react?.with == "👍" })
    #expect(life.requests.withLock { $0.isEmpty })
}

@Test func aFenceTheServerNeverSentIsNotDrawn() {
    let text = "Hi\n```life:items\n[\"life:card/a\"]\n```\n```life:items\n[\"life:card/b\"]\n```"
    let sentKey = LifeBlock.key(kind: "items", json: Data(#"["life:card/a"]"#.utf8))!
    #expect(AnswerPart.parts(of: text, sent: [sentKey]) == [.markdown("Hi"), .block(.items(["life:card/a"]))])
    #expect(AnswerPart.parts(of: text, sent: []) == [.markdown("Hi")])
}

private func wireEntry(
    _ id: Int, words: String, answer: String? = nil, error: String? = nil, at: Date = Date()
) throws -> ThreadWireEntry {
    var fields: [String: Any] = [
        "id": id, "at": ISO8601DateFormatter().string(from: at), "words": words, "handed": [], "reactions": [],
        "refs": [],
    ]
    fields["answer"] = answer
    fields["error"] = error
    return try JSONDecoder.wire.decode(ThreadWireEntry.self, from: JSONSerialization.data(withJSONObject: fields))
}

extension JSONDecoder {
    fileprivate static var wire: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

/// His ask Life's record now holds shows once, and a waiting ask keeps its key, so the send still happens once.
@MainActor @Test func aReadThatHoldsHisAskShowsItOnceAndAWaitingAskKeepsItsKey() async throws {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.timedOut }
    let thread = LifeThread(api: life)
    thread.ask("Hello", screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(100))
    thread.adopt([try wireEntry(7, words: "Hello")])
    #expect(thread.entries.count == 1 && thread.entries[0].phase == .waiting)
    life.asked = { _ in replyText }
    await thread.sendWaiting(screen: MainSessionScreen())
    let keys = life.askedKeys.withLock { $0 }
    #expect(keys.count == 2 && keys[0] == keys[1])
}

/// An answered entry the read holds drops the phone's copy, and his reaction survives a read that lacks it.
@MainActor @Test func anAdoptedAnswerDropsItsPendingCopyAndHisReactionSurvives() async throws {
    let life = FakeLife()
    life.asked = { _ in replyText }
    let thread = LifeThread(api: life)
    thread.ask("Hello", screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(200))
    await thread.react(thread.entries[0].id, with: "👍")
    thread.adopt([try wireEntry(4, words: "Hello", answer: "Done.")])
    #expect(thread.entries.count == 1 && thread.entries[0].answer == "Done.")
    #expect(thread.entries[0].ownerReaction == "👍")
}

/// A failed entry of Life's record asked again is a new ask with a new key, and the old one is no longer shown.
@MainActor @Test func aFailedEntryOfLifesRecordCanBeAskedAgain() async throws {
    let life = FakeLife()
    life.asked = { _ in replyText }
    let thread = LifeThread(api: life)
    thread.adopt([try wireEntry(9, words: "Hello", error: "It broke.")])
    #expect(thread.entries[0].phase == .failed)
    thread.askAgain(thread.entries[0].id, screen: MainSessionScreen())
    try await Task.sleep(for: .milliseconds(200))
    #expect(thread.entries.count == 1 && thread.entries[0].phase == .answered)
    #expect(life.askedKeys.withLock { $0.count } == 1)
}

@MainActor @Test func aTapOnAQuickEditIsAskedAsATap() async throws {
    let life = FakeLife()
    life.asked = { _ in replyText }
    let thread = LifeThread(api: life)
    thread.ask("Warmer", screen: MainSessionScreen(open: "dec_1", tab: "thread"), tap: true)
    thread.ask("Make it shorter", screen: MainSessionScreen(open: "dec_1", tab: "thread"))
    #expect(thread.entries.map(\.tap) == [true, nil])
    #expect(MainSessionRequest.ask("Warmer", screen: MainSessionScreen(), tap: true).tap == true)
}

/// A redraft's two answers on the wire (`MainSessionAsk`): a tapped chip carries `tap: true`, his typed change does not,
/// and both name the open ask in `screen.open`, so the server's `edit:tap` and `edit:words` tell them apart.
@Test func aRedraftsTapAndWordsEncodeAsTheWireExpects() throws {
    let screen = MainSessionScreen(open: "dec_1", tab: "thread")
    func wire(_ request: MainSessionRequest) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
    }
    let tapped = try wire(.ask("Warmer", screen: screen, tap: true))
    let typed = try wire(.ask("Make it shorter", screen: screen))
    #expect(tapped["tap"] as? Bool == true && tapped["words"] as? String == "Warmer")
    #expect(typed["tap"] == nil && typed["words"] as? String == "Make it shorter")
    #expect((tapped["screen"] as? [String: Any])?["open"] as? String == "dec_1")
    #expect((typed["screen"] as? [String: Any])?["open"] as? String == "dec_1")
}

/// A rating answer (`answer_check`) carries `rate` with the mark's wire word and no option, for each of the app's three
/// marks (`RatingMark.of`: 👎 bad, 👍 okay, 🤩 good).
@Test func aRatingAnswerEncodesItsMarkOnTheWire() throws {
    for (mark, word) in [(RatingMark.bad, "bad"), (.okay, "okay"), (.good, "good")] {
        let body = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(AnswerRequest.rating("dec_1", mark)))
                as? [String: Any])
        #expect(body["rate"] as? String == word && body["ref"] as? String == "dec_1")
        #expect((body["options"] as? [String])?.isEmpty ?? true)
    }
}

@MainActor @Test func theCountsTapListsTheAsksAtOnceWithoutAskingLife() {
    let life = FakeLife()
    let thread = LifeThread(api: life, cache: nil)
    thread.showWaiting(["life:card/a", "life:card/b"])
    let first = thread.entries.last
    #expect(first?.words == "What's waiting on me?" && first?.phase == .answered)
    #expect(
        AnswerPart.parts(of: first?.answer ?? "", sent: Set(first?.checked ?? []))
            == [.block(.items(["life:card/a", "life:card/b"]))])
    thread.showWaiting([])
    #expect(thread.entries.last?.answer == "Nothing waits on you.")
}

@Test func theHaloSettingsAreTheSettingsBlocksAuraKeyAndTheirSaveReadsBack() throws {
    #expect(
        LifeBlock(kind: "settings", json: Data(#"{"keys":["aura"]}"#.utf8)) == .settings(keys: ["aura"], offer: nil))
    // What `change_setting` answers is the aura as sent, every key the server's `Aura` names.
    let sent = try JSONEncoder().encode(["aura": AuraSetting.standard])
    #expect(AuraSetting.saved(in: String(decoding: sent, as: UTF8.self)) == .standard)
    #expect(AuraSetting.saved(in: #"{"budget":{"monthlyUsd":5}}"#) == nil)
}
