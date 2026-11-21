import Foundation
import Library

// Model spending (decision 83): what Life costs, on two bases never added: billed dollars, and his Claude and Codex
// plans' tokens at list price (`equivalent`). The glossary's "model spending"; `spending` alone is a payment's flag.

/// A spend's provider, by Life's own name (`SPEND_PROVIDERS`, `memory/spends.ts`; checked by `ContractTests`).
public enum SpendProvider: String, UnknownTolerant, Sendable {
    case openrouter, allmodels, elevenlabs, claude, codex, describer, apple, speech
    case unknown

    public var name: String {
        switch self {
        case .openrouter: "OpenRouter"
        case .allmodels: "allmodels.io"
        case .elevenlabs: "ElevenLabs"
        case .claude: "Claude"
        case .codex: "Codex"
        case .describer: "Photos"
        case .apple: "the arrival reader"
        case .speech: "speech"
        case .unknown: "Another provider"
        }
    }

    /// Runs on his Mac at $0: one row, "On this Mac".
    var isOnThisMac: Bool { self == .describer || self == .apple || self == .speech }
}

/// What a spend was for (`SpendKind`, `memory/spends.ts`; checked by `ContractTests`), in the page's order.
public enum SpendKind: String, UnknownTolerant, Sendable {
    case night, daytime, agents, voice
    case unknown

    var name: String {
        switch self {
        case .night: "The night"
        case .daytime: "Daytime readers"
        case .agents: "Agents"
        case .voice: "Voice"
        case .unknown: "Other"
        }
    }
}

/// Dollars on one basis (`Amount`, `host/spending-read.ts`); its currency is always USD.
public struct SpendAmount: Decodable, Sendable, Equatable {
    public let amount: Double
}

/// His plans' tokens and what they come to at list price, never billed: a matter's (`read_matter`), a top row's.
public struct TokenSpending: Decodable, Sendable, Equatable {
    public let tokens: Int
    public let equivalent: SpendAmount
    /// False when a turn came without its price or usage: the equivalent is a floor.
    public let reported: Bool

    /// "1.4 M tokens, ≈ $19 at list price, not billed"; `on` names the plan after the tokens.
    func words(on plan: String? = nil) -> String {
        [
            SpendWords.tokens(tokens) + (plan.map { " on \($0)" } ?? ""),
            SpendWords.listPrice(equivalent.amount, isBilled: false), reported ? nil : SpendWords.notReported,
        ].compactMap(\.self).joined(separator: ", ")
    }
}

/// A registered agent's current session (`read_registered_agents`' `spending`): its tokens, on whose plan, since when.
public struct AgentSpending: Decodable, Sendable, Equatable {
    public let spent: TokenSpending
    public let provider: SpendProvider
    /// When its session began; nil when the desk has no session for it.
    public let since: Date?

    private enum Key: String, CodingKey { case provider, since }

    public init(from decoder: any Decoder) throws {
        spent = try TokenSpending(from: decoder)
        let container = try decoder.container(keyedBy: Key.self)
        provider = try container.decode(SpendProvider.self, forKey: .provider)
        since = try container.decodeIfPresent(Date.self, forKey: .since)
    }
}

extension RegisteredAgent {
    /// The agent page's quiet last line: "This session, since 14 Nov: 2.2 M tokens on Claude, ≈ $30 at list price, not
    /// billed". Nil when the desk could not be read, or nothing was spent (no tokens, none unreported).
    public func spendingLine(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let spending, spending.spent.tokens > 0 || !spending.spent.reported else { return nil }
        let since = spending.since.map {
            ", since " + $0.formatted(Date.FormatStyle(locale: locale, timeZone: timeZone).day().month(.abbreviated))
        }
        return "This session\(since ?? ""): " + spending.spent.words(on: spending.provider.name)
    }
}

extension Matter {
    /// The matter page's quiet last line: "Since it opened: 1.4 M tokens, ≈ $19 at list price, not billed". Nil when the
    /// desk could not be read, or nothing was spent (no tokens, none unreported).
    public var spendingLine: String? {
        guard let spending, spending.tokens > 0 || !spending.reported else { return nil }
        return "Since it opened: " + spending.words()
    }
}

/// The one wording of model spending's figures.
public enum SpendWords {
    static let notReported = "not all reported"

