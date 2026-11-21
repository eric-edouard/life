import Foundation

/// A payee's QR the phone draws (a `qr` need with its text): the card's hero, with what the bank app will show beside it.
public struct PayCode: Sendable, Equatable {
    /// The code's text, drawn as the code.
    public let payload: String
    /// Where the payee sent it, in Life's words.
    public let source: String
    /// The message holding it, as `fetch` opens it; nil when Life gave none.
    public let ref: String?
    /// What the code asks, else the card's amount ("4,800 THB"); nil when neither says.
    public let amount: String?
    /// The card's amount when the code asks another: his invoice's, to check before he pays.
    public let invoiceAmount: String?
    /// The name the bank app should show: the account's holder.
    public let payee: String?

    /// The amount as the card draws it: the figure large, its currency small ("4,500", "THB"): the currency is the
    /// last word; an amount of one word has none.
    public var figure: (number: String, currency: String?)? {
        guard let amount else { return nil }
        guard let space = amount.lastIndex(of: " ") else { return (amount, nil) }
        return (String(amount[..<space]), String(amount[amount.index(after: space)...]))
    }
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
    private var accountIndex: Int? { needs?.firstIndex { $0.kind == .account } }
    private var invoiceIndex: Int? { needs?.firstIndex { $0.kind == .amount && $0.value != nil } }
    /// The QR the card draws: the first with its text.
    private var drawnQRIndex: Int? { needs?.firstIndex { $0.kind == .qr && $0.payload != nil && $0.source != nil } }
    private func need(at index: Int?) -> Need? { index.flatMap { needs?[$0] } }
    private var account: Need? { need(at: accountIndex) }
    private var invoice: Need? { need(at: invoiceIndex) }

    /// Which bank app the card's filled answer opens, by its account's `scheme`; nil when it names none it knows, and on
    /// a plan, whose start is the filled answer.
    public var transfers: Transfers? {
        guard filled?.role != .start else { return nil }
        return switch account?.scheme {
        case .thAccount?, .promptpay?: .thai
        case .iban?, .swift?: .iban
        default: nil
        }
    }

    /// The payee's QR, when Life sent its text: the card draws it, with the amount and the name around it. A PromptPay
    /// code's own amount is shown as the code asks it; the card's amount shows when the code asks none, and beside it
    /// in `invoiceAmount` when the code asks another amount or currency.
    public var payCode: PayCode? {
        guard let qr = need(at: drawnQRIndex), let payload = qr.payload, let source = qr.source else { return nil }
        guard let asked = Self.promptPayBaht(payload) else {
            return PayCode(
                payload: payload, source: source, ref: qr.ref, amount: invoice?.line, invoiceAmount: nil,
                payee: account?.holder)
        }
        let isInvoice = invoice.map { $0.currency == "THB" && Self.isSameMoney($0.value, asked) } ?? true
        return PayCode(
            payload: payload, source: source, ref: qr.ref, amount: Self.amountWords(asked, currency: "THB"),
            invoiceAmount: isInvoice ? nil : invoice?.line, payee: account?.holder)
    }

    /// Whether Life looks for this card's payment (`doneSeenBy`): it looks for the card's amount, so not when the QR
    /// asks another.
    public var isPaymentLookedFor: Bool {
        doneSeenBy == .payment && invoice != nil && payCode?.invoiceAmount == nil
    }

    /// The rows under the question: every need's, less the one QR, account and amount the code's hero shows.
    public var shownNeedRows: [NeedRow] {
        let shown = payCode == nil ? [] : Set([drawnQRIndex, accountIndex, invoiceIndex].compactMap { $0 })
        return (needs ?? []).enumerated().filter { !shown.contains($0.offset) }.flatMap(\.element.rows)
    }

