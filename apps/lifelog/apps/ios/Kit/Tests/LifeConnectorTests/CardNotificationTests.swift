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
    let note = try #require(
        CardNotification.of(pushId: "0123456789abcdef", inbox: inbox([other, mine]), asksFaceID: false))
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
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", extra: draft)]),
            asksFaceID: false)
    )
    #expect(note.body == #"To Maya: "Thursday works, 8 pm at Lupa?""#)
    let file = #","draft":{"to":"Maya","file":{"name":"quote.pdf","size":2048}}"#
    let sent = try #require(
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", extra: file)]),
            asksFaceID: false))
    #expect(sent.body == "To Maya\nFile quote.pdf (2 kB)")
}

@Test func lifesOwnCheckWithNoMatterIsLifesInLifesThread() throws {
    let note = try #require(
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", asker: "life")]),
            asksFaceID: false))
    #expect(note.subtitle == "Life")
    #expect(note.thread == "life-cards")
}

@Test func aCardNoLongerOpenOrAnUnreadableReplyGivesNone() {
    #expect(
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "aaaaaaaaaaaaaaaa")]), asksFaceID: false) == nil)
    #expect(CardNotification.of(pushId: "0123456789abcdef", inbox: "Life is offline", asksFaceID: false) == nil)
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
        CardNotification.answer("option:later", typed: nil, to: check, in: CardNotification.category, asksFaceID: false)
            == AnswerRequest(ref: check.ref, options: ["later"]))
    // Send is offered only under a draft; one that takes a person opens the card.
    #expect(
        CardNotification.answer("option:send", typed: nil, to: check, in: CardNotification.category, asksFaceID: false)
            == nil)
    #expect(
        CardNotification.answer("option:who", typed: nil, to: check, in: CardNotification.category, asksFaceID: false)
            == nil)
    #expect(
        CardNotification.answer("option:gone", typed: nil, to: check, in: CardNotification.category, asksFaceID: false)
            == nil)
}

@Test func aReplyIsADecisionsOwnWords() throws {
    let decision = try #require(CardNotification.card(in: ["card": check(pushId: "0123456789abcdef")]))
    #expect(
        CardNotification.answer(
            CardNotification.reply, typed: "After Friday", to: decision, in: CardNotification.category,
            asksFaceID: false)
            == AnswerRequest(ref: decision.ref, options: [], note: "After Friday"))
    #expect(
        CardNotification.answer(
            CardNotification.reply, typed: nil, to: decision, in: CardNotification.category, asksFaceID: false) == nil)
    #expect(
        CardNotification.answer(
            CardNotification.reply, typed: "  ", to: decision, in: CardNotification.category, asksFaceID: false) == nil)
    let voice = check(pushId: "0123456789abcdef").replacingOccurrences(
        of: #""group":"decision""#, with: #""group":"voice""#)
    let named = try #require(CardNotification.card(in: ["card": voice]))
    #expect(
        CardNotification.answer(
            CardNotification.reply, typed: "Maya", to: named, in: CardNotification.category, asksFaceID: false) == nil)
    // The Watch shows Reply… on every card; on a new matter it would edit the goal, so it gives nothing there.
    let matter = check(pushId: "0123456789abcdef").replacingOccurrences(
        of: #""group":"decision""#, with: #""group":"new matter""#)
    let newMatter = try #require(CardNotification.card(in: ["card": matter]))
    #expect(
        CardNotification.answer(
            CardNotification.reply, typed: "Finish by May", to: newMatter, in: CardNotification.category,
            asksFaceID: false) == nil)
    #expect(CardNotification.card(in: [:]) == nil)
}

private let drafted = check(pushId: "0123456789abcdef", extra: #","draft":{"to":"Maya","text":"Thursday works"}"#)
    .replacingOccurrences(of: #""options":[]"#, with: options)

@Test func aDraftsCardOffersSendUnderItsDraftUnlessItAsksWhoItGoesTo() throws {
    let card = try #require(CardNotification.card(in: ["card": drafted]))
    #expect(CardNotification.buttons(card).map(\.label) == ["Send", "Not yet"])
    #expect(
        CardNotification.answer(
            CardNotification.send, typed: nil, to: card, in: CardNotification.category, asksFaceID: false)
            == AnswerRequest(ref: card.ref, options: ["send"]))
    // An outward option is never answered by its own id: only Send names it.
    #expect(
        CardNotification.answer("option:send", typed: nil, to: card, in: CardNotification.category, asksFaceID: false)
            == nil)
    let asking = drafted.replacingOccurrences(
        of: #""draft":"#, with: #""confirm":[\#(check(pushId: "fedcba9876543210"))],"draft":"#)
    let unsure = try #require(CardNotification.card(in: ["card": asking]))
    #expect(CardNotification.buttons(unsure).map(\.label) == ["Not yet"])
    #expect(
        CardNotification.answer(
            CardNotification.send, typed: nil, to: unsure, in: CardNotification.category, asksFaceID: false) == nil)
}

