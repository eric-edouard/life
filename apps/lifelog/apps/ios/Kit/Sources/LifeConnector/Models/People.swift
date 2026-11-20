import Foundation
import Library

/// How close someone is to him, as Life judged it (`ClosenessLevel`, `records/observation.ts`), closest first.
public enum ClosenessLevel: String, UnknownTolerant, Sendable {
    case inner, regular, acquaintance, faded
    case unknown

    /// Its word on a person's page: "Close", "Regular", "Acquaintance", "Faded".
    public var word: String? {
        switch self {
        case .inner: "Close"
        case .regular: "Regular"
        case .acquaintance: "Acquaintance"
        case .faded: "Faded"
        case .unknown: nil
        }
    }
}

/// Someone on the People list (`PersonRow`, `memory/person-now.ts`): the party, how close (none until judged), their
/// last exchange with him, and whether anything with them needs him.
public struct PersonRow: Decodable, Sendable, Equatable, Identifiable {
    public let party: Party
    public let level: ClosenessLevel?
    public let lastExchangeAt: Date?
    public let needsYou: Bool

    public var id: String { party.ref }

    private enum Key: String, CodingKey { case level, lastExchangeAt, needsYou }

    /// The party's fields and the row's side by side, as Life writes them.
    public init(from decoder: any Decoder) throws {
        party = try Party(from: decoder)
        let container = try decoder.container(keyedBy: Key.self)
        level = try container.decodeIfPresent(ClosenessLevel.self, forKey: .level)
        lastExchangeAt = try container.decodeIfPresent(Date.self, forKey: .lastExchangeAt)
        needsYou = try container.decodeIfPresent(Bool.self, forKey: .needsYou) ?? false
    }

    /// "Close · last exchange Tue 17 Nov": how close and when they last wrote or spoke, what of it Life knows.
    public func standing(locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        let last = lastExchangeAt.map { "last exchange " + SaidWords.day($0, locale: locale, timeZone: timeZone) }
        let words = [level?.word, last].compactMap(\.self)
        guard !words.isEmpty else { return nil }
        let line = words.joined(separator: " · ")
        return line.prefix(1).uppercased() + line.dropFirst()
    }
}

/// `read_people_and_organizations` with no name: his directory's people and organizations and everyone with a page, in
/// Life's order (closest first, the newest exchange first inside a level, the unjudged last); with a query, its matches
/// and `others`, the people only his Contacts or Life's guesses name.
public struct PeopleList: Decodable, Sendable, Equatable {
    public let people: [PersonRow]
    public let others: [Party]?

    /// Which of them the list shows.
    public enum Kind: Hashable, Sendable, CaseIterable {
        case all, people, organizations
    }

    /// How the list is ordered: Life's closeness (the default) or A to Z.
    public enum Order: Hashable, Sendable {
        case closeness, alphabet
    }

    /// A run of rows under one label; the first group by closeness has none (it is simply first).
    public struct Group: Identifiable, Equatable, Sendable {
        public let label: String?
        public let rows: [PersonRow]
        public var id: String { label ?? "" }
    }

    /// The rows of `kind`, in `order`: by closeness, Life's own order cut where the level changes ("Regular",
    /// "Acquaintances", "Faded", then "Not judged yet"); A to Z, by name under each first letter ("#" for any other).
    public func groups(_ order: Order, _ kind: Kind) -> [Group] {
        let rows = people.filter { row in
            switch kind {
            case .all: true
            case .people: row.party.kind != .organization
            case .organizations: row.party.kind == .organization
            }
        }
        switch order {
        case .closeness:
            return chunked(rows) { row in
                switch row.level {
                case .inner: nil
                case .regular: "Regular"
                case .acquaintance: "Acquaintances"
                case .faded: "Faded"
                case .unknown, nil: "Not judged yet"
                }
            }
        case .alphabet:
            let sorted = rows.sorted { $0.party.name.localizedStandardCompare($1.party.name) == .orderedAscending }
            return chunked(sorted) { Self.letter(of: $0.party.name) }
        }
    }

    /// A name's index letter: its first letter without accents, capital; "#" for a name that starts otherwise.
    public static func letter(of name: String) -> String {
        guard let first = name.first, first.isLetter else { return "#" }
        return String(first).folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).uppercased()
    }

    /// Consecutive rows with the same label, one group each.
    private func chunked(_ rows: [PersonRow], label: (PersonRow) -> String?) -> [Group] {
        rows.reduce(into: [Group]()) { groups, row in
            let name = label(row)
            if let last = groups.last, last.label == name {
                groups[groups.count - 1] = Group(label: name, rows: last.rows + [row])
            } else {
                groups.append(Group(label: name, rows: [row]))
            }
        }
    }
}

/// One of them read in full (`read_people_and_organizations` with a name, its part `now`): who they are to him and how
/// close; the page draws what it holds.
public struct PersonNow: Decodable, Sendable, Equatable {
    public let row: PersonRow

    public init(from decoder: any Decoder) throws {
        row = try PersonRow(from: decoder)
    }
}

extension PeopleList: NamesParties {
    public var parties: [Party] { people.map(\.party) + (others ?? []) }
}

extension PersonNow: NamesParties {
    public var parties: [Party] { [row.party] }
}
