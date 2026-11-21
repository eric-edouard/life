import Foundation
import Library

extension Check {
    /// What he needs in hand to do the step (the card's `needs`, the asks contract): one typed fact, drawn as rows with
    /// their one-press action. Each optional field is read on its own, so one Life sends in a shape this build doesn't know
    /// is nil; a kind it doesn't know is its `line` alone. `line` is always sent (the contract); a need without it fails
    /// the read.
    public struct Need: Decodable, Sendable, Equatable {
        public enum Kind: String, UnknownTolerant, Sendable {
            case account, amount, link, place, text, qr
            case unknown
        }

        /// How an account is paid (`scheme`, the asks contract): his phone picks the bank app by it (`Check.transfers`).
        public enum Scheme: String, UnknownTolerant, Sendable {
            case thAccount = "th_account"
            case promptpay, iban, swift, other
            case unknown
        }

        public let kind: Kind
        /// Life's plain words of it: what a phone that doesn't know the kind draws.
        public let line: String
        let bank: String?
        let number: String?
        let holder: String?
        let scheme: Scheme?
        let value: Double?
        let currency: String?
        let label: String?
        let text: String?
        let url: URL?
        let vendor: String?
        /// A text need he copies (a reference, a code).
        let copy: Bool?
        /// A QR code's text, and where the payee sent it.
        let payload: String?
        let source: String?
        /// A place's links, each opened only by his tap: Bolt's only when Life or the agent gave one.
        let googleMapsUrl: URL?
        let appleMapsUrl: URL?
        let boltUrl: URL?

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .unknown
            line = try c.decode(String.self, forKey: .line)
            bank = try? c.decodeIfPresent(String.self, forKey: .bank)
            number = try? c.decodeIfPresent(String.self, forKey: .number)
            holder = try? c.decodeIfPresent(String.self, forKey: .holder)
            scheme = try? c.decodeIfPresent(Scheme.self, forKey: .scheme)
            value = try? c.decodeIfPresent(Double.self, forKey: .value)
            currency = try? c.decodeIfPresent(String.self, forKey: .currency)
            label = try? c.decodeIfPresent(String.self, forKey: .label)
            text = try? c.decodeIfPresent(String.self, forKey: .text)
            vendor = try? c.decodeIfPresent(String.self, forKey: .vendor)
            copy = try? c.decodeIfPresent(Bool.self, forKey: .copy)
            payload = try? c.decodeIfPresent(String.self, forKey: .payload)
            source = try? c.decodeIfPresent(String.self, forKey: .source)
            func link(_ key: CodingKeys) -> URL? {
                (try? c.decodeIfPresent(String.self, forKey: key)).flatMap { $0.flatMap(URL.init(string:)) }
            }
            url = link(.url)
            googleMapsUrl = link(.googleMapsUrl)
            appleMapsUrl = link(.appleMapsUrl)
            boltUrl = link(.boltUrl)
        }

        private enum CodingKeys: String, CodingKey {
            case kind, line, bank, number, holder, scheme, value, currency, label, text, url, vendor, copy, payload,
                source, googleMapsUrl, appleMapsUrl, boltUrl
        }

        /// The rows the card draws, decided here once: the view only draws them. A need whose fields say nothing
        /// drawable is its `line`.
        public var rows: [NeedRow] {
            let rows: [NeedRow]
            switch kind {
            case .account:
                rows = [
                    bank.map { NeedRow(glyph: .bank, text: $0) },
                    number.map {
                        NeedRow(
                            glyph: .card, text: $0, isFigure: true,
                            action: .copy($0.filter { !$0.isWhitespace && $0 != "-" }, label: "Copy the account number")
                        )
                    },
                    // The name is his to check against the bank app's, never to paste (the contract).
                    holder.map { NeedRow(glyph: .person, text: $0) },
                ].compactMap { $0 }
            case .amount:
                rows =
                    value.map {
                        [
                            NeedRow(
                                glyph: .amount, text: line, isFigure: true,
                                action: .copy(Self.plain($0), label: "Copy the amount"))
                        ]
                    } ?? []
            case .link:
                // A web page only: another app's scheme would open that app under a host that warns of nothing.
                if let url, ["https", "http"].contains(url.scheme?.lowercased()), let host = url.host() {
                    rows = [
                        NeedRow(
                            glyph: .link, text: vendor ?? line, detail: host, action: .open(url, label: "Open \(host)"))
                    ]
                } else {
                    rows = []
                }
            case .place:
                // Its line, then each link it has, https only, its host in full under it.
                let links = [("Google Maps", googleMapsUrl), ("Apple Maps", appleMapsUrl), ("Ride with Bolt", boltUrl)]
                    .compactMap { name, url -> NeedRow? in
                        guard let url, url.scheme?.lowercased() == "https", let host = url.host() else { return nil }
                        return NeedRow(
                            glyph: .link, text: name, detail: host, action: .open(url, label: "Open \(name)"))
                    }
                rows = [NeedRow(glyph: .place, text: line)] + links
            case .text:
                rows =
                    text.map { text in
                        [
                            NeedRow(
                                glyph: .note, text: line,
                                action: copy == true ? .copy(text, label: "Copy \(label ?? "it")") : nil)
                        ]
                    } ?? []
            // The code itself is the card's hero (`Check.payCode`); without its text, its line.
            case .qr, .unknown:
                rows = []
            }
            return rows.isEmpty ? [NeedRow(glyph: .note, text: line)] : rows
        }

        /// An amount as a bank app takes it: digits and a point, no grouping, no currency.
        static func plain(_ value: Double) -> String {
            value.rounded() == value ? String(Int(value)) : String(format: "%.2f", value)
        }
    }
}

/// One row of a need: a glyph, the fact, and at most one press.
public struct NeedRow: Sendable, Equatable {
    public enum Glyph: Sendable { case bank, card, person, amount, link, note, place }
    public enum Action: Sendable, Equatable {
        /// What goes on the pasteboard, and the button's spoken label.
        case copy(String, label: String)
        /// A page he opens by his own tap only.
        case open(URL, label: String)
    }

    public let glyph: Glyph
    public let text: String
    /// A second, muted line: a link's full host.
    public let detail: String?
    /// A number a thumb looks for (an account, an amount): tabular, one step stronger.
    public let isFigure: Bool
    public let action: Action?

    public init(glyph: Glyph, text: String, detail: String? = nil, isFigure: Bool = false, action: Action? = nil) {
        self.glyph = glyph
        self.text = text
        self.detail = detail
        self.isFigure = isFigure
        self.action = action
    }
}
