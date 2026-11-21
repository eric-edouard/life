import Foundation
import Testing

@testable import LifeConnector

/// A made-up EMV code asking `amount` (tag 54) in `currency` (tag 53), its merchant account PromptPay's unless `aid`
/// says another; its CRC left out: the phone never checks it.
private func promptPay(_ amount: String, currency: String = "764", aid: String = "A000000677010111") -> String {
    "000201010212" + "2937" + "0016\(aid)" + "0113" + "0066812345678" + "5303\(currency)"
        + "54\(String(format: "%02d", amount.count))\(amount)" + "5802TH"
}

private func card(_ needs: String) throws -> Check {
    let json =
        #"{"ref":"dec_1","group":"decision","title":"t","question":"q","asker":"a","options":[],"clips":[],"likelyPeople":[],"links":[],"doneSeenBy":"payment","needs":"#
        + needs + "}"
    return try JSONDecoder().decode(Check.self, from: Data(json.utf8))
}

private let account =
    #"{"kind":"account","line":"Bank 012-3-45678-9, Reef Co.","bank":"Bank","number":"012-3-45678-9","holder":"Reef Co.","scheme":"th_account"}"#
private let amount = #"{"kind":"amount","line":"4,500 THB","value":4500,"currency":"THB"}"#
private let reference = #"{"kind":"text","line":"Reference: R-7","label":"Reference","text":"R-7","copy":true}"#
private func qr(_ payload: String?) -> String {
    #"{"kind":"qr","line":"QR code from their WhatsApp of Tue","source":"their WhatsApp of Tue""#
        + (payload.map { #","payload":""# + $0 + #"""# } ?? "") + "}"
}

@Test func aCodeWithItsTextIsTheHeroWithTheAmountAndTheNameTheBankShows() throws {
    let check = try card("[\(account),\(amount),\(qr(promptPay("4500.00"))),\(reference)]")
    #expect(
        check.payCode
            == PayCode(
                payload: promptPay("4500.00"), source: "their WhatsApp of Tue", amount: "4,500 THB",
                invoiceAmount: nil, payee: "Reef Co."))
    // The hero shows the account, the amount and the code: what is left is the reference.
    #expect(check.shownNeedRows.map(\.text) == ["Reference: R-7"])
    #expect(check.doneSeenBy == .payment)
}

@Test func aCodeAskingAnotherAmountShowsItsOwnAndTheInvoices() throws {
    let check = try card("[\(account),\(amount),\(qr(promptPay("4800.50")))]")
    #expect(check.payCode?.amount == "4,800.50 THB")
    #expect(check.payCode?.invoiceAmount == "4,500 THB")
    // Life looks for the card's amount, never the code's: it does not say it looks.
    #expect(!check.isPaymentLookedFor)
    #expect(try card("[\(account),\(amount),\(qr(promptPay("4500.00")))]").isPaymentLookedFor)
}

@Test func aCodeInBahtBesideAnInvoiceInEurosShowsBoth() throws {
    let euros = #"{"kind":"amount","line":"120 €","value":4500,"currency":"EUR"}"#
    let check = try card("[\(account),\(euros),\(qr(promptPay("4500.00")))]")
    #expect(check.payCode?.amount == "4,500 THB")
    #expect(check.payCode?.invoiceAmount == "120 €")
    #expect(!check.isPaymentLookedFor)
}

@Test func aCodeWithNoInvoiceShowsItsOwnAmountAndLifeLooksForNothing() throws {
    let check = try card("[\(account),\(qr(promptPay("4500.00")))]")
    #expect(check.payCode?.amount == "4,500 THB")
    #expect(check.payCode?.invoiceAmount == nil)
    #expect(!check.isPaymentLookedFor)
}

@Test func aCodeThatIsNotPromptPaysShowsTheCardsAmountOnly() throws {
    let other = promptPay("4800.00", aid: "A000000999010111")
    let check = try card("[\(account),\(amount),\(qr(other))]")
    #expect(check.payCode?.amount == "4,500 THB")
    #expect(check.payCode?.invoiceAmount == nil)
}

@Test func aMalformedCodeIsDrawnWithTheCardsAmountAndNeverStopsTheCard() throws {
    // A negative length, a partial field, a length past the end, a non-finite or empty amount, a currency of another.
    let malformed = [
        "00-1x", "000201" + "29", "0002010120ab", promptPay("nan"), promptPay("inf"), promptPay(""), promptPay("1e3"),
        promptPay("-4500"), promptPay("0.001"), promptPay("4500.005"), promptPay("4500.00", currency: "702"),
        promptPay("4500.00", aid: "A000000677010199"), "",
    ]
    for payload in malformed {
        #expect(Check.promptPayBaht(payload) == nil, "\(payload)")
        let check = try card("[\(account),\(amount),\(qr(payload.isEmpty ? "x" : payload))]")
        #expect(check.payCode?.amount == "4,500 THB")
        #expect(check.shownNeedRows.isEmpty)
    }
    #expect(Check.promptPayBaht(promptPay("4500.00")) == 4500)
    #expect(Check.emvFields("0002") == nil)
    #expect(Check.emvFields("0103ab") == nil)
    #expect(Check.emvFields("01020x") == ["01": "0x"])
}

@Test func aCodeIsLifesAmountOnlyWithinHalfACentAsTheWatcherSeesIt() throws {
    let cents = #"{"kind":"amount","line":"4,500.01 THB","value":4500.01,"currency":"THB"}"#
    #expect(try card("[\(account),\(cents),\(qr(promptPay("4500.01")))]").isPaymentLookedFor)
    #expect(try !card("[\(account),\(cents),\(qr(promptPay("4500.00")))]").isPaymentLookedFor)
    // A bill payment's code (tag 30) is PromptPay's too.
    let bill = promptPay("4500.00").replacingOccurrences(
        of: "2937" + "0016A000000677010111", with: "3037" + "0016A000000677010112")
    #expect(Check.promptPayBaht(bill) == 4500)
}

@Test func twoIdenticalCodesKeepTheSecondAsItsLine() throws {
    let code = qr(promptPay("4500.00"))
    let check = try card("[\(account),\(amount),\(code),\(code)]")
    #expect(check.shownNeedRows == [NeedRow(glyph: .note, text: "QR code from their WhatsApp of Tue")])
}

@Test func aSecondCodeIsStillShownAsItsLine() throws {
    let check = try card("[\(account),\(amount),\(qr(promptPay("4500.00"))),\(qr(nil))]")
    #expect(check.shownNeedRows == [NeedRow(glyph: .note, text: "QR code from their WhatsApp of Tue")])
}

@Test func aCodeWithoutItsTextIsItsLineAmongTheRows() throws {
    let check = try card("[\(account),\(amount),\(qr(nil))]")
    #expect(check.payCode == nil)
    #expect(check.shownNeedRows.last == NeedRow(glyph: .note, text: "QR code from their WhatsApp of Tue"))
}

@Test func theBankAppIsChosenByTheAccountsScheme() throws {
    #expect(try card("[\(account)]").transfers == .thai)
    let iban = account.replacingOccurrences(of: "th_account", with: "iban")
    #expect(try card("[\(iban)]").transfers == .iban)
    let other = account.replacingOccurrences(of: "th_account", with: "other")
    #expect(try card("[\(other)]").transfers == nil)
    #expect(try card("[\(amount)]").transfers == nil)
    #expect(Transfers.thai.usual == .kplus && Transfers.iban.usual == .revolut)
}

/// One card's trip, as the card's state holds it, and what the trip asked of Photos and the bank app.
@MainActor private final class Trip {
    var state = BankTrip()
    var saves = 0
    var opens = 0
    var opensSucceed = true
    var saveGate: CheckedContinuation<Void, Never>?

    func press() async {
        await BankTrip.press(
            get: { self.state }, set: { self.state = $0 },
            save: {
                self.saves += 1
                // Only the first save waits, so a second one fails the test rather than hanging it.
                if self.saves == 1 { await withCheckedContinuation { self.saveGate = $0 } }
                return nil
            },
            open: {
                self.opens += 1
                return self.opensSucceed
            }, appName: "K PLUS")
    }
}

@MainActor @Test func aSecondPressWhileTheSaveIsUnderWayDoesNothing() async {
    let trip = Trip()
    let first = Task { await trip.press() }
    while trip.saveGate == nil { await Task.yield() }
    #expect(trip.state.isUnderWay)
    await trip.press()
    #expect(trip.saves == 1 && trip.opens == 0)
    trip.saveGate?.resume()
    await first.value
    #expect(trip.saves == 1 && trip.opens == 1)
    #expect(trip.state.isCodeSaved && trip.state.hasOpenedApp && !trip.state.isUnderWay)
}

@MainActor @Test func afterAFailedOpenOnlyTheOpenIsTriedAgain() async {
    let trip = Trip()
    trip.opensSucceed = false
    let first = Task { await trip.press() }
    while trip.saveGate == nil { await Task.yield() }
    trip.saveGate?.resume()
    await first.value
    #expect(trip.state.problem == "K PLUS did not open. Is it on this phone?")
    #expect(trip.state.isCodeSaved && !trip.state.hasOpenedApp)
    trip.opensSucceed = true
    await trip.press()
    #expect(trip.saves == 1 && trip.opens == 2)
    #expect(trip.state.hasOpenedApp && trip.state.problem == nil)
}

@MainActor @Test func aSaveThatDidNotGoOpensNothingAndSaysWhy() async {
    let trip = Trip()
    await BankTrip.press(
        get: { trip.state }, set: { trip.state = $0 }, save: { "Not saved to your photos." },
        open: {
            trip.opens += 1
            return true
        }, appName: "K PLUS")
    #expect(trip.opens == 0 && !trip.state.isCodeSaved && trip.state.problem == "Not saved to your photos.")
}
