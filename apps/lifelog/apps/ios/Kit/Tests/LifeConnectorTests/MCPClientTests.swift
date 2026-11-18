import Foundation
import Synchronization
import Testing

@testable import LifeConnector

private func client(host: String, access: String = "access-1", _ handler: @escaping @Sendable (Seen) -> Reply)
    -> MCPClient
{
    let session = Stub.session(host: host, handler)
    let life = LifeSession(
        store: MemoryStore(credentials(host: host, access: access)),
        oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    return MCPClient(session: life, urlSession: session)
}

private func progress(_ token: String, _ message: String) -> String {
    #"data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"\#(token)","progress":1,"message":"\#(message)"}}"#
        + "\n\n"
}

@Test func aJSONAnswerGivesTheToolsTextAndTheRequestCarriesTheEnvelope() async throws {
    let host = newHost()
    let sent = Mutex<Seen?>(nil)
    let mcp = client(host: host) { request in
        sent.withLock { $0 = request }
        return .json(resultMessage(#"{"total":0}"#))
    }
    #expect(try await mcp.call("read_matter", ["id": "matter_a"]) == #"{"total":0}"#)
    let request = try #require(sent.withLock { $0 })
    #expect(request.url.path == "/mcp")
    #expect(request.method == "POST")
    let header = { (name: String) in request.headers.first { $0.key.lowercased() == name }?.value }
    #expect(header("authorization") == "Bearer access-1")
    #expect(header("accept") == "application/json, text/event-stream")
    #expect(header("mcp-protocol-version") == "2026-07-28")
    #expect(header("mcp-method") == "tools/call")
    #expect(header("mcp-name") == "read_matter")
    let params = try #require(request.json["params"] as? [String: Any])
    #expect(params["name"] as? String == "read_matter")
    #expect((params["arguments"] as? [String: String]) == ["id": "matter_a"])
    let meta = try #require(params["_meta"] as? [String: Any])
    #expect(meta["io.modelcontextprotocol/protocolVersion"] as? String == "2026-07-28")
    #expect((meta["io.modelcontextprotocol/clientInfo"] as? [String: String])?["name"] == "Life for iPhone")
    // No progress asked, no token sent.
    #expect(meta["progressToken"] == nil)
}

@Test func aStreamGivesItsProgressThenTheResult() async throws {
    let host = newHost()
    let mcp = client(host: host) { request in
        let params = request.json["params"] as? [String: Any]
        let token = (params?["_meta"] as? [String: Any])?["progressToken"] as? String ?? ""
        return .stream(
            progress("someone-else", "ignored"), progress(token, "one"), progress(token, "two"),
            "data: \(resultMessage("done"))\n\n")
    }
    let heard = Mutex<[String]>([])
    let text = try await mcp.call("change_registered_agent", ["action": "start"]) { message in
        heard.withLock { $0.append(String(decoding: message, as: UTF8.self)) }
    }
    #expect(text == "done")
    #expect(heard.withLock { $0 } == ["one", "two"])
}

@Test func aStreamThatEndsWithNoResultIsDropped() async throws {
    let host = newHost()
    let mcp = client(host: host) { _ in .stream(progress("x", "one")) }
    await #expect(throws: MCPError.streamDropped) { try await mcp.call("read_inbox") }
    // Cut mid-event, or by the connection.
    let cut = client(host: newHost()) { _ in .stream("data: {\"jsonrpc\"", failure: .networkConnectionLost) }
    await #expect(throws: MCPError.streamDropped) { try await cut.call("read_inbox") }
}

@Test func aResultFlaggedAsAnErrorIsRefusedWithItsText() async throws {
    let mcp = client(host: newHost()) { _ in .json(resultMessage("not sent: no chat", isError: true)) }
    await #expect(throws: MCPError.refused("not sent: no chat")) { try await mcp.call("answer_check") }
}

@Test func aServerErrorOrAJSONRPCErrorFails() async throws {
    let broken = client(host: newHost()) { _ in Reply(status: 500) }
    await #expect(throws: MCPError.failed("Life answered 500.")) { try await broken.call("read_inbox") }
    let rpc = client(host: newHost()) { _ in
        .json(#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid arguments"}}"#)
    }
    await #expect(throws: MCPError.failed("Invalid arguments")) { try await rpc.call("read_inbox") }
    let garbage = client(host: newHost()) { _ in .json("<html>") }
    await #expect(throws: MCPError.failed("Life's answer is not JSON-RPC.")) { try await garbage.call("read_inbox") }
}

@Test(arguments: [
    URLError.Code.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .timedOut, .networkConnectionLost,
    .secureConnectionFailed, .serverCertificateUntrusted,
])
func aMacOutOfReachIsUnreachable(code: URLError.Code) async throws {
    let mcp = client(host: newHost()) { _ in Reply(failure: code) }
    await #expect(throws: MCPError.unreachable) { try await mcp.call("read_inbox") }
}

@Test func a401IsRetriedOnceWithAFreshToken() async throws {
    let host = newHost()
    let seenBearers = Mutex<[String]>([])
    let mcp = client(host: host) { request in
        if request.url.path.hasSuffix("/token") { return tokenReply(access: "access-2") }
        let bearer = request.headers.first { $0.key.lowercased() == "authorization" }?.value ?? ""
        seenBearers.withLock { $0.append(bearer) }
        return bearer == "Bearer access-2" ? .json(resultMessage("ok")) : Reply(status: 401)
    }
    #expect(try await mcp.call("read_inbox") == "ok")
    #expect(seenBearers.withLock { $0 } == ["Bearer access-1", "Bearer access-2"])
    // Refused again with the new token: the pairing is gone.
    let refused = client(host: newHost()) { request in
        request.url.path.hasSuffix("/token") ? tokenReply(access: "access-2") : Reply(status: 401)
    }
    await #expect(throws: MCPError.notPaired) { try await refused.call("read_inbox") }
}

@Test func anUnpairedPhoneCallsNothing() async throws {
    let host = newHost()
    let session = Stub.session(host: host) { _ in Reply(status: 500) }
    let mcp = MCPClient(
        session: LifeSession(store: MemoryStore(), oauth: LifeOAuth(session: session)), urlSession: session)
    await #expect(throws: MCPError.notPaired) { try await mcp.call("read_inbox") }
    #expect(!Stub.requested(host))
}
