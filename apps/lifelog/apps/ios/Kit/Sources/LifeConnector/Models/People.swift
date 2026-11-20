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

/// One of them read in full (`read_people_and_organizations` with a name, its part `now`, `personNowOf`): who they
/// are to him and how close, how to reach them, their details, what Life holds about them (`knows`), how each writes to
/// the other, their situation, and what is open with them. A list Life had no room for counts what it left out (`more`).
public struct PersonNow: Decodable, Sendable, Equatable {
    /// An app and their accounts on it, newest exchange first (`Reach`, `memory/reach.ts`).
    public struct Reach: Decodable, Sendable, Equatable, Identifiable {
        public struct Account: Decodable, Sendable, Equatable, Identifiable {
            public struct Open: Decodable, Sendable, Equatable {
                public let url: String
            }
            public let handle: String
            /// Their name on that app, else his Contacts' label ("Mobile"); none: the handle is its title.
            public let title: String?
            public let lastAt: Date?
            public let open: Open
            public var id: String { handle }
        }
        public let network: String
        public let label: String
        public internal(set) var accounts: [Account]
        public var id: String { network }
    }

    /// A detail of theirs as a field (`DetailNow`, `memory/person-now.ts`): a birthday with its next one, a home, a work,
    /// family, a handle reach does not cover.
    public struct Detail: Decodable, Sendable, Equatable {
        public enum Kind: String, UnknownTolerant, Sendable {
            case birthday, home, work, family, handles
            case unknown
        }
        public struct Next: Decodable, Sendable, Equatable {
            public let age: Int?
            public let day: String
            public let left: Int
        }
        public let kind: Kind
        public let text: String
        public let next: Next?
        /// Where it comes from: `reach` for an account `now` had no room for in reach.
        public let from: String?
    }

    /// A part Life holds about them, the ref `fetch` opens and its first sentence.
    public struct Known: Decodable, Sendable, Equatable, Identifiable {
        public let part: String
        public let ref: String
        public let first: String
        public var id: String { ref }
    }

    /// One line of their situation, or of how each writes to the other.
    public struct Line: Decodable, Sendable, Equatable {
        public let text: String
    }

    public let row: PersonRow
    public let reach: [Reach]
    public let details: [Detail]
    public let knows: [Known]
    /// The running matters with them, most pressing first.
    public let open: [MatterRow]
    public let situation: [Line]
    public let communicationStyle: [Line]
    public let more: [String: Int]
    /// The `reach` part's ref when `now` had no room for every account (`reach/<offset>` pages them all).
    public let moreReach: String?

    private enum Key: String, CodingKey {
        case reach, details, knows, open, situation, communicationStyle, more, moreReach
    }

    public init(from decoder: any Decoder) throws {
        row = try PersonRow(from: decoder)
        let container = try decoder.container(keyedBy: Key.self)
        func list<T: Decodable>(_ key: Key) throws -> [T] { try container.decodeIfPresent([T].self, forKey: key) ?? [] }
        (reach, details, knows, open) = (try list(.reach), try list(.details), try list(.knows), try list(.open))
        (situation, communicationStyle) = (try list(.situation), try list(.communicationStyle))
        more = try container.decodeIfPresent([String: Int].self, forKey: .more) ?? [:]
        moreReach = try container.decodeIfPresent(String.self, forKey: .moreReach)
    }

    /// Reach with every account once the `reach` part's pages are read, in order, to its end (`pages`; none: `now`'s
    /// own), and the details less the accounts `now` had put there for want of room.
    public func withEveryAccount(_ pages: [ReachPage]?) -> (reach: [Reach], details: [Detail]) {
        guard let pages, !pages.isEmpty, pages.last?.next == nil else { return (reach, details) }
        var merged: [Reach] = []
        for app in pages.flatMap(\.reach) {
            if let at = merged.firstIndex(where: { $0.network == app.network }) {
                merged[at].accounts += app.accounts
            } else {
                merged.append(app)
            }
        }
        return (merged, details.filter { $0.from != "reach" })
    }

    /// How many matters are open with them, those Life left out included.
    public var openCount: Int { open.count + (more["open"] ?? 0) }

    /// Their first name, as a page's labels say it ("Open with Camille").
    public var firstName: String { row.party.name.split(separator: " ").first.map(String.init) ?? row.party.name }

    /// A known part's title on the page: "About Camille", "What Camille is like", "Your history".
    public func title(of known: Known) -> String {
        switch known.part {
        case "page": "About \(firstName)"
        case "persona": "What \(firstName) is like"
        case "story": "Your history"
        case "evidence": "What Life noted"
        default: known.part.capitalized
        }
    }
}

