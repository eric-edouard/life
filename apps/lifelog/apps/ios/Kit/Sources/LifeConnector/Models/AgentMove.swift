import Foundation
import Library

/// Where a move stands (decision 78: a matter move or a runtime switch), as Life works it out when read (`movePhaseOf`,
/// `host/move-read.ts`): the old agent writing its notes, the new holder starting, done, or failed (refused, or rolled
/// back: the old holder holds it).
public enum MovePhase: String, UnknownTolerant, Sendable {
    case notes, starting, done, failed
    case unknown

    public var isUnderWay: Bool { self == .notes || self == .starting }
}

/// A move as a read shows it, while under way and for an hour after: a matter move's `move`, or a runtime switch's
/// `switch` (with how many of its matters' notes are written, `done` of `total`, while in `notes`), and why it failed.
public struct AgentMove: Decodable, Sendable, Equatable {
    public let id: String
    public let phase: MovePhase
    public let reason: String?
    public let done: Int?
    public let total: Int?

    public init(id: String, phase: MovePhase, reason: String? = nil, done: Int? = nil, total: Int? = nil) {
        (self.id, self.phase, self.reason, self.done, self.total) = (id, phase, reason, done, total)
    }

    /// The move a screen shows. With his `receipt`: the read's move of its id; else its ask refused before the desk
    /// wrote a move (`refused`), failed with the desk's words; else asked and not applied yet, as its notes, for
    /// `MoveReceipt.patience`. Past that, or with none, the read's own move (one asked from another app shows too), so
    /// a page opened after the move's hour, or after a newer move, never waits on it. A receipt whose id was lost
    /// (`id` nil) takes the read's move under way as its own.
    public static func shown(
        receipt: MoveReceipt?, read: AgentMove?, refused: [RegisteredAgents.Refusal], now: Date
    ) -> AgentMove? {
        guard let receipt else { return read }
        guard let id = receipt.id else {
            if read?.phase.isUnderWay == true { return read }
            return receipt.isPending(now) ? AgentMove(id: "", phase: .notes) : read
        }
        if read?.id == id { return read }
        if let refusal = refused.first(where: { $0.ask == id }) {
            return AgentMove(id: id, phase: .failed, reason: refusal.error)
        }
        return receipt.isPending(now) ? AgentMove(id: id, phase: .notes) : read
    }
}

/// His move as Life answered his tap (`hand_over`'s `move`, the ask's id), and when; nil when the answer was lost
/// though the ask may have reached Life.
public struct MoveReceipt: Sendable, Equatable {
    /// How long an ask the reads don't show yet counts as under way: the desk applies it within its 5 s tick.
    public static let patience: TimeInterval = 60

    public let id: String?
    public let at: Date

    public init(id: String?, at: Date) { (self.id, self.at) = (id, at) }

    func isPending(_ now: Date) -> Bool { now.timeIntervalSince(at) < Self.patience }

    /// What a read's `shown` move (`AgentMove.shown` over it) settles of this receipt, once, as the read lands.
    public enum Settled: Equatable, Sendable {
        /// Still waiting on the reads.
        case kept
        /// A lost id found: the read's move under way is his.
        case found(MoveReceipt)
        /// Done: said once.
        case done
        /// Failed; `say` when only a refusal holds it (the read holds a failed move itself for its hour).
        case failed(say: String?)
        /// Past its patience with nothing shown: the read's.
        case gone
    }

    public func settled(by shown: AgentMove?, read: AgentMove?) -> Settled {
        guard let shown, shown.id == id || (id == nil && shown.id == read?.id && shown.phase.isUnderWay) else {
            return id == nil && shown?.id == "" ? .kept : .gone
        }
        if id == nil { return .found(MoveReceipt(id: shown.id, at: at)) }
        switch shown.phase {
        case .done: return .done
        case .failed: return .failed(say: read?.id == id ? nil : shown.reason ?? "It did not move.")
        default: return .kept
        }
    }

    /// Why the last move failed, and the move Try again repeats: the one he asked (`tried`), only while it is still
    /// the one offered and nothing may have gone; a move asked elsewhere, or one no longer offered, he picks afresh.
    public static func failure<Choice: Equatable>(
        call: ActionFailure?, shown: AgentMove?, tried: Choice?, offered: Choice?
    ) -> (reason: String, retry: Choice?)? {
        let reason = call?.reason ?? (shown?.phase == .failed ? shown?.reason ?? "It did not move." : nil)
        guard let reason else { return nil }
        let isSafe = call.map(\.canTryAgain) ?? true
        return (reason, isSafe && tried != nil && tried == offered ? tried : nil)
    }
}

