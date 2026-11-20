import Foundation
import Library

extension Check {
    /// What he needs in hand to do the step (the card's `needs`, the asks contract): one typed fact, drawn as rows with
    /// their one-press action. Each optional field is read on its own, so one Life sends in a shape this build doesn't know
    /// is nil; a kind it doesn't know is its `line` alone. `line` is always sent (the contract); a need without it fails
    /// the read.
    public struct Need: Decodable, Sendable, Equatable {
        public enum Kind: String, UnknownTolerant, Sendable {
            case account, amount, link, text
            case unknown
        }

        public let kind: Kind
        /// Life's plain words of it: what a phone that doesn't know the kind draws.
        public let line: String
        let bank: String?
        let number: String?
        let holder: String?
        let value: Double?
        let label: String?
        let text: String?
        let url: URL?
        let vendor: String?
        /// A text need he copies (a reference, a code).
        let copy: Bool?

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .unknown
            line = try c.decode(String.self, forKey: .line)
            bank = try? c.decodeIfPresent(String.self, forKey: .bank)
            number = try? c.decodeIfPresent(String.self, forKey: .number)
            holder = try? c.decodeIfPresent(String.self, forKey: .holder)
            value = try? c.decodeIfPresent(Double.self, forKey: .value)
            label = try? c.decodeIfPresent(String.self, forKey: .label)
            text = try? c.decodeIfPresent(String.self, forKey: .text)
            url = (try? c.decodeIfPresent(String.self, forKey: .url)).flatMap { $0.flatMap(URL.init(string:)) }
            vendor = try? c.decodeIfPresent(String.self, forKey: .vendor)
            copy = try? c.decodeIfPresent(Bool.self, forKey: .copy)
        }

        private enum CodingKeys: String, CodingKey {
            case kind, line, bank, number, holder, value, label, text, url, vendor, copy
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
                    holder.map { NeedRow(glyph: .person, text: $0, action: .copy($0, label: "Copy the name")) },
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
            case .text:
                rows =
                    text.map { text in
                        [
                            NeedRow(
                                glyph: .note, text: line,
                                action: copy == true ? .copy(text, label: "Copy \(label ?? "it")") : nil)
                        ]
                    } ?? []
            case .unknown:
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
    public enum Glyph: Sendable { case bank, card, person, amount, link, note }
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
