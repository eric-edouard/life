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
    public enum Action: String, Encodable, Sendable {
        case start, stop, resume
        case changeModel = "change_model"
        case handOver = "hand_over"
        /// Opens its session on his Mac (pi in Terminal, Claude in his Claude app); its wakes wait until he closes it.
        case continueOnMac = "continue_on_mac"
    }

    public var action: Action
    /// The agent acted on; with `hand_over` and a `step`, the agent the matter moves to.
    public var agent: String?
    /// A matter's id: the subject of a start, or of a matter move.
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
    /// Why, in Markdown with `life:` links, as a card's context; absent when his edit gives none.
    public var context: String?

    public init(kind: String, text: String, waitsOn: String? = nil, context: String? = nil) {
        (self.kind, self.text, self.waitsOn, self.context) = (kind, text, waitsOn, context)
    }
}

/// Life's connector, typed: the one place tool names appear. Each gives the tool's JSON text, which `LibraryStore.feedDecoder` reads into
/// the models and `ReadCache` keeps as it came. An action gives its progress messages to `onProgress` and takes the key of his tap.
/// The versioned reads (`VersionedRead`) take `ifNot`, the version held: Life then answers only `{version, unchanged:
/// true}` while nothing changed.
public protocol LifeAPI: Sendable {
    func readInbox(ifNot: String?) async throws -> String
    /// The card a push names, from the Life at `origin` (nil: the one paired now).
    func readInbox(pushId: String, at origin: URL?) async throws -> String
    func readMatters(ifNot: String?) async throws -> String
    /// A project chip's matters.
    func readMatters(project: String, ifNot: String?) async throws -> String
    /// An area chip's matters: those of the area in no project.
    func readMatters(area: String, ifNot: String?) async throws -> String
    /// The Projects tab's chips (`ProjectChips`).
    func readProjects(ifNot: String?) async throws -> String
    /// A project chip's header and Details (`ProjectHeader`).
    func readProject(_ id: String, ifNot: String?) async throws -> String
    /// The matters open with one person or organization, by their ref (`person:ana`), every one.
    func readMatters(person: String) async throws -> String
    func readMatter(_ id: String) async throws -> String
    func readRegisteredAgents() async throws -> String
    /// What Life costs this month (`ModelSpending`), his token only.
    func readSpending() async throws -> String
    /// An agent's session on pi, read-only (`AgentSession`), his token only.
    func readAgentSession(_ id: String) async throws -> String
    /// What a `life:` link names, opened by its ref: Life's text, or a person's read as JSON (`LifeLinkRead`).
    func fetch(_ ref: String) async throws -> String
    /// The pictures these ids name (a party's `picture.id`), at most 64 (`PictureCache`).
    func readPersonPictures(_ ids: [String]) async throws -> String
    /// The people and organizations Life knows, closest first.
    func readPeopleAndOrganizations() async throws -> String
    /// One part of a read by its ref (`person:<id>/now`, `…/latest/before/<day>`, `…/page`), as `fetch` opens it.
    func readPart(_ ref: String) async throws -> String
    /// A page of Life's log, newest first (`LogPage`), for the Live logs page.
    func readLogLines(_ query: LogQuery) async throws -> String

