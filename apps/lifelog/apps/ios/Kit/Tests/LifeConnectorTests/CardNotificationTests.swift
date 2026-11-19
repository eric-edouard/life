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
    let file = #","draft":{"to":"Maya","file":{"name":"quote.pdf","size":2048}}"#
    let sent = try #require(
        CardNotification.of(pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", extra: file)])))
    #expect(sent.body == "To Maya: quote.pdf")
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

private let options =
    #""options":[{"id":"send","label":"Send","outgoing":true},{"id":"later","label":"Not yet"},{"id":"who","label":"Someone else…","takes":"person"}]"#

@Test func aCardWithoutADraftOffersOnlyItsOneTapAnswers() throws {
    let check = try #require(
        CardNotification.card(in: [
            "card": check(pushId: "0123456789abcdef").replacingOccurrences(of: #""options":[]"#, with: options)
        ]))
    #expect(CardNotification.buttons(check).map(\.label) == ["Not yet"])
    #expect(
        CardNotification.answer("option:later", typed: nil, to: check)
            == AnswerRequest(ref: check.ref, options: ["later"]))
    // Send is offered only under a draft; one that takes a person opens the card.
    #expect(CardNotification.answer("option:send", typed: nil, to: check) == nil)
    #expect(CardNotification.answer("option:who", typed: nil, to: check) == nil)
    #expect(CardNotification.answer("option:gone", typed: nil, to: check) == nil)
}

@Test func aReplyIsADecisionsOwnWords() throws {
    let decision = try #require(CardNotification.card(in: ["card": check(pushId: "0123456789abcdef")]))
    #expect(
        CardNotification.answer(CardNotification.reply, typed: "After Friday", to: decision)
            == AnswerRequest(ref: decision.ref, options: [], note: "After Friday"))
    #expect(CardNotification.answer(CardNotification.reply, typed: nil, to: decision) == nil)
    #expect(CardNotification.answer(CardNotification.reply, typed: "  ", to: decision) == nil)
    let voice = check(pushId: "0123456789abcdef").replacingOccurrences(
        of: #""group":"decision""#, with: #""group":"voice""#)
    let named = try #require(CardNotification.card(in: ["card": voice]))
    #expect(CardNotification.answer(CardNotification.reply, typed: "Maya", to: named) == nil)
    // The Watch shows Reply… on every card; on a new matter it would edit the goal, so it gives nothing there.
    let matter = check(pushId: "0123456789abcdef").replacingOccurrences(
        of: #""group":"decision""#, with: #""group":"new matter""#)
    let newMatter = try #require(CardNotification.card(in: ["card": matter]))
    #expect(CardNotification.answer(CardNotification.reply, typed: "Finish by May", to: newMatter) == nil)
    #expect(CardNotification.card(in: [:]) == nil)
}

private let drafted = check(pushId: "0123456789abcdef", extra: #","draft":{"to":"Maya","text":"Thursday works"}"#)
    .replacingOccurrences(of: #""options":[]"#, with: options)

@Test func aDraftsCardOffersSendUnderItsDraftUnlessItAsksWhoItGoesTo() throws {
    let card = try #require(CardNotification.card(in: ["card": drafted]))
    #expect(CardNotification.buttons(card).map(\.label) == ["Send", "Not yet"])
    #expect(
        CardNotification.answer("option:send", typed: nil, to: card)
            == AnswerRequest(ref: card.ref, options: ["send"]))
    let asking = drafted.replacingOccurrences(
        of: #""draft":"#, with: #""confirm":[\#(check(pushId: "fedcba9876543210"))],"draft":"#)
    let unsure = try #require(CardNotification.card(in: ["card": asking]))
    #expect(CardNotification.buttons(unsure).map(\.label) == ["Not yet"])
    #expect(CardNotification.answer("option:send", typed: nil, to: unsure) == nil)
}

@Test func sendGoesOnOnlyOnceFaceIDSaysSoAndOtherAnswersNeverAsk() async throws {
    let check = try #require(CardNotification.card(in: ["card": drafted]))
    #expect(await !CardNotification.isAnswerAllowed("option:send", of: check) { false })
    #expect(await CardNotification.isAnswerAllowed("option:send", of: check) { true })
    #expect(
        await CardNotification.isAnswerAllowed("option:later", of: check) {
            Issue.record("asked Face ID"); return false
        })
}
