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

@Test func aTapsKeyTravelsInTheEnvelopeBesideTheProgressToken() async throws {
    let sent = Mutex<Seen?>(nil)
    let mcp = client(host: newHost()) { request in
        sent.withLock { $0 = request }
        return .json(resultMessage("ok"))
    }
    _ = try await mcp.call("answer_check", ["ref": "dec_1"], answerKey: "tap-key") { _ in }
    let params = try #require(sent.withLock { $0 }?.json["params"] as? [String: Any])
    let meta = try #require(params["_meta"] as? [String: Any])
    #expect(meta["life/answerKey"] as? String == "tap-key")
    #expect(meta["progressToken"] is String)
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
    await #expect(throws: MCPError.streamDropped) { try await mcp.call("answer_check") { _ in } }
    // Cut mid-event, or by the connection.
    let cut = client(host: newHost()) { _ in .stream("data: {\"jsonrpc\"", failure: .networkConnectionLost) }
    await #expect(throws: MCPError.streamDropped) { try await cut.call("answer_check") { _ in } }
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

/// The inbox at its biggest (about 265 cards, each with a draft and its evidence) must read in well under a second, as the
/// stub streams it in 16 KB chunks: a read has no progress to give, so it is never parsed byte by byte.
@Test func aBigInboxReadsFast() async throws {
    let card =
        #"{"ref":"dec_000000000001","group":"decision","title":"t","question":"q","asker":"a","options":[],"evidence":{"from":"someone","quote":"\#(String(repeating: "word ", count: 120))"},"context":"\#(String(repeating: "more ", count: 200))"}"#
    let text =
        #"{"checks":[\#(Array(repeating: card, count: 265).joined(separator: ","))],"counts":{},"total":265,"deadlinesToday":0}"#
    let body = Data(resultMessage(text).utf8)
    let chunks = stride(from: 0, to: body.count, by: 16_384).map { body[$0..<min($0 + 16_384, body.count)] }
    let mcp = client(host: newHost()) { _ in
        Reply(headers: ["content-type": "application/json"], chunks: chunks.map { Data($0) })
    }
    let started = ContinuousClock.now
    let read = try await mcp.call("read_inbox")
    let took = ContinuousClock.now - started
    print("inbox of \(body.count) bytes read in \(took)")
    #expect(read == text)
    #expect(took < .seconds(1))
}

@Test func hisIconForAMatterIsSentAsAKeyOrAsNull() async throws {
    let sent = Mutex<[Data]>([])
    let mcp = client(host: newHost()) { request in
        let params = request.json["params"] as? [String: Any]
        let arguments = params?["arguments"] as? [String: Any] ?? [:]
        sent.withLock { $0.append((try? JSONSerialization.data(withJSONObject: arguments)) ?? Data()) }
        return .json(resultMessage("{}"))
    }
    let api = MCPLifeAPI(client: mcp)
    _ = try await api.setMatterIcon(matter: "matter_aaaaaaaaaaaa", icon: "key", onProgress: { _ in })
    _ = try await api.setMatterIcon(matter: "matter_aaaaaaaaaaaa", icon: nil, onProgress: { _ in })
    let corrections = try sent.withLock {
        try $0.map {
            let arguments = try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
            return try #require(arguments["correction"] as? [String: Any])
        }
    }
    #expect(corrections[0]["kind"] as? String == "matter-icon")
    #expect(corrections[0]["matter"] as? String == "matter_aaaaaaaaaaaa")
    #expect(corrections[0]["icon"] as? String == "key")
    // Life picks again only on an explicit null: a dropped field would be refused.
    #expect(corrections[1]["icon"] is NSNull)
}

@Test func aPushReadAsksLifeForThatOneCardAndTheWholeReadForEveryCard() async throws {
    let sent = Mutex<[Data]>([])
    let mcp = client(host: newHost()) { request in
        let params = request.json["params"] as? [String: Any]
        let arguments = params?["arguments"] as? [String: Any] ?? [:]
        sent.withLock { $0.append((try? JSONSerialization.data(withJSONObject: arguments)) ?? Data()) }
        return .json(resultMessage("{}"))
    }
    let api = MCPLifeAPI(client: mcp)
    _ = try await api.readInbox(pushId: "0123456789abcdef")
    _ = try await api.readInbox()
    let arguments = try sent.withLock {
        try $0.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
    }
    #expect(arguments[0]["pushId"] as? String == "0123456789abcdef")
    #expect(arguments[0]["limit"] == nil)
    #expect(arguments[1]["limit"] as? Int == 500)
}

@Test func hisMarkAndAProjectsStatusGoAsLifeTakesThem() async throws {
    let sent = Mutex<[(String, Data)]>([])
    let mcp = client(host: newHost()) { request in
        let params = request.json["params"] as? [String: Any]
        let arguments = params?["arguments"] as? [String: Any] ?? [:]
        let name = params?["name"] as? String ?? ""
        sent.withLock { $0.append((name, (try? JSONSerialization.data(withJSONObject: arguments)) ?? Data())) }
        return .json(resultMessage("{}"))
    }
    let api = MCPLifeAPI(client: mcp)
    _ = try await api.setImportant(matter: "matter_1", false) { _ in }
    _ = try await api.setProjectStatus("halden", .parked, said: "Parked the project Halden house") { _ in }
    _ = try await api.readMatters(project: "halden")
    let calls = try sent.withLock {
        try $0.map { ($0.0, try #require(JSONSerialization.jsonObject(with: $0.1) as? [String: Any])) }
    }
    #expect(calls.map(\.0) == ["correct_memory", "change_directory_entry", "read_matters"])
    let mark = try #require(calls[0].1["correction"] as? [String: Any])
    #expect(calls[0].1["kind"] as? String == "memory")
    #expect(mark["kind"] as? String == "matter-important")
    #expect(mark["matter"] as? String == "matter_1")
    #expect(mark["important"] as? Bool == false)
    let edit = calls[1].1
    #expect(edit["kind"] as? String == "project")
    #expect(edit["action"] as? String == "edit")
    #expect(edit["id"] as? String == "halden")
    #expect(edit["status"] as? String == "parked")
    #expect(edit["said"] as? String == "Parked the project Halden house")
    #expect(calls[2].1["project"] as? String == "halden")
}