extension PersonNow.Detail {
    /// The detail as a row says it: its value, then what it is ("14 March" over "Birthday · turns 34 in 12 days").
    public func shown(locale: Locale = .current) -> (value: String, what: String) {
        switch kind {
        case .birthday:
            let parts = text.split(separator: "-").compactMap { Int($0) }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = .gmt
            let date =
                parts.count >= 2
                ? calendar.date(
                    from: DateComponents(year: 2000, month: parts[parts.count - 2], day: parts[parts.count - 1]))
                : nil
            let day = date?.formatted(Date.FormatStyle(locale: locale, timeZone: .gmt).day().month(.wide)) ?? text
            let when = next.map { next in
                let left = next.left == 0 ? "today" : "in \(next.left) day\(next.left == 1 ? "" : "s")"
                return next.age.map { "turns \($0) \(left)" } ?? left
            }
            return (day, ["Birthday", when].compactMap(\.self).joined(separator: " · "))
        case .home: return (text, "Home")
        case .work: return (text, "Work")
        case .family: return (text, "Family")
        case .handles, .unknown:
            // A handle reach had no room for is written "<app>: <handle>".
            guard let colon = text.range(of: ": ") else { return (text, "Handle") }
            return (String(text[colon.upperBound...]), String(text[..<colon.lowerBound]))
        }
    }

    /// A phone or an address he may copy: a handle.
    public var isCopied: Bool { kind == .handles }
}

/// A page of the `reach` part: every account from its offset on, as many as fit, and the next page's ref.
public struct ReachPage: Decodable, Sendable, Equatable, ParsedRead, NamesParties {
    public let reach: [PersonNow.Reach]
    public let next: String?
    public var parties: [Party] { [] }
}

/// A page of their newest exchanges with him (`latest`, `readLatest`): five a page by whole days, newest first, and the
/// day to page back from.
public struct LatestPage: Decodable, Sendable, Equatable, ParsedRead, NamesParties {
    /// One exchange in a chat or by mail, its lines his and theirs; or a conversation in person, its summary.
    public struct Item: Decodable, Sendable, Equatable, Identifiable {
        public struct Said: Decodable, Sendable, Equatable {
            public enum By: String, UnknownTolerant, Sendable {
                case him, them
                case unknown
            }
            public let by: By
            public let text: String
        }
        public let channel: String
        public let at: Date
        public let lines: [Said]?
        public let open: PersonNow.Reach.Account.Open?
        public let summary: String?
        public var id: String { channel + "@" + at.formatted(.iso8601) }
        /// A conversation in person.
        public var isHeard: Bool { channel == "voice" }
    }

    public let latest: [Item]
    public let nextBefore: String?

    public var parties: [Party] { [] }

    /// The page before this one: its part's ref with `before` (`<ref>/latest/before/<day>`).
    public func earlier(of subject: String) -> String? { nextBefore.map { "\(subject)/latest/before/\($0)" } }
}

/// A prose part of a read (`page`, `persona`, `story`, `evidence`) as the page shows it: its sections, each its label
/// and paragraphs; Life's header, the title and the next reads left out.
public struct Prose: Sendable, Equatable, ParsedRead, NamesParties {
    public struct Section: Sendable, Equatable, Identifiable {
        public let label: String?
        public let paragraphs: [String]
        public var id: String { label ?? "" }
    }

    public let sections: [Section]
    public var parties: [Party] { [] }

    public static func parsed(_ text: String) throws -> Prose {
        var sections: [Section] = []
        var label: String?
        var paragraphs: [String] = []
        func close() {
            if label != nil || !paragraphs.isEmpty { sections.append(Section(label: label, paragraphs: paragraphs)) }
            paragraphs = []
        }
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("Next reads") { break }
            if line.hasPrefix("Life's memory (") { continue }
            if line.hasPrefix("## ") {
                close()
                label = String(line.dropFirst(3))
            } else if !line.isEmpty, !line.hasPrefix("# ") {
                paragraphs.append(line.hasPrefix("- ") ? String(line.dropFirst(2)) : line)
            }
        }
        close()
        return Prose(sections: sections)
    }
}
extension PeopleList: NamesParties {
    public var parties: [Party] { people.map(\.party) + (others ?? []) }
}

extension PersonNow: NamesParties {
    public var parties: [Party] { [row.party] + open.flatMap(\.parties) }
}
