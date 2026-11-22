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
    let askLife = AskLife(api: life)
    await askLife.send("  Does Friday work?  ", screen: MainSessionScreen(tab: "inbox"))
    #expect(askLife.said == "Does Friday work?")
    #expect(askLife.answer == .reply(words: "Friday works.", why: nil, sources: []))
    #expect(askLife.stage == .ready)
    #expect(askLife.strands == [AskLifeStrand(id: "a", title: "Reading the card", state: "completed")])
    // The last `working` line came after the words and started them again.
    #expect(askLife.words == "")
}

@MainActor @Test func aCallThatDroppedWaitsAndGoesAgainUnderTheSameKey() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.streamDropped }
    let askLife = AskLife(api: life)
    await askLife.send("Hello", screen: MainSessionScreen())
    #expect(askLife.stage == .offline)
    #expect(askLife.waiting == "Hello")
    life.asked = { _ in #"{"kind":"reply","words":"Hi."}"# }
    await askLife.sendAgain(screen: MainSessionScreen())
    let keys = life.askedKeys.withLock { $0 }
    #expect(keys.count == 2 && keys[0] == keys[1] && keys[0] != nil)
    #expect(askLife.answer == .reply(words: "Hi.", why: nil, sources: []))
    #expect(askLife.waiting == nil)
}

@MainActor @Test func anErrorKeepsHisWordsAndAnUnknownKindIsSaidAsSuch() async {
    let life = FakeLife()
    life.asked = { _ in #"{"kind":"error","what":"The agent did not answer."}"# }
    let askLife = AskLife(api: life)
    await askLife.send("Hello", screen: MainSessionScreen())
    #expect(askLife.answer == .error(what: "The agent did not answer."))
    life.asked = { _ in #"{"kind":"hologram"}"# }
    await askLife.send("Again", screen: MainSessionScreen())
    #expect(askLife.answer == .unknown)
}

@MainActor @Test func keepingWarmAsksNothingAndShowsNothing() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.unreachable }
    let askLife = AskLife(api: life)
    await askLife.keepWarm()
    #expect(askLife.stage == .ready && askLife.answer == nil && askLife.waiting == nil)
    #expect(life.askedKeys.withLock { $0.count } == 1)
}

@MainActor @Test func otherWordsAfterADropAreAnotherAsk() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.timedOut }
    let askLife = AskLife(api: life)
    await askLife.send("A", screen: MainSessionScreen())
    life.asked = { _ in #"{"kind":"reply","words":"B."}"# }
    await askLife.send("B", screen: MainSessionScreen())
    let keys = life.askedKeys.withLock { $0 }
    #expect(keys.count == 2 && keys[0] != keys[1])
    #expect(askLife.answer == .reply(words: "B.", why: nil, sources: []))
}

@Test func everyKindOfAnswerIsReadFromItsFields() {
    #expect(
        AskLifeAnswer(#"{"kind":"reply","words":"**31 January**","why":"Since 2 October.","sources":["obs_1"]}"#)
            == .reply(words: "**31 January**", why: "Since 2 October.", sources: ["obs_1"]))
    #expect(
        AskLifeAnswer(#"{"kind":"question","question":"Which plan?","answers":["Kitchen","Flat"]}"#)
            == .question(question: "Which plan?", answers: ["Kitchen", "Flat"]))
    #expect(AskLifeAnswer(#"{"kind":"error","what":"No Mac."}"#) == .error(what: "No Mac."))
    #expect(
        AskLifeAnswer(#"{"kind":"done","matter":"mat_1","words":"**Done**."}"#)
            == .done(words: "**Done**.", matter: "mat_1"))
    #expect(
        AskLifeAnswer(#"{"kind":"agent","agent":"Personal","told":"Book it","words":"**On it**."}"#)
            == .agent(words: "**On it**.", agent: "Personal", told: "Book it"))
    #expect(
        AskLifeAnswer(#"{"kind":"card","card":"dec_1","words":"In your Inbox."}"#)
            == .card(words: "In your Inbox.", card: "dec_1"))
    #expect(AskLifeAnswer(#"{"kind":"card","words":"x"}"#) == .unknown)
    #expect(
        AskLifeAnswer(#"{"kind":"fix","ask":"entry_1","words":"The caretaker has it."}"#)
            == .fix(words: "The caretaker has it."))
    #expect(AskLifeAnswer(#"{"kind":"later"}"#) == .unknown)
}
