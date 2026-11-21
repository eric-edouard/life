import Foundation
import Library
import Testing

@testable import LifeConnector

private func need(_ json: String) throws -> Check.Need {
    try JSONDecoder().decode(Check.Need.self, from: Data(json.utf8))
}

@Test func anAccountDrawsItsBankNumberAndHolderAndCopiesTheDigitsOnly() throws {
    let rows = try need(
        #"{"kind":"account","line":"Bank 012-3-45678-9, Reef Co.","bank":"Bank","number":"012-3-45678-9","holder":"Reef Co."}"#
    ).rows
    #expect(rows.map(\.text) == ["Bank", "012-3-45678-9", "Reef Co."])
    #expect(rows[0].action == nil)
    #expect(rows[2].action == nil)
    #expect(rows[1].action == .copy("0123456789", label: "Copy the account number"))
    #expect(rows[1].isFigure)
}

@Test func anIBANKeepsItsLettersWhenCopied() throws {
    let rows = try need(#"{"kind":"account","line":"FR76 3000 6000 0112","number":"FR76 3000 6000 0112"}"#).rows
    #expect(rows[0].action == .copy("FR76300060000112", label: "Copy the account number"))
}

@Test func aLinkToAnotherAppIsItsLineAlone() throws {
    let rows = try need(#"{"kind":"link","line":"Open the shop","url":"shopapp://pay.example.test/1"}"#).rows
    #expect(rows == [NeedRow(glyph: .note, text: "Open the shop")])
}

@Test func anAmountShowsLifesWordsAndCopiesThePlainNumber() throws {
    let whole = try need(#"{"kind":"amount","line":"4,500 THB","value":4500,"currency":"THB"}"#).rows
    #expect(whole.map(\.text) == ["4,500 THB"])
    #expect(whole[0].action == .copy("4500", label: "Copy the amount"))
    let cents = try need(#"{"kind":"amount","line":"39.90 €","value":39.9,"currency":"EUR"}"#).rows
    #expect(cents[0].action == .copy("39.90", label: "Copy the amount"))
}

@Test func aLinkShowsItsFullHostAndOpensOnlyByATap() throws {
    let rows = try need(
        #"{"kind":"link","line":"Pay on Fibrenet","vendor":"Fibrenet","url":"https://billing.fibrenet.example.test/pay/1"}"#
    ).rows
    #expect(rows.map(\.text) == ["Fibrenet"])
    #expect(rows[0].detail == "billing.fibrenet.example.test")
    #expect(
        rows[0].action
            == .open(
                URL(string: "https://billing.fibrenet.example.test/pay/1")!, label: "Open billing.fibrenet.example.test"
            ))
}

@Test func aTextCopiesOnlyWhenAsked() throws {
    let copied = try need(#"{"kind":"text","line":"Reference: R-7","label":"Reference","text":"R-7","copy":true}"#).rows
    #expect(copied.map(\.text) == ["Reference: R-7"])
    #expect(copied[0].action == .copy("R-7", label: "Copy Reference"))
    #expect(try need(#"{"kind":"text","line":"Bring the receipt","text":"Bring the receipt"}"#).rows[0].action == nil)
}

@Test func aKindThisBuildDoesNotKnowIsItsLineAlone() throws {
    let rows = try need(#"{"kind":"cash","line":"Hand over 500 THB","notes":[500]}"#).rows
    #expect(rows == [NeedRow(glyph: .note, text: "Hand over 500 THB")])
}

@Test func aFieldInAShapeThisBuildDoesNotKnowFallsBackToTheLine() throws {
    let rows = try need(#"{"kind":"amount","line":"4,500 THB","value":"lots"}"#).rows
    #expect(rows == [NeedRow(glyph: .note, text: "4,500 THB")])
}

@Test func lifesDoneSeenOnACardDecodesAndAnUnknownStateIsTolerated() throws {
    let card =
        #"{"ref":"dec_1","group":"decision","title":"t","question":"q","asker":"a","options":[],"clips":[],"likelyPeople":[],"links":[],"doneSeen":{"state":"not_found","line":"Not in your accounts yet"}}"#
    let check = try JSONDecoder().decode(Check.self, from: Data(card.utf8))
    #expect(check.doneSeen == Check.DoneSeen(state: .notFound, line: "Not in your accounts yet"))
    let later = card.replacingOccurrences(of: "not_found", with: "refunded")
    #expect(try JSONDecoder().decode(Check.self, from: Data(later.utf8)).doneSeen?.state == .unknown)
}

@Test func anUnknownTakesStillLetsHimAnswerInWordsOnAnAgentsCard() throws {
    let card =
        #"{"ref":"dec_1","group":"decision","title":"t","question":"q","asker":"a","options":[{"id":"slip","label":"Send the slip","takes":"file"}],"clips":[],"likelyPeople":[],"links":[]}"#
    let check = try JSONDecoder().decode(Check.self, from: Data(card.utf8))
    #expect(check.options[0].takes == .unknown)
    #expect(check.answer(check.options[0]) == nil)
    #expect(check.takesOwnWords)
}

@Test func hisWordThatAStepIsDoneIsHeldAndNeverANotificationButton() throws {
    let card =
        #"{"ref":"dec_1","group":"decision","title":"t","question":"Is it done?","asker":"a","options":[{"id":"done","label":"It’s done","ends":"step"},{"id":"later","label":"Later"}],"clips":[],"likelyPeople":[],"links":[]}"#
    let check = try JSONDecoder().decode(Check.self, from: Data(card.utf8))
    #expect(check.options[0].ends == .step)
    #expect(check.isEnding(AnswerRequest(ref: "dec_1", options: ["done"])))
    #expect(!check.isEnding(AnswerRequest(ref: "dec_1", options: ["done"], note: "and paid")))
    #expect(!check.isEnding(AnswerRequest(ref: "dec_1", options: ["later"])))
    let ids = CardNotification.actions(check).map(\.identifier)
    #expect(ids.contains("option:later") && !ids.contains("option:done"))
    #expect(CardNotification.answer("option:done", typed: nil, to: check, in: "", asksFaceID: false) == nil)
    #expect(CardNotification.answer("option:later", typed: nil, to: check, in: "", asksFaceID: false) != nil)
}

@Test func aPlaceShowsItsNameThenEachHttpsLinkByATap() throws {
    let rows = try need(
        #"{"kind":"place","line":"Paint shop","name":"Paint shop","googleMapsUrl":"https://maps.example.test/g","boltUrl":"http://ride.example.test/r"}"#
    ).rows
    #expect(rows.map(\.text) == ["Paint shop", "Google Maps"])
    #expect(rows[1].action == .open(URL(string: "https://maps.example.test/g")!, label: "Open in Google Maps"))
}

@Test func notNowSaysTheDayTheCardComesBack() throws {
    let result = try JSONDecoder().decode(
        AnswerResult.self,
        from: Data(
            #"{"ref":"move:m/s","kind":"your move","changed":{"answer":"not-now","matter":"m","step":"s","until":"2026-11-24"}}"#
                .utf8))
    #expect(result.changed?.until == "2026-11-24")
    #expect(result.changed?.backOn?.isEmpty == false)
}
