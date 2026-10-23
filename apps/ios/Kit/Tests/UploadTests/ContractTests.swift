import Foundation
import Library
import Testing

@testable import Upload
import ServerAPI
import Timeline

/// The client against the server's own spec (`apps/voice/openapi.json`, kept fresh by the gate): every enum the client
/// mirrors has the spec's values, and every path it calls exists.
private let apps = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

private func spec() throws -> [String: Any] {
    let data = try Data(contentsOf: apps.appending(path: "voice/openapi.json"))
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
    try mirrors(ServerClient.Switches.Engine.self, "Switches", "engine")
    try mirrors(ServerClient.MacLLM.Reason.self, "MacLlm", "reason")
    try mirrors(ServerClient.NamingItem.Kind.self, "QueueItem", "kind")
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
        "Life/HealthReporter.swift",
    ].map(read).joined()
    let call =
        /(?:request\(|send\(|path = |= \("(?:GET|POST|PUT|PATCH|DELETE)", |\n\s+)"([a-z][A-Za-z\/\\()-]*)"(?=\)|, method:|,|\n)/
    let queued = /path: "([a-z][a-z\/-]*)", urgent/
    let literals = client.matches(of: call).map(\.output.1) + outbox.matches(of: queued).map(\.output.1)
    let called = Set(literals.map { String($0).replacing(/\\\([a-z][A-Za-z]*(?:\([a-z]+\))?\)/, with: "{}") })
    #expect(called.count > 25, "the parser still finds the client's calls")
    #expect(called.subtracting(paths).isEmpty, "\(called.subtracting(paths).sorted())")
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
