import Foundation

/// A payee's QR the phone draws (a `qr` need with its text): the card's hero, with what the bank app will show beside it.
public struct PayCode: Sendable, Equatable {
    /// The code's text, drawn as the code.
    public let payload: String
    /// Where the payee sent it, in Life's words.
    public let source: String
    /// What the code asks, else the card's amount ("4,800 THB"); nil when neither says.
    public let amount: String?
    /// The card's amount when the code asks another: his invoice's, to check before he pays.
    public let invoiceAmount: String?
    /// The name the bank app should show: the account's holder.
    public let payee: String?
}

/// The kinds of transfer a bank app takes, by the account's `scheme`.
public enum Transfers: String, CaseIterable, Sendable {
    case thai, iban

    /// Its group on Settings > Apps.
    public var title: String {
        switch self {
        case .thai: "Thai bank transfers open in"
        case .iban: "IBAN and SWIFT transfers open in"
        }
    }

    /// Where this phone keeps his pick (`@AppStorage`): which app opens is this phone's, never Life's.
    public var storageKey: String { "bankApp.\(rawValue)" }

    /// The app a transfer opens until he picks one.
    public var usual: BankApp {
        switch self {
        case .thai: .kplus
        case .iban: .revolut
        }
    }
}

/// The bank apps a transfer card opens, one table: Settings > Apps lists them, the card's filled answer opens his pick.
public enum BankApp: String, CaseIterable, Sendable {
    case kplus, scbEasy, revolut, wise

    public var name: String {
        switch self {
        case .kplus: "K PLUS"
        case .scbEasy: "SCB Easy"
        case .revolut: "Revolut"
        case .wise: "Wise"
        }
    }

    public var transfers: Transfers {
        switch self {
        case .kplus, .scbEasy: .thai
        case .revolut, .wise: .iban
        }
    }

    /// The app's own link to its home: no public link fills a transfer (only-you catalogue, 20 Nov).
    /// ponytail: the Thai banks publish no scheme; these are the ones in use, unverified on a device. A failed open says
    /// so on the card; verify on his phone, then add them to `LSApplicationQueriesSchemes` if a probe is ever needed.
    public var url: URL? {
        switch self {
        case .kplus: URL(string: "kbank.kplus://")
        case .scbEasy: URL(string: "scbeasy://")
        case .revolut: URL(string: "revolut://")
        case .wise: URL(string: "wise://")
        }
    }
}

extension Check {
    private var account: Need? { needs?.first { $0.kind == .account } }
    private var invoice: Need? { needs?.first { $0.kind == .amount && $0.value != nil } }
    /// The QR the card draws: the first with its text.
    private var drawnQR: Need? { needs?.first { $0.kind == .qr && $0.payload != nil && $0.source != nil } }

    /// Which bank app the card's filled answer opens, by its account's `scheme`; nil when it names none it knows.
    public var transfers: Transfers? {
        switch account?.scheme {
        case .thAccount?, .promptpay?: .thai
        case .iban?, .swift?: .iban
        default: nil
        }
    }

    /// The payee's QR, when Life sent its text: the card draws it, with the amount and the name around it.
    public var payCode: PayCode? {
        guard let qr = drawnQR, let payload = qr.payload, let source = qr.source else { return nil }
        var amount = invoice?.line
        // Only a Thai code's amount is read (PromptPay: tag 53 is 764, baht), against a card's amount in baht.
        if let invoice, invoice.currency == "THB", let asked = Self.emvBahtAmount(payload), asked != invoice.value {
            amount = Self.amountWords(asked, currency: "THB")
        }
        return PayCode(
            payload: payload, source: source, amount: amount,
            invoiceAmount: amount == invoice?.line ? nil : invoice?.line, payee: account?.holder)
    }

    /// The rows under the question: every need's, less the QR, the account and the amount its hero shows (`payCode`).
    public var shownNeedRows: [NeedRow] {
        let shown = payCode == nil ? [] : [drawnQR, account, invoice].compactMap { $0 }
        return (needs ?? []).filter { need in !shown.contains { $0 == need } }.flatMap(\.rows)
    }

    /// The baht amount an EMV payment code asks (tag 54, with tag 53 the currency 764): nil when it asks none, in
    /// another currency, or is no EMV code.
    static func emvBahtAmount(_ payload: String) -> Double? {
        var fields: [Substring: Substring] = [:]
        var rest = Substring(payload)
        while rest.count >= 4, let length = Int(rest.dropFirst(2).prefix(2)) {
            let value = rest.dropFirst(4).prefix(length)
            guard value.count == length else { return nil }
            fields[rest.prefix(2)] = value
            rest = rest.dropFirst(4 + length)
        }
        return fields["53"] == "764" ? fields["54"].flatMap { Double($0) } : nil
    }

    /// An amount the code asks, as Life words a card's (`amountWordsOf`, `memory/needs.ts`): Life sends no words for a
    /// QR's own amount, so the phone writes them the same way.
    static func amountWords(_ value: Double, currency: String) -> String {
        let cents = value.rounded() == value ? 0 : 2
        return value.formatted(.number.precision(.fractionLength(cents)).locale(Locale(identifier: "en_US")))
            + " \(currency)"
    }
}
