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
    let tell = AskLife(api: life)
    await tell.send("  Does Friday work?  ", screen: MainSessionScreen(tab: "inbox"))
    #expect(tell.said == "Does Friday work?")
    #expect(tell.answer == .reply(words: "Friday works.", why: nil, sources: []))
    #expect(tell.stage == .ready)
    #expect(tell.strands == [AskLifeStrand(id: "a", title: "Reading the card", state: "completed")])
    // The last `working` line came after the words and started them again.
    #expect(tell.words == "")
}

@MainActor @Test func aCallThatDroppedWaitsAndGoesAgainUnderTheSameKey() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.streamDropped }
    let tell = AskLife(api: life)
    await tell.send("Hello", screen: MainSessionScreen())
    #expect(tell.stage == .offline)
    #expect(tell.waiting == "Hello")
    life.asked = { _ in #"{"kind":"reply","words":"Hi."}"# }
    await tell.sendAgain(screen: MainSessionScreen())
    let keys = life.askedKeys.withLock { $0 }
    #expect(keys.count == 2 && keys[0] == keys[1] && keys[0] != nil)
    #expect(tell.answer == .reply(words: "Hi.", why: nil, sources: []))
    #expect(tell.waiting == nil)
}

@MainActor @Test func anErrorKeepsHisWordsAndAnUnknownKindIsSaidAsSuch() async {
    let life = FakeLife()
    life.asked = { _ in #"{"kind":"error","what":"The agent did not answer."}"# }
    let tell = AskLife(api: life)
    await tell.send("Hello", screen: MainSessionScreen())
    #expect(tell.answer == .error(what: "The agent did not answer."))
    life.asked = { _ in #"{"kind":"hologram"}"# }
    await tell.send("Again", screen: MainSessionScreen())
    #expect(tell.answer == .unknown)
}

@MainActor @Test func keepingWarmAsksNothingAndShowsNothing() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.unreachable }
    let tell = AskLife(api: life)
    await tell.keepWarm()
    #expect(tell.stage == .ready && tell.answer == nil && tell.waiting == nil)
    #expect(life.askedKeys.withLock { $0.count } == 1)
}

@MainActor @Test func otherWordsAfterADropAreAnotherAsk() async {
    let life = FakeLife()
    life.asked = { _ in throw MCPError.timedOut }
    let tell = AskLife(api: life)
    await tell.send("A", screen: MainSessionScreen())
    life.asked = { _ in #"{"kind":"reply","words":"B."}"# }
    await tell.send("B", screen: MainSessionScreen())
    let keys = life.askedKeys.withLock { $0 }
    #expect(keys.count == 2 && keys[0] != keys[1])
    #expect(tell.answer == .reply(words: "B.", why: nil, sources: []))
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

/// Ask Life's `show`: a page or a tab's list cut to Life's rows rides on the answer; each answer that shows counts
/// once, so the same show asked twice applies twice; a shape this build doesn't know shows nothing.
@MainActor @Test func anAnswerThatShowsCarriesItsPageOrItsCutList() async {
    let life = FakeLife()
    let list = #"{"kind":"list","list":"matters","refs":["m2","m1"],"label":"Your 2 most important today"}"#
    life.asked = { _ in #"{"kind":"reply","words":"These two.","show":\#(list)}"# }
    let ask = AskLife(api: life)
    await ask.send("Show my 2 most important matters", screen: MainSessionScreen())
    let cut = ShownList(kind: .matters, refs: ["m2", "m1"], label: "Your 2 most important today")
    #expect(ask.shown == AskLifeShown(show: .list(cut), answer: 1))
    await ask.send("Again", screen: MainSessionScreen())
    #expect(ask.shown?.answer == 2)
    life.asked = { _ in
        #"{"kind":"done","matter":"m1","words":"Paid.","show":{"kind":"page","page":"matter","id":"m1"}}"#
    }
    await ask.send("I paid the lawyer", screen: MainSessionScreen())
    #expect(ask.shown?.show == .page(.matter, id: "m1"))
    #expect(ask.answer == .done(words: "Paid.", matter: "m1"))
    // An answer that shows nothing keeps the last show; a kind this build doesn't know is nothing.
    life.asked = { _ in #"{"kind":"reply","words":"Hm.","show":{"kind":"map","id":"x"}}"# }
    await ask.send("Where?", screen: MainSessionScreen())
    #expect(ask.shown?.answer == 3)
}

@Test func aCutListKeepsLifesRowsInItsOrderAndLeavesOutRowsGoneSince() {
    let cut = ShownList(kind: .matters, refs: ["c", "a", "gone"], label: "x")
    #expect(cut.cut(["a", "b", "c"], ref: { $0 }) == ["c", "a"])
}
