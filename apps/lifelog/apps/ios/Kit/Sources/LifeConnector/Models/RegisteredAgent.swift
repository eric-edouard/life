import Foundation
import Library

public enum AgentStatus: String, UnknownTolerant, Sendable {
    case running, waiting, stopped, ended
    case handedOver = "handed_over"
    case unknown
}

/// The runtime an agent works in, by the desk's own name for it (`RuntimeName` in `core/names.ts`, checked by `ContractTests`).
public enum RuntimeName: String, UnknownTolerant, Sendable {
    case claude, codex
    case unknown

    /// What the owner reads: the app's name for the runtime.
    public var name: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .unknown: "its runtime"
        }
    }

    /// A model the desk takes for this runtime: its id, and the runtime's own name for it.
    public struct Model: Sendable, Equatable, Hashable {
        public let id: String
        public let name: String
    }

    /// What the Start sheet lists; none chosen leaves the desk's own default for the runtime.
    /// Refresh here: Codex's from `codex debug models` (the visible list), Claude Code's are the aliases `claude --model` takes.
    public var models: [Model] {
        switch self {
        case .claude:
            [Model(id: "opus", name: "Opus"), Model(id: "sonnet", name: "Sonnet"), Model(id: "haiku", name: "Haiku")]
        case .codex:
            [
                Model(id: "gpt-6.2-astra", name: "GPT-6.2 Astra"), Model(id: "gpt-6.2-sol", name: "GPT-6.2 Sol"),
                Model(id: "gpt-6-luna", name: "GPT-6 Luna"),
            ]
        case .unknown: []
        }
    }

    /// What the Start sheet offers (DSH is out of v1).
    public static let offered: [RuntimeName] = [.claude, .codex]
}

/// A registered agent as the desk reads it now (`read_registered_agents`, and `agents` of `read_matter`).
public struct RegisteredAgent: Decodable, Sendable, Equatable, Identifiable {
    public struct Wait: Decodable, Sendable, Equatable {
        public let reason: String
        public let until: Date
        public let isDefault: Bool
    }

    public struct Turn: Decodable, Sendable, Equatable {
        public let startedAt: Date
        public let endedAt: Date?
        public let outcome: String?
    }

    public struct Matter: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let status: MatterStatus
    }

    public let id: String
    public let title: String
    public let status: AgentStatus
    public let runtime: String
    public let model: String?
    public let effort: String?
    public let link: String?
    public let notes: String
    public let outcome: String?
    /// Why its first turn never began (it was ended); nil when it began.
    public let notStarted: String?
    public let project: String?
    /// The matter its first anchor finds, when its subject is one (not in a matter's own `agents`).
    public let matter: Matter?
    public let wait: Wait?
    /// Since when it has been in its status; nil when the desk has no date.
    public let statusSince: Date?
    /// What will wake it while it waits, in its own order; none otherwise.
    public let wakesOn: [WakeLine]
    public let lastTurn: Turn?
    public let amber: [String]

    public var runtimeName: RuntimeName { RuntimeName(rawValue: runtime) ?? .unknown }
    /// Ended or handed over: it holds nothing, and its matter can start another.
    public var isOver: Bool { status == .ended || status == .handedOver }
}

/// `read_registered_agents`: what the desk keeps, and whether it is on and its helper runs.
public struct RegisteredAgents: Decodable, Sendable, Equatable {
    public enum Desk: String, UnknownTolerant, Sendable {
        case ok, off, unreadable
        case unknown
    }

    public enum Helper: String, UnknownTolerant, Sendable {
        case running
        case notRunning = "not running"
        case unknown
    }

    public let agents: [RegisteredAgent]
    public let desk: Desk
    public let helper: Helper
    public let why: String?
}