@Test func aDraftCardsNotificationShowsTheWholeDraftAndSendsFromTheWatchUnlessFaceIDIsAsked() throws {
    let long = String(repeating: "Thursday works for me. ", count: 10)
    let text = drafted.replacingOccurrences(of: "Thursday works", with: long)
    let read = inbox([text])
    let note = try #require(CardNotification.of(pushId: "0123456789abcdef", inbox: read, asksFaceID: false))
    #expect(note.body == "To Maya: \"\(long)\"")
    #expect(note.category == CardNotification.sendCategory)
    let asked = try #require(CardNotification.of(pushId: "0123456789abcdef", inbox: read, asksFaceID: true))
    #expect(asked.category == CardNotification.category)
    let plain = try #require(
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef")]), asksFaceID: false))
    #expect(plain.category == CardNotification.category)
}

@Test func sendGoesOnOnlyOnceItsProofSaysSoAndOtherAnswersNeverAsk() async {
    #expect(await !CardNotification.isAnswerAllowed(CardNotification.send) { false })
    #expect(await CardNotification.isAnswerAllowed(CardNotification.send) { true })
    #expect(
        await CardNotification.isAnswerAllowed("option:later") {
            Issue.record("asked Face ID"); return false
        })
}

@Test func aDraftsNotificationTextHoldsEveryPartThatGoes() throws {
    let parts =
        #","draft":{"to":"Maya","channel":"whatsapp","text":"Here it is","file":{"name":"quote.pdf","size":2048},"#
        + #""quoted":{"sender":"Maya","text":"Can you send the quote?"}}"#
    let note = try #require(
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", extra: parts)]),
            asksFaceID: false))
    #expect(
        note.body == """
            To Maya on WhatsApp: "Here it is"
            File quote.pdf (2 kB)
            Reply to Maya: "Can you send the quote?"
            """)
    let mail =
        #","draft":{"to":"sam@example.test","channel":"gmail","text":"Signed.","from":"me@example.test","#
        + #""cc":"lee@example.test","subject":"Lease"}"#
    let mailed = try #require(
        CardNotification.of(
            pushId: "0123456789abcdef", inbox: inbox([check(pushId: "0123456789abcdef", extra: mail)]),
            asksFaceID: false))
    #expect(
        mailed.body == """
            To sam@example.test on Mail: "Signed."
            From me@example.test
            Cc lee@example.test
            Subject Lease
            """)
}

@Test func aSendFromANotificationDeliveredBeforeFaceIDWasAskedIsRefused() throws {
    let card = try #require(CardNotification.card(in: ["card": drafted]))
    #expect(
        CardNotification.answer(
            CardNotification.send, typed: nil, to: card, in: CardNotification.sendCategory, asksFaceID: true) == nil)
    // Delivered after: its category is the plain one, and the phone asked Face ID before forwarding it.
    #expect(
        CardNotification.answer(
            CardNotification.send, typed: nil, to: card, in: CardNotification.category, asksFaceID: true)
            == AnswerRequest(ref: card.ref, options: ["send"]))
}

/// The extension keeps with a card the origin of the read that found it: the read goes to the Life paired when the push
/// came, or nowhere, so a pairing changed meanwhile gives no card rather than another Life's under this one's name.
@Test func theExtensionStampsTheOriginItsReadWentTo() async throws {
    let (a, b) = (newHost(), newHost())
    let wire = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    let first = try #require((wire["checks"] as? [[String: Any]])?.first)
    let body = wire.merging(["checks": [first.merging(["pushId": "push-1"]) { $1 }], "total": 1]) { $1 }
    let inbox = String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
    let store = MemoryStore(credentials(host: a))
    _ = Stub.session(host: b) { _ in .json(resultMessage(inbox)) }
    let session = Stub.session(host: a) { _ in .json(resultMessage(inbox)) }
    let life = LifeSession(store: store, oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    let api = MCPLifeAPI(client: MCPClient(session: life, urlSession: session))
    let origin = testURL("https://\(a)")
    let read = await CardNotification.read(pushId: "push-1", pairedWith: origin, asksFaceID: false) {
        try await api.readInbox(pushId: "push-1", at: $0)
    }
    #expect(read?.life == origin && read?.card.title.isEmpty == false)
    // Paired with B between the push and its read: the read refuses rather than reading B under A's name.
    store.save(credentials(host: b, access: "access-b"))
    let crossed = await CardNotification.read(pushId: "push-1", pairedWith: origin, asksFaceID: false) {
        try await api.readInbox(pushId: "push-1", at: $0)
    }
    #expect(crossed == nil && !Stub.requested(b))
}