/// An agent as a move names it: its id, its name ("Halden house agent"), its short name, its program.
public struct NamedAgent: Decodable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let short: String?
    public let runtime: String

    public var runtimeName: RuntimeName { RuntimeName(rawValue: runtime) ?? .unknown }
}

/// The agent of a matter's open assignment, and the one he moved it from (`movedFrom`), if he did.
public struct MatterHolder: Decodable, Sendable, Equatable {
    public let agent: NamedAgent
    public let movedFrom: NamedAgent?

    private enum Key: String, CodingKey { case movedFrom }

    public init(from decoder: any Decoder) throws {
        agent = try NamedAgent(from: decoder)
        movedFrom = try decoder.container(keyedBy: Key.self).decodeIfPresent(NamedAgent.self, forKey: .movedFrom)
    }
}

/// Why nothing can move to the program the desk offers now (its last look at it).
public struct MoveBlocked: Decodable, Sendable, Equatable {
    public let runtime: String
    public let reason: String
}

/// Where his matter move takes a matter: to a new agent of its own on another program, or back to the agent he moved
/// it from.
public enum MoveChoice: Equatable, Sendable {
    case runtime(RuntimeName)
    case back(agent: String, name: String)
}

extension Matter {
    /// The one move to offer: back to the agent he moved it from while `agents` (`read_registered_agents`) lists it at
    /// work and not the caretaker, as the desk takes one (the old holder is no longer anchored on the matter, so the
    /// matter's own agents can't tell), else to the program the desk offers (`moveTo`); none with no holder, or while it can't run.
    public func moveChoice(among agents: [RegisteredAgent]) -> MoveChoice? {
        guard let holder, moveBlocked == nil else { return nil }
        let isTaker = { (a: RegisteredAgent) in [.running, .waiting].contains(a.status) && a.role != .caretaker }
        if let from = holder.movedFrom, agents.contains(where: { $0.id == from.id && isTaker($0) }) {
            return .back(agent: from.id, name: from.name)
        }
        return moveTo.flatMap(RuntimeName.init(rawValue:)).map { .runtime($0) }
    }
}

/// A move's words, the one place the phone says them (the design of 20 Nov, `move-runtime-2026-11-20.md`).
public enum MoveWords {
    /// The menu's item for `choice`, and its subtitle (none for moving back).
    public static func item(_ choice: MoveChoice) -> (title: String, subtitle: String?) {
        switch choice {
        case .runtime(let runtime): ("Move to \(runtime.name)", "A new agent, until it's done")
        case .back(_, let name): ("Move back to \(name)", nil)
        }
    }

    /// The one ask before a matter move of `matter`, now held by `holder` (its name, "Halden house agent").
    public static func ask(_ choice: MoveChoice, matter: String, holder: String) -> (title: String, message: String) {
        switch choice {
        case .runtime(let runtime):
            (
                "Move \(matter) to \(runtime.name)?",
                "The \(holder) writes its notes first. A new \(runtime.name) agent takes the matter until it's done."
            )
        case .back(_, let name):
            (
                "Move \(matter) back to the \(name)?",
                "The \(holder) writes its notes first. The \(name) takes the matter again until it's done."
            )
        }
    }

    /// What a move under way is doing, on `runtime` (the holder's once it starts): a switch counts the notes it is on.
    public static func underWay(_ move: AgentMove, runtime: RuntimeName) -> String? {
        switch move.phase {
        case .notes:
            if let done = move.done, let total = move.total, total > 1 {
                "Writing notes, \(min(done + 1, total)) of \(total)…"
            } else {
                "Writing its notes…"
            }
        case .starting: "Starting on \(runtime.name)…"
        default: nil
        }
    }

    public static func moved(_ matter: String, to runtime: RuntimeName) -> String {
        "\(matter) moved to \(runtime.name)"
    }

    /// The one ask before `agent` ("Halden house agent") switches to `runtime`.
    public static func switchAsk(_ agent: String, to runtime: RuntimeName) -> (title: String, message: String) {
        (
            "Switch the \(agent) to \(runtime.name)?",
            "It writes its notes on each of its matters, then starts fresh on \(runtime.name). Its cards stay open."
        )
    }

    public static func switched(_ agent: String, to runtime: RuntimeName) -> String {
        "The \(agent) is on \(runtime.name)"
    }
}
