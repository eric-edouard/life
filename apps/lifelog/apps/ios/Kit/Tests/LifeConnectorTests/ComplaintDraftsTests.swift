import Foundation
import Library
import Testing

@testable import LifeConnector

/// A voice card of Life's as the inbox fixture has it, and the same card after Life sealed it again.
private func voiceCards() throws -> (first: Check, resealed: Check) {
    var inbox = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    let read = { (inbox: [String: Any]) throws -> Check in
        let text = String(decoding: try JSONSerialization.data(withJSONObject: inbox), as: UTF8.self)
        let checks = try LibraryStore.feedDecoder.decode(Inbox.self, from: Data(text.utf8)).checks
        return try #require(checks.first { $0.group == .voice })
    }
    let first = try read(inbox)
    var checks = try #require(inbox["checks"] as? [[String: Any]])
    let at = try #require(checks.firstIndex { $0["ref"] as? String == first.ref })
    checks[at]["misread"] = ["cause": "c2", "shown": "s2", "seal": "seal-2"]
    inbox["checks"] = checks
    return (first, try read(inbox))
}

/// A press that failed, then a read that sealed the card again (or a read that failed, or dropped the card): Try again
/// resends the first press, its words, tick, seal, Life and key alike; once Life's receipt came for it, the next sheet
/// opens at rest on the card as it is now.
@Test @MainActor func tryAgainResendsTheFirstPressAndTheNextSheetOpensAtRest() throws {
    let (card, resealed) = try voiceCards()
    let (life, other) = (
        PairedLife(origin: testURL("https://a.example.test"), generation: 0),
        PairedLife(origin: testURL("https://b.example.test"), generation: 0)
    )
    let drafts = ComplaintDrafts()
    var taps = AnswerTaps()
    #expect(drafts.open(card))
    drafts[card.ref]?.words = " Not her. "
    drafts[card.ref]?.report = true
    let first = try #require(drafts.press(card.ref, to: life))
    let key = taps.key(for: first.request)
    taps.ended(first.request, as: .failed(ActionFailure(.refused("not received")), steps: []))
    // The read after it sealed the card again; the sheet opens on it again.
    #expect(!drafts.open(resealed))
    #expect(drafts[card.ref]?.check == card)
    #expect(drafts[card.ref]?.words == " Not her. " && drafts[card.ref]?.report == true)
    let again = try #require(drafts.press(card.ref, to: other))
    #expect(again == first)
    #expect(again.request.value == first.request.value)
    #expect(taps.key(for: again.request) == key)
    // A receipt for another press changes nothing; for this one, the next sheet starts over.
    drafts.received("ask_0", for: ComplaintDrafts.Press(request: first.request, life: other))
    #expect(drafts[card.ref]?.receipt == nil)
    drafts.received("ask_1", for: again)
    #expect(drafts.press(card.ref, to: life) == nil)
    #expect(drafts.open(resealed))
    #expect(drafts[card.ref]?.words == "" && drafts[card.ref]?.check == resealed)
    // Other words are a new press.
    drafts[card.ref]?.words = "Someone else."
    #expect(drafts.press(card.ref, to: life)?.request.note == "Someone else.")
    drafts.clear()
    #expect(drafts[card.ref] == nil)
}

/// A sheet closed untouched leaves nothing: the next opens on the card as it is then. One he wrote in, or sent, is kept.
@Test @MainActor func aSheetClosedUntouchedLeavesNoDraft() throws {
    let (card, resealed) = try voiceCards()
    let drafts = ComplaintDrafts()
    drafts.open(card)
    drafts[card.ref]?.report = true
    drafts.close(card.ref)
    #expect(drafts[card.ref] == nil)
    #expect(drafts.open(resealed))
    #expect(drafts[card.ref]?.check == resealed)
    drafts[card.ref]?.words = "Not her."
    drafts.close(card.ref)
    #expect(drafts[card.ref]?.words == "Not her.")
    _ = drafts.press(card.ref, to: PairedLife(origin: testURL("https://a.example.test"), generation: 0))
    drafts[card.ref]?.words = " "
    drafts.close(card.ref)
    #expect(drafts[card.ref]?.sent != nil)
}
