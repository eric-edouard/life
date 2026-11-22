import Foundation

/// The "your move" asks as the sorting list shows them: each with its age, its project and the people of its matter, and
/// the filters over them. The server's checks and `read_matters` hold every fact; this only joins them by matter id,
/// decides nothing about what is open, and sorts and answers nothing for the server.
public struct YourMoves: Equatable, Sendable {
    /// "Over a month": older than this many days.
    public static let monthDays = 30

    public struct Move: Equatable, Sendable, Identifiable {
        public let check: Check
        /// Whole days since the step was said (its sentence, else when the ask was made); nil when no date is known.
        public let ageDays: Int?
        public let project: MatterProject?
        /// Its matter's icon (`MatterRow.symbol`); nil when the matter is not among the rows.
        public let symbol: String?
        /// Who is in the matter: with, owed, waited on (never him).
        public let people: [Party]
        /// Its matter is dormant or probably done: nothing has moved on it.
        public let looksDead: Bool

        public var id: String { check.ref }
        public var isOverMonth: Bool { ageDays.map { $0 > YourMoves.monthDays } ?? false }
        /// "Roof gutter · 41 days": the matter, then the age (the row's title is the step, `check.question`; the card's
        /// own title is the kind's, "Your move", the same on every row).
        public var detail: String {
            [check.matter?.name, ageDays.map { $0 == 1 ? "1 day" : "\($0) days" }].compactMap(\.self).joined(
                separator: " · ")
        }
        /// The one-tap answer of the option `id`, nil when this card does not offer it (an older server has no `drop`).
        public func answer(_ id: String) -> AnswerRequest? {
            check.options.first { $0.id == id }.flatMap(check.answer)
        }
    }

    public enum Filter: Hashable, Sendable {
        case all, overMonth
        case project(String)
        case person(String)
    }

    /// Oldest first: what has waited longest comes first.
    public let moves: [Move]

    public init(checks: [Check], matters: [MatterRow], now: Date, timeZone: TimeZone = .current) {
        let byID = Dictionary(matters.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        moves = checks.filter { $0.group == .yourMove }.map { check in
            let row = check.matter.flatMap { byID[$0.id] }
            let at =
                (check.said?.at ?? check.since?.at).flatMap { SaidWords.parse($0, timeZone: timeZone)?.date }
                ?? check.at
            let people = [row?.people?.with, row?.people?.owedTo, row?.people?.waitingOn].compactMap(\.self)
                .flatMap { $0 }.filter { !$0.isOwner }
            return Move(
                check: check,
                ageDays: at.map { max(0, calendar.dateComponents([.day], from: $0, to: now).day ?? 0) },
                project: row?.project, symbol: row?.symbol,
                people: people.reduce(into: []) { all, party in if !all.contains(party) { all.append(party) } },
                looksDead: row.map { [.dormant, .probablyDone].contains($0.status) } ?? false)
        }
        .sorted { ($0.ageDays ?? -1) > ($1.ageDays ?? -1) }
    }

    public func shown(_ filter: Filter) -> [Move] {
        switch filter {
        case .all: moves
        case .overMonth: moves.filter(\.isOverMonth)
        case .project(let id): moves.filter { $0.project?.id == id }
        case .person(let ref): moves.filter { $0.people.contains { $0.ref == ref } }
        }
    }

    /// The moves whose matter looks dead (shown on All only, in their own group).
    public var dead: [Move] { moves.filter(\.looksDead) }

    /// The projects holding a move, in `chips`' order (Life's), by how many moves each holds.
    public func projects(in order: [String]) -> [(project: MatterProject, count: Int)] {
        order.compactMap { id in
            let held = moves.filter { $0.project?.id == id }
            return held.first?.project.map { ($0, held.count) }
        }
    }

    /// The people in most moves first, at most `limit`.
    public func people(limit: Int = 8) -> [Party] {
        var counts: [String: (party: Party, count: Int)] = [:]
        for party in moves.flatMap(\.people) { counts[party.ref, default: (party, 0)].count += 1 }
        return counts.values.sorted { ($0.count, $1.party.name) > ($1.count, $0.party.name) }.prefix(limit).map(\.party)
    }
}