    /// The baht a PromptPay code asks (Bank of Thailand's EMV QR: tag 29 a credit transfer, its tag 00
    /// `A000000677010111`, or tag 30 a bill payment, `A000000677010112`; tag 53 the currency 764; tag 54 the amount in
    /// whole satang at most): nil for any other code, one that asks no amount, or text that is not a whole, well-formed
    /// EMV code.
    static func promptPayBaht(_ payload: String) -> Double? {
        let isPromptPay =
            fields(payload, "29").flatMap { emvFields($0)?["00"] } == "A000000677010111"
            || fields(payload, "30").flatMap { emvFields($0)?["00"] } == "A000000677010112"
        guard isPromptPay, let fields = emvFields(payload), fields["53"] == "764", let amount = fields["54"],
            amount.wholeMatch(of: /[0-9]+(\.[0-9]{1,2})?/) != nil, let value = Double(amount), value > 0
        else { return nil }
        return value
    }

    /// An EMV code's fields by tag: each two digits of tag, two of length, then exactly that many characters, to the
    /// end; nil when any part is not.
    static func emvFields(_ text: String) -> [String: String]? {
        var fields: [String: String] = [:]
        var rest = Substring(text)
        while !rest.isEmpty {
            let head = rest.prefix(4)
            guard head.count == 4, head.allSatisfy({ $0.isASCII && $0.isNumber }), let length = Int(head.suffix(2))
            else { return nil }
            let value = rest.dropFirst(4).prefix(length)
            guard value.count == length else { return nil }
            fields[String(head.prefix(2))] = String(value)
            rest = rest.dropFirst(4 + length)
        }
        return fields
    }

    /// Whether a payment of `asked` is one Life's watcher sees for a card of `value`: half a cent either side, strictly
    /// (`HALF_CENT`, `host/done-seen.ts`).
    private static func isSameMoney(_ value: Double?, _ asked: Double) -> Bool {
        value.map { asked > $0 - 0.005 && asked < $0 + 0.005 } ?? false
    }

    private static func fields(_ payload: String, _ tag: String) -> String? { emvFields(payload)?[tag] }

    /// An amount the code asks, as Life words a card's (`amountWordsOf`, `memory/needs.ts`): Life sends no words for a
    /// QR's own amount, so the phone writes them the same way.
    static func amountWords(_ value: Double, currency: String) -> String {
        let cents = value.rounded() == value ? 0 : 2
        return value.formatted(.number.precision(.fractionLength(cents)).locale(Locale(identifier: "en_US")))
            + " \(currency)"
    }
}

/// His trip to the bank app from one card: the QR saved to Photos, the app opened, a press under way, or why the last
/// one did not go. Kept per card (by its ref), so a view drawn again never starts a second trip.
public struct BankTrip: Equatable, Sendable {
    public var isCodeSaved = false
    public var hasOpenedApp = false
    public var isUnderWay = false
    public var problem: String?

    public init() {}

    /// One press: saves the QR the first time (`save` gives his words for why it did not go, nil when saved), then
    /// opens the app. A press while one is under way does nothing; after a failed open, only the open is tried again.
    /// `get` and `set` read and write this card's trip, which may outlive the view that pressed.
    @MainActor
    public static func press(
        get: @MainActor () -> BankTrip, set: @MainActor (BankTrip) -> Void,
        save: (@MainActor () async -> String?)?, open: @MainActor () async -> Bool, appName: String
    ) async {
        func change(_ edit: (inout BankTrip) -> Void) {
            var trip = get()
            edit(&trip)
            set(trip)
        }
        guard !get().isUnderWay else { return }
        change { $0.isUnderWay = true }
        defer { change { $0.isUnderWay = false } }
        if let save, !get().isCodeSaved {
            if let problem = await save() { return change { $0.problem = problem } }
            change { $0.isCodeSaved = true }
        }
        let opened = await open()
        change {
            $0.hasOpenedApp = $0.hasOpenedApp || opened
            $0.problem = opened ? nil : "\(appName) did not open. Is it on this phone?"
        }
    }
}
