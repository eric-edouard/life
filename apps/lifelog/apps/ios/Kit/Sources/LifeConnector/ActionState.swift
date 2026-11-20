import Foundation

/// One named step of an action, as it passes (`report` on Life's side): its id, when it passed, and what it said.
public struct ActionStep: Sendable, Equatable, Identifiable {
    public var id: String
    public var passedAt: Date?
    public var detail: [String: String] = [:]

    public init(id: String, passedAt: Date? = nil, detail: [String: String] = [:]) {
        (self.id, self.passedAt, self.detail) = (id, passedAt, detail)
    }
}

public enum Retry: Sendable, Equatable {
    case allowed, no
}

/// Why an action ended without its proof, and what the screen may offer.
public struct ActionFailure: Sendable, Equatable {
    /// The step it stopped at: the first of the plan that had not passed.
    public var step: String?
    public var reason: String
    public var retry: Retry
    /// The action may have gone through anyway (a send that may have gone, a start nobody confirmed): never run again blind.
    public var mayHaveHappened = false
    /// The connection failed, so the same tap is repeated with the same key; a result Life gave is a new tap next time.
    public var isSameTap = false
    /// What kind of error ended it (dropped, unreachable, failed, refused), for the phone's log: never Life's words.
    public var kind = "failed"
    /// A send Life refused because someone wrote in the chat since the ask: Life's own word for it, never decided here.
    public var wrote: Wrote?

    public struct Wrote: Decodable, Sendable, Equatable {
        public let at: Date?
        public let by: String?
        public let text: String?
    }

    /// Whether the screen offers the same action again: Life allows it and nothing may have happened. The one rule, for
    /// the result screen and the create sheet alike.
    public var canTryAgain: Bool { retry == .allowed && !mayHaveHappened }

    public init(
        step: String? = nil, reason: String, retry: Retry, mayHaveHappened: Bool = false, isSameTap: Bool = false
    ) {
        (self.step, self.reason, self.retry) = (step, reason, retry)
        (self.mayHaveHappened, self.isSameTap) = (mayHaveHappened, isSameTap)
    }
}

/// Where one action stands, as every screen shows it. Only the server ends an action: past its limit it is `isLate`, still running.
public enum ActionState<Proof: Sendable & Equatable>: Sendable, Equatable {
    case idle
    /// Every step of the plan, passed or pending, and when the server's limit runs out.
    case running(steps: [ActionStep], limit: Date?)
    case succeeded(Proof, steps: [ActionStep])
    case failed(ActionFailure, steps: [ActionStep])

    public enum Event: Sendable {
        case started
        /// The plan of steps to come and the most seconds they may take (Life's first progress message).
        case planned([String], limitSeconds: Double?, at: Date)
        case passed(String, at: Date, detail: [String: String])
        case succeeded(Proof)
        case failed(ActionFailure)
    }

    /// When the server's limit runs out, while it runs.
    public var limit: Date? {
        if case .running(_, let limit) = self { return limit }
        return nil
    }

    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    public var steps: [ActionStep] {
        switch self {
        case .idle: []
        case .running(let steps, _), .succeeded(_, let steps), .failed(_, let steps): steps
        }
    }

    /// Past the server's limit and still running.
    public func isLate(at now: Date) -> Bool {
        guard case .running(_, let limit?) = self else { return false }
        return !(now < limit)
    }

    /// One reducer. A step the plan did not name is appended (a newer server never breaks an older app); a plan after a
    /// plan adds its new steps and keeps the passed ones (a repeated call, or the phone's own step before Life's).
    public mutating func apply(_ event: Event) {
        switch event {
        case .started: self = .running(steps: [], limit: nil)
        case .planned(let ids, let seconds, let at):
            guard case .running(var steps, var limit) = self else { return }
            steps += ids.filter { id in !steps.contains { $0.id == id } }.map { ActionStep(id: $0) }
            if let seconds { limit = at.addingTimeInterval(seconds) }
            self = .running(steps: steps, limit: limit)
        case .passed(let id, let at, let detail):
            guard case .running(var steps, let limit) = self else { return }
            if let index = steps.firstIndex(where: { $0.id == id }) {
                steps[index].passedAt = at
                steps[index].detail = detail
            } else {
                steps.append(ActionStep(id: id, passedAt: at, detail: detail))
            }
            self = .running(steps: steps, limit: limit)
        case .succeeded(let proof): self = .succeeded(proof, steps: steps)
        case .failed(var failure):
            failure.step = failure.step ?? steps.first { $0.passedAt == nil }?.id
            self = .failed(failure, steps: steps)
        }
    }
}

extension ActionFailure {
    /// A call that did not give its answer, as the action it was part of ends. A broken connection leaves the call
    /// possibly run, so it is repeated as the same tap; what Life refused is final.
    public init(_ error: MCPError, step: String? = nil) {
        switch error {
        case .refused, .notPaired, .wrongCode:
            self.init(step: step, reason: error.reason, retry: .no)
            kind = "refused"
        case .timedOut:
            // The tap's key stays (`isSameTap`); no button repeats it.
            self.init(step: step, reason: error.reason, retry: .no, mayHaveHappened: true, isSameTap: true)
            kind = "timedOut"
        default:
            self.init(step: step, reason: error.reason, retry: .allowed, isSameTap: true)
            kind = error == .streamDropped ? "dropped" : error == .unreachable ? "unreachable" : error == .offline ? "offline" : "failed"
        }
    }
}

/// One progress message of Life's: the plan (always first), or a step passed.
public enum ActionProgress: Sendable, Equatable {
    case plan([String], limitSeconds: Double?)
    case step(String, at: Date?, detail: [String: String])

    public init?(_ message: Data) {
        guard let object = (try? JSONSerialization.jsonObject(with: message)) as? [String: Any] else { return nil }
        if let plan = object["plan"] as? [String] {
            self = .plan(plan, limitSeconds: (object["limitSeconds"] as? NSNumber)?.doubleValue)
        } else if let id = object["step"] as? String {
            let at = (object["at"] as? String).flatMap {
                try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse($0)
            }
            let detail = object.filter { $0.key != "step" && $0.key != "at" }.mapValues { "\($0)" }
            self = .step(id, at: at, detail: detail)
        } else {
            return nil
        }
    }

    /// The event for the reducer; `now` stands in for a step with no instant.
    public func event<Proof>(at now: Date) -> ActionState<Proof>.Event {
        switch self {
        case .plan(let ids, let seconds): .planned(ids, limitSeconds: seconds, at: now)
        case .step(let id, let at, let detail): .passed(id, at: at ?? now, detail: detail)
        }
    }
}
