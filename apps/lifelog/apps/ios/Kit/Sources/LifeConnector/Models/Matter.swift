import Foundation
import Library

public enum MatterStatus: String, UnknownTolerant, Sendable {
    case done, dormant, moving, stuck
    case probablyDone = "probably_done"
    case waitingOnSomeone = "waiting_on_someone"
    case unknown
}

public enum Author: String, UnknownTolerant, Sendable {
    case life, owner
    case unknown
}

/// A matter as the lists give it (`read_matters`): where it stands, its goal and next step, who is in it, and the
/// registered agent working on it. A field with nothing in it is absent.
public struct MatterRow: Decodable, Sendable, Equatable, Identifiable {
    public struct Goal: Decodable, Sendable, Equatable {
        public let by: Author
        public let text: String
    }

    public enum StepKind: String, UnknownTolerant, Sendable {
        case `do`
        case waitEvent = "wait_event"
        case waitOwner = "wait_owner"
        case waitDecision = "wait_decision"
        case unknown
    }

    public struct NextStep: Decodable, Sendable, Equatable {
        public let kind: StepKind
        public let text: String
        public let waitsOn: String?
        public let by: Author?
    }

    public struct People: Decodable, Sendable, Equatable {
        public let owedTo: [String]?
        public let waitingOn: [String]?
        public let with: [String]?
        public let told: [String]?
    }

    public let id: String
    public let name: String
    public let status: MatterStatus
    public let goal: Goal?
    public let nextStep: NextStep?
    public let people: People?
    public let areas: [String]?
    public let lastStepAt: Date?
    /// The id of the registered agent working on it.
    public let agent: String?
}

/// `read_matters`: the running matters, most pressing first.
public struct MatterList: Decodable, Sendable, Equatable {
    public let matters: [MatterRow]

    /// The matters whose name, goal, next step or people hold `query` (searched on the phone: the list is every running matter).
    public func matching(_ query: String) -> [MatterRow] {
        let query = query.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return matters }
        return matters.filter { row in
            let people = [row.people?.owedTo, row.people?.waitingOn, row.people?.with, row.people?.told].compactMap(
                \.self
            ).flatMap(\.self)
            return ([row.name, row.goal?.text, row.nextStep?.text].compactMap(\.self) + people)
                .contains { $0.localizedStandardContains(query) }
        }
    }

    /// The matters `filter` and the search let through, in the list's order.
    public func shown(query: String, filter: MatterFilter) -> [MatterRow] {
        matching(query).filter(filter.passes)
    }

    /// The filter sheet's counts, over every running matter: each area (most matters first), each kind of wait, and the
    /// ones with an agent.
    public var areaCounts: [(area: String, count: Int)] {
        let counts = matters.flatMap { $0.areas ?? [] }.reduce(into: [String: Int]()) { $0[$1, default: 0] += 1 }
        return counts.sorted { ($1.value, $0.key) < ($0.value, $1.key) }.map { ($0.key, $0.value) }
    }
    public var waitCounts: [MatterWait: Int] {
        matters.reduce(into: [:]) { counts, row in if let wait = row.wait { counts[wait, default: 0] += 1 } }
    }
}

/// What a matter waits on, as the filter sheet names it: its next step's kind, or stuck.
public enum MatterWait: String, CaseIterable, Sendable {
    case decision, owner, ready, event, stuck
}

extension MatterRow {
    /// A stuck matter is stuck whatever its next step says; one with no next step waits on nothing known.
    public var wait: MatterWait? {
        if status == .stuck { return .stuck }
        switch nextStep?.kind {
        case .waitDecision?: return .decision
        case .waitOwner?: return .owner
        case .do?: return .ready
        case .waitEvent?: return .event
        case .unknown?, nil: return nil
        }
    }
}

/// The Matters list's three filters: an area, the kinds of wait (any of them), and only matters with an agent.
public struct MatterFilter: Sendable, Equatable {
    public var area: String?
    public var waits: Set<MatterWait> = []
    public var withAgent = false

    public init(area: String? = nil, waits: Set<MatterWait> = [], withAgent: Bool = false) {
        (self.area, self.waits, self.withAgent) = (area, waits, withAgent)
    }

    public var isEmpty: Bool { self == MatterFilter() }

    func passes(_ row: MatterRow) -> Bool {
        (area.map { row.areas?.contains($0) == true } ?? true)
            && (waits.isEmpty || row.wait.map(waits.contains) == true)
            && (!withAgent || row.agent != nil)
    }
}

/// One step of a matter, in time order: an episode, an observation or a to-do item.
public struct MatterStep: Decodable, Sendable, Equatable, Identifiable {
    public enum Ended: String, UnknownTolerant, Sendable {
        case record, ticked, link
        case unknown
    }

    public struct Ending: Decodable, Sendable, Equatable {
        public let at: Date
        public let by: Ended
        public let why: String?
        public let quote: String?
    }

    public var id: String { ref }
    public let ref: String
    public let at: Date
    public let day: String
    /// `episode`, `todo_item`, or an observation's type: Life adds kinds, so it stays text.
    public let kind: String
    public let text: String
    public let quote: String
    public let when: String?
    public let with: String?
    public let ending: Ending?
}

/// `read_matter`: a matter in full.
public struct Matter: Decodable, Sendable, Equatable {
    public let row: MatterRow
    public let steps: [MatterStep]
    public let agents: [RegisteredAgent]

    private enum Key: String, CodingKey { case steps, agents }

    public init(from decoder: any Decoder) throws {
        row = try MatterRow(from: decoder)
        let container = try decoder.container(keyedBy: Key.self)
        steps = try container.decode([MatterStep].self, forKey: .steps)
        agents = try container.decode([RegisteredAgent].self, forKey: .agents)
    }
}
