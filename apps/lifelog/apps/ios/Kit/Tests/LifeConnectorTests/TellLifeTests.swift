import Foundation
import Testing

@testable import LifeConnector

private func line(_ text: String) -> Data { Data(text.utf8) }

@MainActor @Test func theAnswerComesAfterItsLinesAndWorkAfterWordsStartsThemAgain() async {
    let life = FakeLife()
    life.asked = { report in
        report(line(#"{"kind":"thinking"}"#))
        report(line(#"{"kind":"words","text":"Let me look. "}"#))
        report(line(#"{"id":"a","kind":"working","state":"running","title":"Reading the card"}"#))
        report(line(#"{"kind":"words","text":"Friday works."}"#))
        report(line(#"{"id":"a","kind":"working","state":"completed","title":"Reading the card"}"#))
        return #"{"kind":"reply","words":"Friday works."}"#
    }
    let tell = TellLife(api: life)
    await tell.send("  Does Friday work?  ", screen: TellScreen(tab: "inbox"))
    #expect(tell.said == "Does Friday work?")
    #expect(tell.answer == .reply(words: "Friday works."))
    #expect(tell.stage == .ready)
    #expect(tell.strands == [TellStrand(id: "a", title: "Reading the card", state: "completed")])
    // The last `working` line came after the words and started them again.
    #expect(tell.words == "")
}

@MainActor @Test func aCallThatDroppedWaitsAndGoesAgainUnderTheSameKey() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.streamDropped }
    let tell = TellLife(api: life)
    await tell.send("Hello", screen: TellScreen())
    #expect(tell.stage == .offline)
    #expect(tell.waiting == "Hello")
    life.asked = { _ in #"{"kind":"reply","words":"Hi."}"# }
    await tell.sendAgain(screen: TellScreen())
    let keys = life.askedKeys.withLock { $0 }
    #expect(keys.count == 2 && keys[0] == keys[1] && keys[0] != nil)
    #expect(tell.answer == .reply(words: "Hi."))
    #expect(tell.waiting == nil)
}

@MainActor @Test func anErrorKeepsHisWordsAndAnUnknownKindIsSaidAsSuch() async {
    let life = FakeLife()
    life.asked = { _ in #"{"kind":"error","what":"The agent did not answer."}"# }
    let tell = TellLife(api: life)
    await tell.send("Hello", screen: TellScreen())
    #expect(tell.answer == .error(what: "The agent did not answer."))
    life.asked = { _ in #"{"kind":"hologram"}"# }
    await tell.send("Again", screen: TellScreen())
    #expect(tell.answer == .unknown)
}

@MainActor @Test func keepingWarmAsksNothingAndShowsNothing() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.unreachable }
    let tell = TellLife(api: life)
    await tell.keepWarm()
    #expect(tell.stage == .ready && tell.answer == nil && tell.waiting == nil)
    #expect(life.askedKeys.withLock { $0.count } == 1)
}
