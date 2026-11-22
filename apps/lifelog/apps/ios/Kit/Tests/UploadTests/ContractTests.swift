import Foundation
import Library
import LifeConnector
import Testing

@testable import Upload
import ServerAPI
import Timeline

/// The client against the server's own spec (`apps/server/openapi.json`, kept fresh by the gate): every enum the client
/// mirrors has the spec's values, and every path it calls exists.
private let apps = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

private func spec() throws -> [String: Any] {
    let data = try Data(contentsOf: apps.appending(path: "server/openapi.json"))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// The enum values of a schema, or of a property inside it (an array's items crossed on the way). A nullable enum's
/// `null` is left out.
private func values(_ spec: [String: Any], _ schema: String, _ properties: [String]) throws -> Set<String> {
    let components = try #require(spec["components"] as? [String: Any])
    var node = try #require((components["schemas"] as? [String: Any])?[schema] as? [String: Any])
    for property in properties {
        node = node["items"] as? [String: Any] ?? node
        node = try #require((node["properties"] as? [String: Any])?[property] as? [String: Any])
    }
    return Set(try #require(node["enum"] as? [Any]).compactMap { $0 as? String })
}

@Test func mirroredEnumsMatchTheSpec() throws {
    let spec = try spec()
    /// The Swift cases are the spec's, without the `unknown` fallback unless the server sends it too, and without
    /// the cases only the phone has.
    func mirrors<T: UnknownTolerant>(
        _: T.Type, _ schema: String, _ properties: String..., phoneOnly: Set<String> = []
    ) throws {
        let server = try values(spec, schema, properties)
        let client = Set(T.allCases.map(\.rawValue)).subtracting(phoneOnly)
        #expect((server.contains("unknown") ? client : client.subtracting(["unknown"])) == server, "\(T.self)")
    }
    try mirrors(AppleHealthMeasurement.Stage.self, "SleepStage")
    let components = try #require(spec["components"] as? [String: Any])
    let schemas = try #require(components["schemas"] as? [String: [String: Any]])
    let union = try #require(schemas["Measurement"]?["oneOf"] as? [[String: String]])
    let kinds = try union.flatMap { ref in
        let name = try #require(ref["$ref"]?.split(separator: "/").last.map(String.init))
        return try values(spec, name, ["kind"])
    }
    #expect(Set(kinds) == Set(AppleHealthMeasurement.Kind.allCases.map(\.rawValue)).subtracting(["unknown"]))
    try mirrors(ServerClient.Switches.Engine.self, "Switches", "engine")
    try mirrors(ServerClient.MacLLM.Reason.self, "MacLlm", "reason")
    try mirrors(ConversationKind.self, "FeedConversation", "kind")
    try mirrors(ConversationState.self, "FeedConversation", "state", phoneOnly: ["notUploaded"])
    try mirrors(WaitingReason.self, "FeedConversation", "waiting", "reason")
    try mirrors(CachedEdit.Kind.self, "Feed", "edits", "kind")
    try mirrors(CachedEdit.Source.self, "Feed", "edits", "source")
}

/// Paths are read from the sources: each literal the client passes to `request(`, `send(` or `path =`, or sends on its
/// own line with a method, and each one the health outbox is given. Interpolations become `{}`, as the spec's
/// parameters do.
@Test func everyPathTheClientCallsExists() throws {
    let paths = try #require(try spec()["paths"] as? [String: Any]).keys.map {
        String($0.dropFirst()).replacing(/\{[A-Za-z]+\}/, with: "{}")
    }
    let read = { (file: String) in try String(contentsOf: apps.appending(path: "ios/\(file)"), encoding: .utf8) }
    let folder = apps.appending(path: "ios/Kit/Sources/ServerAPI")
    let client = try FileManager.default.contentsOfDirectory(atPath: folder.path()).sorted()
        .map { try read("Kit/Sources/ServerAPI/\($0)") }.joined()
    let outbox = try [
        "Kit/Sources/Health/ErrorReporter.swift", "Kit/Sources/Health/EventReporter.swift",
        "Lifelog/HealthReporter.swift",
    ].map(read).joined()
    let call =
        /(?:request\(|send\(|path = |= \("(?:GET|POST|PUT|PATCH|DELETE)", |\n\s+)"([a-z][A-Za-z\/\\()-]*)"(?=\)|, method:|,|\n)/
    let queued = /path: "([a-z][a-z\/-]*)", urgent/
    let literals = client.matches(of: call).map(\.output.1) + outbox.matches(of: queued).map(\.output.1)
    let called = Set(literals.map { String($0).replacing(/\\\([a-z][A-Za-z]*(?:\([a-z]+\))?\)/, with: "{}") })
    #expect(called.count > 12, "the parser still finds the client's calls")
    #expect(called.subtracting(paths).isEmpty, "\(called.subtracting(paths).sorted())")
}

/// The runtimes the Start sheet offers are the ones the server names (`RuntimeName`, `core/names.ts`), each lists at least
/// one model to launch with, and a runtime the app does not know reads as `unknown`, never a failure.
@Test func runtimeNamesAreTheServers() throws {
    let source = try String(
        contentsOf: apps.deletingLastPathComponent().deletingLastPathComponent().appending(
            path: "server/src/core/names.ts"), encoding: .utf8)
    let named = try #require(source.firstMatch(of: /RuntimeName = z\.enum\(\[([^\]]*)\]\)/)).output.1
    let server = Set(named.matches(of: /"([a-z]+)"/).map { String($0.output.1) })
    #expect(server == Set(RuntimeName.offered.map(\.rawValue)))
    #expect(RuntimeName.offered.allSatisfy { !$0.models.isEmpty })
    #expect(RuntimeName(rawValue: "dsh") == nil)
    #expect(try JSONDecoder().decode(RuntimeName.self, from: Data(#""dsh""#.utf8)) == .unknown)
}

/// Life's enums the phone decodes are the ones Life's server writes (`apps/server/src`), read from its sources: a new value
/// there fails here, instead of reading as `unknown` on the phone (an agent shown "Waiting").
@Test func lifesEnumsAreTheServers() throws {
    let server = apps.deletingLastPathComponent().deletingLastPathComponent().appending(path: "server/src")
    func source(_ file: String) throws -> String {
        try String(contentsOf: server.appending(path: file), encoding: .utf8)
    }
    /// The quoted words of the first match of `block` in `file`.
    func quoted(_ file: String, _ block: Regex<(Substring, Substring)>) throws -> Set<String> {
        let found = try #require(try source(file).firstMatch(of: block), "\(file)").output.1
        return Set(found.matches(of: /"([a-z_ ]+)"/).map { String($0.output.1) })
    }
    /// Every value `file` gives a `state` its answer carries.
    func states(_ file: String) throws -> Set<String> {
        Set(try source(file).matches(of: /state(?: =|:) "([a-z_]+)"/).map { String($0.output.1) })
    }
    func client<T: UnknownTolerant>(_: T.Type) -> Set<String> {
        Set(T.allCases.map(\.rawValue)).subtracting(["unknown"])
    }

    #expect(try quoted("core/names.ts", /CheckGroup = z\.enum\(\[([^\]]*)\]/) == client(CheckGroup.self))
    #expect(try quoted("memory/life-checks.ts", /takes: ([^;]*);/) == client(Check.Option.Takes.self))
    #expect(try quoted("memory/check-urgency.ts", /export type Urgency = ([^;]*);/) == client(Urgency.self))
    // A recent message's file: `KINDS`' kinds, else a document.
    #expect(
        try quoted("memory/message-files.ts", /const KINDS([^;]*);/).union(["document"]) == client(FileKind.self))
    // On Life's own checks and on a decision's options alike.
    #expect(try quoted("memory/life-checks.ts", /ends\?: ([^;]*);/) == client(Check.Option.Ends.self))
    #expect(try quoted("memory/card-request.ts", /ends: z\.enum\(\[([^\]]*)\]/) == client(Check.Option.Ends.self))
    // The answer icons: Life's acts and the rest, one set.
    #expect(
        try quoted("records/answer-icon.ts", /(?s)LIFE_ACT_ICONS = \[(.*?)\] as const/)
            .union(try quoted("records/answer-icon.ts", /(?s)ANSWER_ICONS = \[(.*?)\] as const/))
            == client(AnswerIcon.self))
    let needs = try source("memory/needs.ts")
    let kinds = Set(needs.matches(of: /kind: z\.literal\("([a-z]+)"\)/).map { String($0.output.1) })
    #expect(kinds == client(Check.Need.Kind.self))
    #expect(try quoted("memory/needs.ts", /scheme: z\s*\.enum\(\[([^\]]*)\]/) == client(Check.Need.Scheme.self))
    #expect(try quoted("memory/life-checks.ts", /doneSeenBy\?: ([^;]*);/) == client(Check.DoneSeenBy.self))
    // Life's stored outcome; `looking` is the phone's while `answer_check` runs (its live step).
    #expect(
        try quoted("memory/decision-lines.ts", /state: z\.enum\(\[([^\]]*)\]/).union(["looking"])
            == client(Check.DoneSeen.State.self))
    // Ask Life's wire: every kind of line and of answer the session sends is one the phone draws or says it can't.
    let wire = try source("records/main-session-wire.ts")
    let sent = Set(wire.matches(of: /kind: "([a-z]+)"/).map { String($0.output.1) })
    #expect(
        sent == [
            "reply", "question", "error", "done", "agent", "card", "fix", "thinking", "working", "words", "answer",
        ])
    #expect(try quoted("memory/matter-read.ts", /const STATUSES = \[([^\]]*)\]/) == client(MatterStatus.self))
    #expect(
        try quoted("host/appointments-calendar.ts", /(?s)type Changed =(.*?)\};/)
            == client(AppointmentChange.Result.self))
    #expect(try quoted("records/truth.ts", /status: z\.enum\(\[([^\]]*)\]/) == client(ProjectStatus.self))
    // `wait_decision` is worked out when read (`nextStepNow`), never stored.
    #expect(
        try quoted("records/matter.ts", /NextStepKind = z\.enum\(\[([^\]]*)\]/).union(["wait_decision"])
            == client(MatterRow.StepKind.self))
    #expect(try quoted("memory/matter-read.ts", /(?s)type StepEnding = (.*?)\n\);/) == client(MatterStep.Ended.self))
    #expect(try quoted("memory/matter-read.ts", /export type ByWhom<T> = T & \{([^}]*)\}/) == client(Author.self))
    // An agent as read: the stored statuses, with `active` read as running or waiting.
    let stored = try quoted("records/registered-agent.ts", /export type AgentStatus = ([^;]*);/)
    #expect(stored.subtracting(["active"]).union(["running", "waiting"]) == client(AgentStatus.self))
    let roles = try quoted("core/names.ts", /AgentRole = z\.enum\(\[([^\]]*)\]/)
    #expect(roles == client(RegisteredAgent.Role.self))
    #expect(try states("host/answer-result.ts") == client(AnswerResult.SendState.self))
    #expect(try states("host/change-registered-agent.ts") == client(AgentChangeResult.State.self))
    // A move's phase, worked out when read (`movePhaseOf`).
    let phases = try source("host/move-read.ts").matches(of: /phase: "([a-z]+)" as const/).map { String($0.output.1) }
    #expect(Set(phases) == client(MovePhase.self))
    #expect(
        try quoted("host/desk-read.ts", /(?s)export type DeskRead<T> =(.*?value: T \});/)
            == client(RegisteredAgents.Desk.self))
    #expect(try quoted("host/registered-agents.ts", /helper: ([^;]*);/) == client(RegisteredAgents.Helper.self))
    #expect(try quoted("host/registered-agents.ts", /broken\?: ([^;]*);/) == client(WakeLine.Broken.self))
    #expect(try quoted("memory/party.ts", /kind: ([^;]*);/) == client(Party.Kind.self))
    // A line of an agent's session on pi (`read_agent_session`).
    #expect(try quoted("host/agent-session-read.ts", /kind: ([^;]*);/) == client(AgentSession.Line.Kind.self))
    // Model spending's providers and kinds (`read_spending`).
    #expect(try quoted("memory/spends.ts", /SPEND_PROVIDERS = \[([^\]]*)\]/) == client(SpendProvider.self))
    #expect(try quoted("memory/spends.ts", /export type SpendKind = ([^;]*);/) == client(SpendKind.self))
    // A log line's level, and the processes the Live logs menu lists.
    #expect(try quoted("core/log-line.ts", /LOG_LEVELS = \[([^\]]*)\]/) == client(LogLevel.self))
    #expect(
        try quoted("core/log-line.ts", /const PROCESSES = new Set\(\[([^\]]*)\]/)
            == Set(LogProcess.allCases.map(\.rawValue)))
    #expect(
        try quoted("records/observation.ts", /ClosenessLevel = z\.enum\(\[([^\]]*)\]/) == client(ClosenessLevel.self))
    // A person's details by kind: the keys of `LABELS`; a line of `latest`, his or theirs.
    let labels = try #require(try source("memory/details.ts").firstMatch(of: /(?s)const LABELS = \{(.*?)\};/)).output.1
    #expect(Set(labels.matches(of: /(\w+):/).map { String($0.output.1) }) == client(PersonNow.Detail.Kind.self))
    #expect(try quoted("memory/person-now.ts", /by: ([^;]*);/) == client(LatestPage.Item.Said.By.self))
    #expect(try quoted("memory/refs.ts", /(?s)export type Ref = (.*?)\n\);/) == client(Check.LifeLink.Kind.self))
    // The heading a `life:` link's page leaves out (`LifeLinkRead`).
    #expect(try source("memory/words.ts").contains(#"const HEADER = "\#(LifeLinkRead.heading)";"#))
    // The matter icon set: the server's keys, in its order, are the catalog's, nine groups of 72 distinct keys.
    let table = try #require(
        try source("records/matter-icon.ts").firstMatch(of: /(?s)MATTER_ICONS = \[(.*?)\] as const/))
    let keys = table.output.1.matches(of: /\[\s*"([a-z]+)",/).map { String($0.output.1) }
    let catalog = MatterIcons.groups.flatMap(\.icons).map(\.key)
    #expect(keys == catalog)
    #expect(Set(catalog).count == 72)
    #expect(MatterIcons.groups.count == 9)
}

@Test func unknownServerValuesNeverFailTheFeedsState() throws {
    let state = Data(
        #"""
        {"mac":{"dictatingSince":null,"llm":{"able":false,"reason":"vacation"}},
         "switches":{"transcription":true,"ai":true,"engine":"future","openAppAfterMinutes":15}}
        """#.utf8)
    let decoded = try LibraryStore.feedDecoder.decode(ServerClient.FeedState.self, from: state)
    #expect(decoded.mac?.llm?.reason == .unknown)
    #expect(decoded.switches?.engine == .unknown)
}

@Test func processingEngineIsBackwardAndForwardCompatible() throws {
    let decoder = JSONDecoder()
    let old = try decoder.decode(
        ServerClient.Switches.self, from: Data(#"{"transcription":true,"ai":false,"openAppAfterMinutes":15}"#.utf8))
    #expect(old.engine == .claude)
    let newer = try decoder.decode(
        ServerClient.Switches.self,
        from: Data(#"{"transcription":true,"ai":true,"engine":"future","openAppAfterMinutes":15}"#.utf8))
    #expect(newer.engine == .unknown)
}
