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
