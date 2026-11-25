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
