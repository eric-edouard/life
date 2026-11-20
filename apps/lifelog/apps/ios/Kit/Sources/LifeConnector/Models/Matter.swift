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

    /// Its icon: his pick (`owner`) or Life's (`life`); the key stays text (Life may add keys: `MatterIcons.symbol` is nil
    /// for one this app lacks).
    public struct Icon: Decodable, Sendable, Equatable {
        public let by: Author
        public let key: String
    }

    public struct People: Decodable, Sendable, Equatable {
        public let owedTo: [Party]?
        public let waitingOn: [Party]?
        public let with: [Party]?
        public let told: [Party]?
    }

    public let id: String
    public let name: String
    public let status: MatterStatus
    public let goal: Goal?
    /// Absent when neither he nor Life picked one: the phone shows the first area's icon, then the folder.
    public let icon: Icon?
    public let nextStep: NextStep?
    public let people: People?
    public let areas: [String]?
    public let lastStepAt: Date?
    /// The id of the registered agent working on it.
    public let agent: String?
    /// How many open checks about it block him (an agent's decision, a voice, a name); the others only improve the memory.
    public let blockingChecks: Int?
    /// Whether it needs him (Life decides: its next step is his, or a check about it blocks him): the row's dot and the filter.
    public let needsYou: Bool?
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
            ).flatMap(\.self).map(\.name)
            return ([row.name, row.goal?.text, row.nextStep?.text].compactMap(\.self) + people)
                .contains { $0.localizedStandardContains(query) }
        }
    }

    /// The matters `filter` lets through, in the list's order.
    public func shown(filter: MatterFilter) -> [MatterRow] {
        matters.filter(filter.passes)
    }

    /// The filter menu's areas, over every running matter, most matters first.
    public var areasByCount: [String] {
        let counts = matters.flatMap { $0.areas ?? [] }.reduce(into: [String: Int]()) { $0[$1, default: 0] += 1 }
        return counts.sorted { ($1.value, $0.key) < ($0.value, $1.key) }.map(\.key)
    }
}

/// What the Matters list's filter menu chooses: everything, what needs him, what an agent works on, or one area.
public enum MatterFilter: Hashable, Sendable {
    case everything, needsYou, agentWorking
    case area(String)

    func passes(_ row: MatterRow) -> Bool {
        switch self {
        case .everything: true
        case .needsYou: row.needsYou == true
        case .agentWorking: row.agent != nil
        case .area(let area): row.areas?.contains(area) == true
        }
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
    public let with: Party?
    public let ending: Ending?
}

/// `read_matter`: a matter in full.
public struct Matter: Decodable, Sendable, Equatable {
    public let row: MatterRow
    public let steps: [MatterStep]
    public let agents: [RegisteredAgent]
    /// Every open check about it, of every kind (`checksOnMatterOf`, `memory/checks.ts`).
    public let checks: [Check]

    private enum Key: String, CodingKey { case steps, agents, checks }

    public init(from decoder: any Decoder) throws {
        row = try MatterRow(from: decoder)
        let container = try decoder.container(keyedBy: Key.self)
        steps = try container.decode([MatterStep].self, forKey: .steps)
        agents = try container.decode([RegisteredAgent].self, forKey: .agents)
        checks = try container.decode([Check].self, forKey: .checks)
    }
}
