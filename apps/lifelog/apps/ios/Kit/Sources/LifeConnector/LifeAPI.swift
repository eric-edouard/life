import Foundation

/// His answer to one check (`answer_check`'s arguments).
public struct AnswerRequest: Encodable, Sendable, Equatable {
    public var ref: String
    public var options: [String]
    public var note: String?
    public var person: String?
    public var name: String?

    public init(ref: String, options: [String], note: String? = nil, person: String? = nil, name: String? = nil) {
        (self.ref, self.options, self.note, self.person, self.name) = (ref, options, note, person, name)
    }
}

/// His word about a registered agent (`change_registered_agent`'s arguments).
public struct AgentRequest: Encodable, Sendable, Equatable {
    public enum Action: String, Encodable, Sendable { case start, stop, resume, changeModel = "change_model" }

    public var action: Action
    public var agent: String?
    /// A matter's id: the subject of a start.
    public var step: String?
    public var runtime: String?
    public var model: String?
    public var effort: String?
    /// His own words; a start's are its brief.
    public var said: String

    public init(
        action: Action, agent: String? = nil, step: String? = nil, runtime: String? = nil, model: String? = nil,
        effort: String? = nil, said: String
    ) {
        (self.action, self.agent, self.step, self.runtime) = (action, agent, step, runtime)
        (self.model, self.effort, self.said) = (model, effort, said)
    }
}

/// A matter's next step as `correct_memory` takes it.
public struct NextStepRequest: Encodable, Sendable, Equatable {
    public var kind: String
    public var text: String
    public var waitsOn: String?

    public init(kind: String, text: String, waitsOn: String? = nil) {
        (self.kind, self.text, self.waitsOn) = (kind, text, waitsOn)
    }
}

/// Life's connector, typed: the one place tool names appear. Each gives the tool's JSON text, which `LibraryStore.feedDecoder` reads into
/// the models and `ReadCache` keeps as it came. An action gives its progress messages to `onProgress` and takes the key of his tap.
public protocol LifeAPI: Sendable {
    func readInbox() async throws -> String
    func readMatters() async throws -> String
    func readMatter(_ id: String) async throws -> String
    func readRegisteredAgents() async throws -> String

    func answerCheck(_ answer: AnswerRequest, answerKey: String, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    func changeAgent(_ change: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String
    /// His goal and/or next step for the matter whose steps are `steps` (every step id `read_matter` lists).
    func setMatterDirection(steps: [String], goal: String?, nextStep: NextStepRequest?) async throws -> String
    /// His word that these observations (a matter's open steps) are done.
    func markDone(observations: [String], note: String) async throws -> String
    /// Ticks (or unticks) one of his to-do items.
}

public struct MCPLifeAPI: LifeAPI {
    private let client: MCPClient

    public init(client: MCPClient) {
        self.client = client
    }

    /// Every card in one read (the server's most), so a tapped push finds its card and the screens count them all.
    public func readInbox() async throws -> String { try await client.call("read_inbox", ["limit": 500]) }
    public func readMatters() async throws -> String { try await client.call("read_matters") }
    public func readMatter(_ id: String) async throws -> String { try await client.call("read_matter", ["id": id]) }
    public func readRegisteredAgents() async throws -> String { try await client.call("read_registered_agents") }

    public func answerCheck(
        _ answer: AnswerRequest, answerKey: String, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        try await client.call("answer_check", answer, answerKey: answerKey, onProgress: onProgress)
    }

    public func changeAgent(_ change: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws
        -> String
    {
        try await client.call("change_registered_agent", change, onProgress: onProgress)
    }

    public func setMatterDirection(steps: [String], goal: String?, nextStep: NextStepRequest?) async throws -> String {
        struct Direction: Encodable {
            let kind = "matter-direction"
            let steps: [String]
            let goal: String?
            let nextStep: NextStepRequest?
        }
        return try await correct(Direction(steps: steps, goal: goal, nextStep: nextStep))
    }

    public func markDone(observations: [String], note: String) async throws -> String {
        struct Outdated: Encodable {
            let kind = "outdated"
            let observations: [String]
            let note: String
        }
        return try await correct(Outdated(observations: observations, note: note))
    }

    private struct Correct<C: Encodable & Sendable>: Encodable, Sendable {
        let kind = "memory"
        let correction: C
    }

    private func correct(_ correction: some Encodable & Sendable) async throws -> String {
        return try await client.call("correct_memory", Correct(correction: correction))
    }
}
