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
/// His icon for a matter as `correct_memory` takes it: a nil icon is sent as `null` (Life picks again), never dropped,
/// or Life would refuse the line.
private struct MatterIconRequest: Encodable, Sendable {
    let matter: String
    let icon: String?

    private enum Key: String, CodingKey { case kind, matter, icon }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode("matter-icon", forKey: .kind)
        try container.encode(matter, forKey: .matter)
        try container.encode(icon, forKey: .icon)
    }
}

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
    func readInbox(pushId: String) async throws -> String
    func readMatters() async throws -> String
    /// One project's matters, with its page's head.
    func readMatters(project: String) async throws -> String
    /// The matters open with one person or organization, by ref, every one.
    func readMatters(person: String) async throws -> String
    func readMatter(_ id: String) async throws -> String
    func readRegisteredAgents() async throws -> String
    /// The pictures these ids name (a party's `picture.id`), at most 64 (`PictureCache`).
    func readPersonPictures(_ ids: [String]) async throws -> String
    /// The people and organizations Life knows, closest first; with a query, the ones it matches and `others`.
    func readPeopleAndOrganizations(query: String?) async throws -> String
    /// One part of a read by its ref (`person:<id>/now`, `…/latest/before/<day>`, `…/page`), as `fetch` opens it.
    func readPart(_ ref: String) async throws -> String

    func answerCheck(_ answer: AnswerRequest, answerKey: String, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    func changeAgent(_ change: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String
    /// His goal and/or next step for a matter, by its id: Life pins it to the matter's steps.
    func setMatterDirection(
        matter: String, goal: String?, nextStep: NextStepRequest?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
    /// His icon for a matter, by its id (a key of `MatterIcons`), or nil: Life picks again.
    func setMatterIcon(matter: String, icon: String?, onProgress: @escaping @Sendable (Data) -> Void) async throws
        -> String
    /// His word that a matter is done, by its id: Life closes what of it is open.
    func markDone(matter: String, note: String, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String
    /// His one mark on a matter, on or off, by its id: Life pins it to the matter's steps.
    func setImportant(matter: String, _ important: Bool, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    /// A project's status by his tap, `said` in his words: an edit of its entry in his directory.
    func setProjectStatus(
        _ project: String, _ status: ProjectStatus, said: String, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
}

public struct MCPLifeAPI: LifeAPI {
    private let client: MCPClient

    public init(client: MCPClient) {
        self.client = client
    }

    /// Every open ask in one read (the server's most), so a tapped push finds its card and the screens count them all.
    public func readInbox() async throws -> String { try await client.call("read_inbox", ["limit": 500]) }
    /// Only the card a push names (none once answered), with the inbox's counts: what a notification reads, and what the
    /// app reads first when a push is tapped.
    public func readInbox(pushId: String) async throws -> String {
        try await client.call("read_inbox", ["pushId": pushId])
    }
    public func readMatters() async throws -> String { try await client.call("read_matters") }
    public func readMatters(project: String) async throws -> String {
        try await client.call("read_matters", ["project": project])
    }
    public func readMatters(person: String) async throws -> String {
        try await client.call("read_matters", ["person": person])
    }
    public func readMatter(_ id: String) async throws -> String { try await client.call("read_matter", ["id": id]) }
    public func readRegisteredAgents() async throws -> String { try await client.call("read_registered_agents") }
    public func readPersonPictures(_ ids: [String]) async throws -> String {
        try await client.call("read_person_pictures", ["ids": ids])
    }
    public func readPeopleAndOrganizations(query: String?) async throws -> String {
        try await client.call("read_people_and_organizations", query.map { ["query": $0] } ?? [:])
    }
    public func readPart(_ ref: String) async throws -> String { try await client.call("fetch", ["id": ref]) }

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

    public func setMatterDirection(
        matter: String, goal: String?, nextStep: NextStepRequest?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        struct Direction: Encodable {
            let kind = "matter-direction"
            let matter: String
            let goal: String?
            let nextStep: NextStepRequest?
        }
        return try await correct(Direction(matter: matter, goal: goal, nextStep: nextStep), onProgress)
    }

    public func setMatterIcon(matter: String, icon: String?, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    {
        try await correct(MatterIconRequest(matter: matter, icon: icon), onProgress)
    }

    public func markDone(matter: String, note: String, onProgress: @escaping @Sendable (Data) -> Void) async throws
        -> String
    {
        struct Outdated: Encodable {
            let kind = "outdated"
            let matter: String
            let note: String
        }
        return try await correct(Outdated(matter: matter, note: note), onProgress)
    }

    public func setImportant(matter: String, _ important: Bool, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    {
        struct Mark: Encodable {
            let kind = "matter-important"
            let matter: String
            let important: Bool
        }
        return try await correct(Mark(matter: matter, important: important), onProgress)
    }

    public func setProjectStatus(
        _ project: String, _ status: ProjectStatus, said: String, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        struct Edit: Encodable {
            let kind = "project"
            let action = "edit"
            let id: String
            let status: ProjectStatus
            let said: String
        }
        return try await client.call(
            "change_directory_entry", Edit(id: project, status: status, said: said), onProgress: onProgress)
    }

    private struct Correct<C: Encodable & Sendable>: Encodable, Sendable {
        let kind = "memory"
        let correction: C
    }

    private func correct(_ correction: some Encodable & Sendable, _ onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    {
        try await client.call("correct_memory", Correct(correction: correction), onProgress: onProgress)
    }
}