    /// His answer, to the Life it was decided for (`origin`, a `PairedLife`'s) and no other.
    func answerCheck(
        _ answer: AnswerRequest, answerKey: String, at origin: URL, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
    func changeAgent(_ change: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String
    /// His goal and/or next step for a matter, by its id: Life pins it to the matter's steps.
    func setMatterDirection(
        matter: String, goal: String?, nextStep: NextStepRequest?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
    /// His icon for a matter, by its id (a key of `MatterIcons`), or nil: Life picks again.
    func setMatterIcon(matter: String, icon: String?, onProgress: @escaping @Sendable (Data) -> Void) async throws
        -> String
    /// His word that a matter is done, by its id: Life closes what of it is open.
    func markDone(matter: String, note: String, dropped: Bool, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    /// His one mark on a matter, on or off, by its id: Life pins it to the matter's steps.
    func setImportant(matter: String, _ important: Bool, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    /// A project's status by his tap, `said` in his words: an edit of its entry in his directory.
    func setProjectStatus(
        _ project: String, _ status: ProjectStatus, said: String, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
    /// His picture pick for a person's or an organization's entry in his directory (`ref`, `person:<id>`): a source's
    /// name, `contacts` or `none`, `said` in his words: an edit of that entry.
    func setPicture(
        of ref: String, kind: Party.Kind, from source: String, said: String,
        onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
    /// An appointment Life added to his calendar, by its push's `pushId` or its own id (one of the two), from the Life at
    /// `origin` (nil: the one paired now).
    func readAppointment(_ key: AppointmentKey, at origin: URL?) async throws -> String
    /// His Remove (`isOn` false) or Undo (`isOn` true) of one, from the Life at `origin`.
    func changeAppointment(_ appointment: String, isOn: Bool, at origin: URL?) async throws -> String
    /// Ask Life: his `words` (none: he is on the screen, keep the session warm) and his screen's refs to Life's main
    /// session. Its lines stream to `onProgress`; the call ends on its answer.
    func askMainSession(
        words: String?, screen: MainSessionScreen?, answerKey: String?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String
}

/// How `read_appointments` names one: by its push's id, or its own.
public enum AppointmentKey: Sendable, Hashable, Identifiable {
    case pushId(String)
    case appointment(String)

    public var id: String {
        switch self {
        case .pushId(let id): "push-\(id)"
        case .appointment(let id): id
        }
    }
}

public struct MCPLifeAPI: LifeAPI {
    private let client: MCPClient

    public init(client: MCPClient) {
        self.client = client
    }

    /// Every open ask in one read (the server's most), so a tapped push finds its card and the screens count them all.
    public func readInbox(ifNot: String?) async throws -> String {
        try await client.call("read_inbox", Versioned(limit: 500, ifNot: ifNot))
    }
    /// Only the card a push names (none once answered), with the inbox's counts: what a notification reads, and what the
    /// app reads first when a push is tapped.
    public func readInbox(pushId: String, at origin: URL?) async throws -> String {
        try await client.call("read_inbox", ["pushId": pushId], at: origin)
    }
    public func readMatters(ifNot: String?) async throws -> String {
        try await client.call("read_matters", Versioned(ifNot: ifNot))
    }
    public func readMatters(project: String, ifNot: String?) async throws -> String {
        try await client.call("read_matters", Versioned(project: project, ifNot: ifNot))
    }
    public func readMatters(area: String, ifNot: String?) async throws -> String {
        try await client.call("read_matters", Versioned(area: area, noProject: true, ifNot: ifNot))
    }
    public func readProjects(ifNot: String?) async throws -> String {
        try await client.call("read_projects", Versioned(ifNot: ifNot))
    }
    public func readProject(_ id: String, ifNot: String?) async throws -> String {
        try await client.call("read_project", Versioned(project: id, ifNot: ifNot))
    }
    public func readMatters(person: String) async throws -> String {
        // Life's `person` takes a name, alias or id: the ref's id (`ana`), never the ref itself.
        let id = person.hasPrefix("person:") ? String(person.dropFirst("person:".count)) : person
        return try await client.call("read_matters", ["person": id])
    }
    public func readMatter(_ id: String) async throws -> String { try await client.call("read_matter", ["id": id]) }
    public func readRegisteredAgents() async throws -> String { try await client.call("read_registered_agents") }
    public func readSpending() async throws -> String { try await client.call("read_spending") }
    public func readAgentSession(_ id: String) async throws -> String {
        try await client.call("read_agent_session", ["id": id])
    }
    public func fetch(_ ref: String) async throws -> String { try await client.call("fetch", ["id": ref]) }
    public func readPersonPictures(_ ids: [String]) async throws -> String {
        try await client.call("read_person_pictures", ["ids": ids])
    }
    public func readPeopleAndOrganizations() async throws -> String {
        try await client.call("read_people_and_organizations")
    }
    public func readPart(_ ref: String) async throws -> String { try await client.call("fetch", ["id": ref]) }
    public func readLogLines(_ query: LogQuery) async throws -> String {
        try await client.call("read_log_lines", query)
    }

    public func answerCheck(
        _ answer: AnswerRequest, answerKey: String, at origin: URL, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        try await client.call("answer_check", answer, answerKey: answerKey, at: origin, onProgress: onProgress)
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

    public func markDone(matter: String, note: String, dropped: Bool, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    {
        struct Outdated: Encodable {
            let kind = "outdated"
            let matter: String
            let note: String
            /// "dropped": it won't be done (its to-do items removed, not ticked).
            let outcome: String?
        }
        return try await correct(
            Outdated(matter: matter, note: note, outcome: dropped ? "dropped" : nil), onProgress)
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

    public func setPicture(
        of ref: String, kind: Party.Kind, from source: String, said: String,
        onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        struct Edit: Encodable {
            let kind: String
            let action = "edit"
            let id: String
            let pictureFrom: String
            let said: String
        }
        let edit = Edit(
            kind: kind == .organization ? "organization" : "person", id: String(ref.trimmingPrefix("person:")),
            pictureFrom: source, said: said)
        return try await client.call("change_directory_entry", edit, onProgress: onProgress)
    }

    public func readAppointment(_ key: AppointmentKey, at origin: URL?) async throws -> String {
        let arguments =
            switch key {
            case .pushId(let id): ["pushId": id]
            case .appointment(let id): ["appointment": id]
            }
        return try await client.call("read_appointments", arguments, at: origin)
    }

    public func changeAppointment(_ appointment: String, isOn: Bool, at origin: URL?) async throws -> String {
        try await client.call(
            "change_appointment", ["action": isOn ? "restore" : "remove", "appointment": appointment], at: origin)
    }

    public func askMainSession(
        words: String?, screen: MainSessionScreen?, answerKey: String?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        struct Ask: Encodable, Sendable {
            let words: String?
            let screen: MainSessionScreen?
        }
        // Even his presence takes the stream's 15 s idle limit: a cold session opens in about 8.
        return try await client.call(
            "ask_main_session", Ask(words: words, screen: screen), answerKey: answerKey, onProgress: onProgress)
    }

    /// A versioned read's arguments; those left nil are not sent.
    private struct Versioned: Encodable, Sendable {
        var limit: Int?
        var project: String?
        var area: String?
        var noProject: Bool?
        let ifNot: String?
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
