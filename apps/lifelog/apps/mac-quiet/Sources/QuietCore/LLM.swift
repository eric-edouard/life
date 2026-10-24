import Foundation

/// A model call the server asks the Mac to run on the owner's selected subscription:
/// `{"type":"llm","id":…,"engine":…,"model":…,"effort":…,"system":…,"prompt":…,"schema":{…},"maxTokens":…,"timeoutMs":…}`.
public struct LLMRequest: Equatable, Sendable {
    public var id: String
    public var engine: LLMEngine
    public var effort: String?
    /// The selected model to run.
    public var model: String
    public var system: String
    public var prompt: String
    /// The JSON Schema, serialized for `--json-schema`.
    public var schema: String
    public var maxTokens: Int
    /// When the run is killed.
    public var timeout: TimeInterval

    /// The request in a socket message, or `nil` for anything else.
    public init?(message: String) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
            object["type"] as? String == "llm", let id = object["id"] as? String,
            let engine = (object["engine"] as? String).flatMap(LLMEngine.init(rawValue:)),
            let model = object["model"] as? String, !model.isEmpty,
            let system = object["system"] as? String, let prompt = object["prompt"] as? String,
            let schema = object["schema"] as? [String: Any], let maxTokens = object["maxTokens"] as? Int,
            let timeoutMs = object["timeoutMs"] as? Int, timeoutMs > 0,
            let schemaData = try? JSONSerialization.data(withJSONObject: schema, options: .sortedKeys)
        else { return nil }
        self.id = id
        self.engine = engine
        self.effort = object["effort"] as? String
        self.model = model
        self.system = system
        self.prompt = prompt
        self.schema = String(decoding: schemaData, as: UTF8.self)
        self.maxTokens = maxTokens
        self.timeout = TimeInterval(timeoutMs) / 1000
    }
}

/// What became of a call, reported raw: the server reads it (apps/server/src/mac-llm.ts).
public enum LLMOutput: Equatable, Sendable {
    /// The CLI ran: its stdout and stderr, Codex's final answer file, its exit status, and whether it was killed.
    case ran(id: String, stdout: String, stderr: String, final: String?, status: Int32, timedOut: Bool)
    /// It couldn't start: signed out (no token or login), or anything else, in words.
    case unrun(id: String, signedOut: Bool, why: String)

    public var id: String {
        switch self {
        case let .ran(id, _, _, _, _, _), let .unrun(id, _, _): id
        }
    }

    /// The socket message.
    public var message: String {
        var object: [String: Any] =
            switch self {
            case let .ran(id, stdout, stderr, _, status, timedOut):
                [
                    "type": "llm.output", "id": id, "stdout": stdout, "stderr": stderr, "status": status,
                    "timedOut": timedOut,
                ]
            case let .unrun(id, signedOut, why):
                ["type": "llm.unrun", "id": id, "signedOut": signedOut, "unrun": why]
            }
        if case let .ran(_, _, _, final?, _, _) = self { object["final"] = final }
        let data = (try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
