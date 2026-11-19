import Foundation
import Testing

@testable import LifeConnector

/// A `read_inbox` reply holding `checks`, as JSON.
private func inbox(_ checks: [String]) -> String {
    #"{"checks":[\#(checks.joined(separator: ","))],"counts":{},"total":\#(checks.count),"deadlinesToday":0}"#
}

private func check(
    pushId: String, title: String = "Book the movers for Saturday", question: String = "Book them?",
    asker: String = "codex", extra: String = ""
) -> String {
    #"{"ref":"dec_\#(pushId)","pushId":"\#(pushId)","group":"decision","title":"\#(title)","question":"\#(question)","asker":"\#(asker)","options":[],"clips":[],"likelyPeople":[],"links":[]\#(extra)}"#
}

@Test func theCardItsPushNamesBecomesItsNotificationInLifesOwnWords() throws {
    let other = check(pushId: "aaaaaaaaaaaaaaaa", title: "Another card")
    let mine = check(pushId: "0123456789abcdef", extra: #","matter":{"id":"m_move","name":"Flat move"}"#)
    let note = try #require(CardNotification.of(pushId: "0123456789abcdef", inbox: inbox([other, mine])))
    #expect(note.title == "Book the movers for Saturday")
    #expect(note.subtitle == "codex · Flat move")
    #expect(note.body == "Book them?")
    #expect(note.thread == "m_move")
    // The card itself rides along, to be read again for its answer.
    #expect(note.card.contains(#""ref":"dec_0123456789abcdef""#))
}

@Test func aDraftShowsWhoItGoesToAndItsWords() throws {
    let draft = #","draft":{"to":"Maya","text":"Thursday works, 8 pm at Lupa?"}"#
    let note = try #require(
        CardNotification.of(pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", extra: draft)]))
    )
    #expect(note.body == #"To Maya: "Thursday works, 8 pm at Lupa?""#)
}

@Test func lifesOwnCheckWithNoMatterIsLifesInLifesThread() throws {
    let note = try #require(
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", asker: "life")])))
    #expect(note.subtitle == "Life")
    #expect(note.thread == "life-cards")
}

@Test func aCardNoLongerOpenOrAnUnreadableReplyGivesNone() {
    #expect(CardNotification.of(pushId: "0123456789abcdef", inbox: inbox([check(pushId: "aaaaaaaaaaaaaaaa")])) == nil)
    #expect(CardNotification.of(pushId: "0123456789abcdef", inbox: "Life is offline") == nil)
}

@Test func longWordsAreCutAtAWordOnOneLine() {
    #expect(CardNotification.clipped("Short", to: 40) == "Short")
    #expect(CardNotification.clipped("Line one\nline two", to: 40) == "Line one line two")
    let cut = CardNotification.clipped("Book the movers for Saturday morning before nine", to: 40)
    #expect(cut == "Book the movers for Saturday morning…")
    #expect(cut.count <= 40)
    #expect(CardNotification.clipped(String(repeating: "a", count: 50), to: 40).count == 40)
}