    /// Billed dollars: "$8.96", "$0", "< $0.01".
    public static func dollars(_ amount: Double) -> String {
        if amount <= 0 { return "$0" }
        if amount < 0.005 { return "< $0.01" }
        return amount.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US")))
    }

    /// "4.1 M tokens", "12 k tokens", "640 tokens".
    public static func tokens(_ count: Int) -> String {
        if count < 1000 { return "\(count) tokens" }
        if count < 100_000 { return "\(Int((Double(count) / 1000).rounded())) k tokens" }
        let millions = (Double(count) / 1_000_000).formatted(
            .number.precision(.fractionLength(1)).locale(Locale(identifier: "en_US")))
        return millions + " M tokens"
    }

    /// "≈ $61 at list price", whole dollars from $1; "≈ $61 at list price, not billed" where billing could be read in.
    static func listPrice(_ amount: Double, isBilled: Bool = true) -> String {
        let dollars = amount < 1 ? Self.dollars(amount) : "$\(Int(amount.rounded()))"
        return "≈ \(dollars) at list price" + (isBilled ? "" : ", not billed")
    }
}

/// One row of the Spending page: its name, its figure, one muted line, its share of the month's billed total (a bar under
/// it), and what it opens.
public struct SpendLine: Sendable, Equatable, Identifiable {
    public enum Opens: Sendable, Equatable {
        case agent(String)
        case matter(String)
    }

    public let title: String
    public let value: String
    public var detail: String?
    /// 0 to 1.
    public var share: Double?
    /// $0: the value muted.
    public var isZero = false
    public var opens: Opens?

    public var id: String {
        switch opens {
        case .agent(let id), .matter(let id): id
        case nil: title
        }
    }
}

/// A labelled list of the Spending page.
public struct SpendSection: Sendable, Equatable {
    public let label: String
    public let lines: [SpendLine]
}

/// `read_spending`: his current month, billed and his plans' tokens apart.
public struct ModelSpending: Decodable, Sendable, Equatable, ParsedRead, NamesParties {
    public struct Day: Decodable, Sendable, Equatable {
        /// `2026-11-01`, his local day.
        public let day: String
        public let billed: SpendAmount
    }

    public struct ByProvider: Decodable, Sendable, Equatable {
        public let provider: SpendProvider
        public let billed: SpendAmount?
        public let equivalent: SpendAmount?
        public let tokens: Int?
        public let reported: Bool
    }

    public struct ByKind: Decodable, Sendable, Equatable {
        public let kind: SpendKind
        /// None for the agents, which run on his plans: their `equivalent` instead.
        public let billed: SpendAmount?
        public let equivalent: SpendAmount?
        public let tokens: Int?
    }

    /// A top agent or matter: its id, its name, its tokens.
    public struct Top: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let spent: TokenSpending

