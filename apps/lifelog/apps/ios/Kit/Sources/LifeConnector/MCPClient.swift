import Foundation

/// One call to Life's connector: a POST of JSON-RPC `tools/call` to `<origin>/mcp`, answered as JSON or as an event
/// stream (progress, then the result). Nothing outside this file knows JSON-RPC or SSE. No retry inside, except one
/// after a 401 with a fresh token.
public struct MCPClient: Sendable {
    static let protocolVersion = "2026-07-28"

    private let session: LifeSession
    private let http: LifeHTTP

    public init(session: LifeSession, urlSession: URLSession = URLSession(configuration: .ephemeral)) {
        self.session = session
        http = LifeHTTP(session: urlSession)
    }

    /// The tool's answer text (JSON, as the tool wrote it). `onProgress` gets each progress message of the stream. `answerKey`
    /// is the one key of one tap of his, the same on every repeat of it: Life then answers a repeat with the first answer's result.
    public func call(
        _ tool: String, _ arguments: some Encodable & Sendable = [String: String](), answerKey: String? = nil,
        onProgress: (@Sendable (Data) -> Void)? = nil
    ) async throws -> String {
        let token = onProgress == nil ? nil : UUID().uuidString
        let body = try JSONEncoder().encode(
            Envelope(tool: tool, arguments: arguments, progressToken: token, answerKey: answerKey))
        let url = try await session.origin().appending(path: "mcp")
        var bearer = try await session.bearer()
        for attempt in 0...1 {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = body
            for (name, value) in [
                ("authorization", "Bearer \(bearer)"), ("content-type", "application/json"),
                ("accept", "application/json, text/event-stream"), ("mcp-protocol-version", Self.protocolVersion),
                ("mcp-method", "tools/call"), ("mcp-name", tool),
            ] { request.setValue(value, forHTTPHeaderField: name) }
            do { return try await send(request, progressToken: token, onProgress: onProgress) } catch is Unauthorized {
                guard attempt == 0 else { throw MCPError.notPaired }
                bearer = try await session.refreshed(rejecting: bearer)
            }
        }
        throw MCPError.notPaired
    }

    private struct Unauthorized: Error {}

    private static func check(_ answer: HTTPURLResponse) throws {
        guard answer.statusCode != 401 else { throw Unauthorized() }
        guard (200..<300).contains(answer.statusCode) else {
            throw MCPError.failed("Life answered \(answer.statusCode).")
        }
    }

    private func send(_ request: URLRequest, progressToken: String?, onProgress: (@Sendable (Data) -> Void)?)
        async throws -> String
    {
        // A call with no progress to give is one JSON body: read whole (`AsyncBytes` is slow byte by byte, and the inbox is large).
        guard let onProgress else {
            let (data, answer) = try await http.data(for: request)
            try Self.check(answer)
            guard let result = try Self.message(data, progressToken: nil, onProgress: nil) else {
                throw MCPError.failed("Life's answer holds no result.")
            }
            return result
        }
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do { (bytes, response) = try await http.session.bytes(for: request) } catch { throw MCPError.of(error) }
        guard let http = response as? HTTPURLResponse else { throw MCPError.failed("Not an HTTP answer.") }
        try Self.check(http)
        let isStream = http.value(forHTTPHeaderField: "content-type")?.contains("text/event-stream") == true
        var parser = SSEParser()
        var whole = Data()
        do {
            for try await byte in bytes {
                guard isStream else {
                    whole.append(byte)
                    continue
                }
                if let event = parser.feed(byte),
                    let result = try Self.message(
                        Data(event.utf8), progressToken: progressToken, onProgress: onProgress)
                {
                    return result
                }
            }
        } catch let error as MCPError { throw error } catch { throw MCPError.streamDropped }
        guard !isStream else { throw MCPError.streamDropped }
        guard let result = try Self.message(whole, progressToken: progressToken, onProgress: onProgress) else {
            throw MCPError.failed("Life's answer holds no result.")
        }
        return result
    }

    /// One JSON-RPC message: a progress of ours goes to `onProgress`; the result gives the tool's text. Nil: neither.
    private static func message(_ data: Data, progressToken: String?, onProgress: (@Sendable (Data) -> Void)?) throws
        -> String?
    {
        guard let message = try? JSONDecoder().decode(Message.self, from: data) else {
            throw MCPError.failed("Life's answer is not JSON-RPC.")
        }
        if message.method == "notifications/progress" {
            if let text = message.params?.message, message.params?.progressToken == progressToken {
                onProgress?(Data(text.utf8))
            }
            return nil
        }
        if let error = message.error { throw MCPError.failed(error.message) }
        guard message.id == 1, let result = message.result, let text = result.content.first?.text else { return nil }
        if result.isError == true { throw MCPError.refused(text) }
        return text
    }

    private struct Envelope<Arguments: Encodable>: Encodable {
        let tool: String
        let arguments: Arguments
        let progressToken: String?
        let answerKey: String?

        func encode(to encoder: any Encoder) throws {
            var root = encoder.container(keyedBy: Key.self)
            try root.encode("2.0", forKey: .jsonrpc)
            try root.encode(1, forKey: .id)
            try root.encode("tools/call", forKey: .method)
            var params = root.nestedContainer(keyedBy: Key.self, forKey: .params)
            try params.encode(tool, forKey: .name)
            try params.encode(arguments, forKey: .arguments)
            var meta = params.nestedContainer(keyedBy: Key.self, forKey: .meta)
            try meta.encode([String: String](), forKey: .capabilities)
            try meta.encode(["name": "Life for iPhone", "version": "1"], forKey: .clientInfo)
            try meta.encode(MCPClient.protocolVersion, forKey: .protocolVersion)
            try meta.encodeIfPresent(progressToken, forKey: .progressToken)
            try meta.encodeIfPresent(answerKey, forKey: .answerKey)
        }

        enum Key: String, CodingKey {
            case jsonrpc, id, method, params, name, arguments
            case meta = "_meta"
            case capabilities = "io.modelcontextprotocol/clientCapabilities"
            case clientInfo = "io.modelcontextprotocol/clientInfo"
            case protocolVersion = "io.modelcontextprotocol/protocolVersion"
            case progressToken
            case answerKey = "life/answerKey"
        }
    }

    private struct Message: Decodable {
        struct Params: Decodable {
            let progressToken: String?
            let message: String?
        }
        struct Result: Decodable {
            struct Content: Decodable { let text: String? }
            let content: [Content]
            let isError: Bool?
        }
        struct Failure: Decodable { let message: String }
        let id: Int?
        let method: String?
        let params: Params?
        let result: Result?
        let error: Failure?
    }
}
