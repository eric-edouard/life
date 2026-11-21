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

@Test func aYourMoveCardDrawsItsPlaceAndAnswersDoneHandOverOrNotNow() throws {
    let card = #"""
        {"ref":"move:matter_ab12cd34ef56/obs_0123456789ab","group":"your move","kind":"your move","urgency":"blocks",
        "title":"Motorbike papers","question":"Renew the motorbike tax at the vehicle office","asker":"life","at":null,
        "deadline":"2026-11-24T16:59:59.999Z","goal":"Motorbike papers in order","subject":"obs_0123456789ab",
        "context":"A step of yours is open on this matter.","matter":{"id":"matter_ab12cd34ef56","name":"Motorbike papers"},
        "onMatters":[{"id":"matter_ab12cd34ef56","name":"Motorbike papers"}],
        "ridesOn":{"matterIds":["matter_ab12cd34ef56"],"matters":1,"observations":0,"pages":0},
        "needs":[{"kind":"place","name":"Vehicle office","line":"Vehicle office",
        "googleMapsUrl":"https://www.google.com/maps/search/?api=1&query=Vehicle%20office",
        "appleMapsUrl":"https://maps.apple.com/?q=Vehicle%20office"}],
        "options":[{"id":"done","label":"Mark as done","ends":"step","takes":null},
        {"id":"start","label":"Hand to an agent","takes":null},{"id":"not-now","label":"Not now","takes":null}],
        "onSilence":null,"draft":null,"clips":[],"likelyPeople":[],"links":[],
        "misread":{"cause":"your move","shown":"s","seal":"x"}}
        """#
    let check = try LibraryStore.feedDecoder.decode(Check.self, from: Data(card.utf8))
    #expect(check.group == .yourMove && check.urgency == .blocks && check.misread != nil)
    #expect(check.contextLinkTitle == "Where it stands")

    let rows = check.shownNeedRows
    #expect(rows.map(\.text) == ["Vehicle office", "Google Maps", "Apple Maps"])
    #expect(rows[0] == NeedRow(glyph: .place, text: "Vehicle office"))
    #expect(rows[1].detail == "www.google.com")
    #expect(
        rows[2].action == .open(URL(string: "https://maps.apple.com/?q=Vehicle%20office")!, label: "Open Apple Maps"))

    // Mark as done is filled and his word that the step is done; Hand to an agent hands over the goal shown.
    #expect(check.filled?.id == "done" && check.options[0].ends == .step)
    let done = try #require(check.answer(check.options[0]))
    #expect(check.isEnding(done))
    #expect(check.answer(check.options[1]) == AnswerRequest(ref: check.ref, options: ["start"], note: check.goal))
    #expect(check.isHandOver(check.options[1]) && !check.isHandOver(check.options[2]))
    #expect(check.answer(check.options[2]) == AnswerRequest(ref: check.ref, options: ["not-now"]))
    #expect(!check.takesOwnWords)
}

@Test func aPlaceDrawsBoltOnlyWhenGivenAndNeverALinkThatIsNotHTTPS() throws {
    let rows = try need(
        #"{"kind":"place","name":"Clinic","address":"12 Soi 3","line":"Clinic, 12 Soi 3","googleMapsUrl":"http://maps.example.test/x","boltUrl":"https://bolt.example.test/ride?to=Clinic"}"#
    ).rows
    #expect(rows.map(\.text) == ["Clinic, 12 Soi 3", "Ride with Bolt"])
    #expect(rows[1].detail == "bolt.example.test")
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