        private enum Key: String, CodingKey { case id, agent, matter }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: Key.self)
            id = try container.decode(String.self, forKey: .id)
            name =
                try container.decodeIfPresent(String.self, forKey: .agent)
                ?? container.decode(String.self, forKey: .matter)
            spent = try TokenSpending(from: decoder)
        }
    }

    public let today: SpendAmount
    public let month: SpendAmount
    /// Each day held, the 1st to today.
    public let days: [Day]
    public let byProvider: [ByProvider]
    public let byKind: [ByKind]
    /// Voice work not settled when its day was written, not counted: the month is a floor.
    public let unsettled: Int
    public let topAgents: [Top]
    public let topMatters: [Top]
    public let observedAt: Date

    public var parties: [Party] { [] }

    /// "November": the month its days are in.
    public func monthName(locale: Locale = .current) -> String {
        (days.first.flatMap { Self.date($0.day) } ?? observedAt).formatted(
            Date.FormatStyle(locale: locale, timeZone: .gmt).month(.wide))
    }

    /// "1 Nov": a day of `days`, as a bar's label says it.
    public func dayLabel(_ day: String, locale: Locale = .current) -> String {
        Self.date(day)?.formatted(Date.FormatStyle(locale: locale, timeZone: .gmt).day().month(.abbreviated)) ?? day
    }

    private static func date(_ day: String) -> Date? { try? Date(day + "T12:00:00Z", strategy: .iso8601) }

    /// The page's lists, in order, each left out when empty: billed by provider (the Mac's at $0 as one row), his plans,
    /// by kind, the top agents and matters.
    public var sections: [SpendSection] {
        let billed = byProvider.filter { $0.billed != nil && !$0.provider.isOnThisMac }
            .sorted { ($0.billed?.amount ?? 0) > ($1.billed?.amount ?? 0) }
            .map { row in
                let amount = row.billed?.amount ?? 0
                return SpendLine(
                    title: row.provider.name, value: SpendWords.dollars(amount),
                    detail: row.reported ? nil : "Not reported", share: month.amount > 0 ? amount / month.amount : nil,
                    isZero: amount <= 0)
            }
        let onMac = byProvider.filter(\.provider.isOnThisMac)
        let mac = onMac.isEmpty ? [] : [onThisMac(onMac)]
        let plans = byProvider.compactMap { row in
            row.equivalent.map {
                SpendLine(
                    title: row.provider.name, value: SpendWords.tokens(row.tokens ?? 0),
                    detail: [SpendWords.listPrice($0.amount), row.reported ? nil : SpendWords.notReported]
                        .compactMap(\.self).joined(separator: ", "))
            }
        }
        let order = SpendKind.allCases
        // Voice work not settled yet shows on a Voice row even before any of it settled.
        let voice = ByKind(kind: .voice, billed: SpendAmount(amount: 0), equivalent: nil, tokens: nil)
        let held = byKind + (unsettled > 0 && !byKind.contains { $0.kind == .voice } ? [voice] : [])
        // The agents run on his plans: a plan's unreported turn makes their list price a floor too.
        let isPlanUnreported = byProvider.contains { $0.equivalent != nil && !$0.reported }
        let kinds = held.sorted { order.firstIndex(of: $0.kind) ?? 0 < order.firstIndex(of: $1.kind) ?? 0 }
            .map { kind in
                guard let billed = kind.billed else {
                    // An older Life sends no list price for them: their tokens alone, never "≈ $0".
                    let price = kind.equivalent.map {
                        [
                            SpendWords.listPrice($0.amount, isBilled: false),
                            isPlanUnreported ? SpendWords.notReported : nil,
                        ].compactMap(\.self).joined(separator: ", ")
                    }
                    return SpendLine(
                        title: kind.kind.name, value: SpendWords.tokens(kind.tokens ?? 0),
                        detail: price ?? "Not billed")
                }
                return SpendLine(
                    title: kind.kind.name, value: SpendWords.dollars(billed.amount),
                    detail: kind.kind == .voice && unsettled > 0 ? "\(unsettled) not settled yet" : nil,
                    isZero: billed.amount <= 0)
            }
        func tops(_ rows: [Top], opens: (String) -> SpendLine.Opens) -> [SpendLine] {
            rows.map {
                SpendLine(
                    title: $0.name, value: SpendWords.tokens($0.spent.tokens),
                    detail: [
                        SpendWords.listPrice($0.spent.equivalent.amount, isBilled: false),
                        $0.spent.reported ? nil : SpendWords.notReported,
                    ].compactMap(\.self).joined(separator: ", "), opens: opens($0.id))
            }
        }
        return [
            SpendSection(label: "Billed to your keys, by provider", lines: billed + mac),
            SpendSection(label: "Subscriptions, not counted above", lines: plans),
            SpendSection(label: "By kind, this month", lines: kinds),
            SpendSection(label: "Top agents, by tokens", lines: tops(topAgents, opens: SpendLine.Opens.agent)),
            SpendSection(label: "Top matters, by tokens", lines: tops(topMatters, opens: SpendLine.Opens.matter)),
        ].filter { !$0.lines.isEmpty }
    }

    /// The Mac's own models, one row: what it ran ("Photos, the arrival reader") at what it billed ($0).
    private func onThisMac(_ rows: [ByProvider]) -> SpendLine {
        let amount = rows.reduce(0) { $0 + ($1.billed?.amount ?? 0) }
        let names = rows.map(\.provider.name).joined(separator: ", ")
        return SpendLine(
            title: "On this Mac", value: SpendWords.dollars(amount),
            detail: names.prefix(1).uppercased() + names.dropFirst(), isZero: amount <= 0)
    }
}
