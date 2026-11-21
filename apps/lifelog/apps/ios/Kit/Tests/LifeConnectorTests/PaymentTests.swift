import Foundation
import Testing

@testable import LifeConnector

/// A made-up PromptPay code asking `amount` (tag 54), its CRC left out: the phone never checks it.
private func promptPay(_ amount: String) -> String {
    "000201010212" + "2937" + "0016A000000677010111" + "0113" + "0066812345678" + "5303764"
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

@Test func aThaiCodeGivesItsAmountAndAnythingElseNone() {
    #expect(Check.emvBahtAmount(promptPay("4500.00")) == 4500)
    #expect(Check.emvBahtAmount("000201010211" + "5303764" + "5802TH") == nil)
    // Singapore dollars (702): not read.
    #expect(Check.emvBahtAmount("000201010212" + "5303702" + "540510.00") == nil)
    #expect(Check.emvBahtAmount("BCD\n002\n1\nSCT\n") == nil)
    #expect(Check.emvBahtAmount("5303764" + "5410123") == nil)
}
