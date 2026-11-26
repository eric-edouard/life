import Foundation
import Synchronization
import Testing

@testable import LifeConnector

/// Life's replies to `sign_in_to_network`, as its server test wrote them, each re-encoded alone.
private func wireReplies() throws -> [String] {
    let all = try JSONSerialization.jsonObject(with: Data(try wireText("life/sign_in_to_network.json").utf8))
    return try #require(all as? [Any]).map {
        String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self)
    }
}

@Test func lifesRepliesDecodeStepByStep() throws {
    let replies = try wireReplies().map(SignInReply.parsed)
    guard case .step(let form) = replies[0], case .step(let code) = replies[1] else {
        Issue.record("not steps: \(replies)")
        return
    }
    #expect(form.type == .userInput)
    #expect(form.fields?.map(\.id) == ["email", "password"])
    #expect(form.fields?.last?.type == "password")
    #expect(code.type == .displayAndWait)
    #expect(code.display == SignInStep.Display(type: .code, data: "482913"))
    #expect(Array(replies[2...]) == [.waiting, .done])
}

private let cookieStep = try! JSONDecoder().decode(
    SignInStep.Cookies.self,
    from: Data(
        #"""
        {"url": "https://www.example.test/login", "fields": [
          {"id": "session", "required": true, "sources": [{"type": "cookie", "name": "sid", "cookieDomain": "www.example.test"}]},
          {"id": "token", "required": true, "sources": [
            {"type": "request_header", "name": "X-Token", "requestUrlRegex": "^https://www\\.example\\.test/api/"}]},
          {"id": "csrf", "required": false, "sources": [{"type": "request_body", "name": "csrf"}]}
        ]}
        """#.utf8))

@Test func aCookieIsMatchedByNameAndDomain() {
    var caught = SignInCatch()
    caught.requests = [.init(url: "https://www.example.test/api/me", headers: ["x-token": "t1"], body: nil)]
    caught.cookies = [.init(name: "sid", domain: ".other.test", value: "wrong")]
    #expect(caught.answers(for: cookieStep) == nil)
    caught.cookies.append(.init(name: "sid", domain: ".example.test", value: "s1"))
    #expect(caught.answers(for: cookieStep) == ["session": "s1", "token": "t1"])
}

@Test func aHeaderIsCaughtOnlyFromARequestItsPatternNames() {
    var caught = SignInCatch()
    caught.cookies = [.init(name: "sid", domain: "www.example.test", value: "s1")]
    caught.requests = [.init(url: "https://cdn.example.test/api/x", headers: ["X-Token": "elsewhere"], body: nil)]
    #expect(caught.answers(for: cookieStep) == nil)
    caught.requests.append(
        .init(url: "https://www.example.test/api/graphql", headers: ["X-Token": "t2"], body: "csrf=c1&q=1"))
    #expect(caught.answers(for: cookieStep) == ["session": "s1", "token": "t2", "csrf": "c1"])
}

@Test func extractJsWinsOverEveryOtherSource() {
    var caught = SignInCatch()
    caught.extracted = ["session": "from-js", "token": "t"]
    caught.cookies = [.init(name: "sid", domain: "www.example.test", value: "s1")]
    #expect(caught.answers(for: cookieStep) == ["session": "from-js", "token": "t"])
}

/// A Life whose replies a test scripts, in order; each request is kept.
private final class Script: Sendable {
    let replies: Mutex<[Result<String, MCPError>]>
    let requests = Mutex<[SignInRequest]>([])
    init(_ replies: [Result<String, MCPError>]) { self.replies = Mutex(replies) }
    func call(_ request: SignInRequest) throws -> String {
        requests.withLock { $0.append(request) }
        return try replies.withLock { $0.removeFirst() }.get()
    }
}

@MainActor @Test func aSignInGoesFromItsFormThroughTheWaitToDone() async throws {
    let replies = try wireReplies()
    let script = Script([.success(replies[0]), .success(replies[1]), .success(replies[2]), .success(replies[3])])
    let flow = NetworkSignIn(network: "line") { try script.call($0) }
    await flow.start()
    guard case .step(let form) = flow.phase else {
        Issue.record("\(flow.phase)")
        return
    }
    await flow.submit(["email": "a@example.test", "password": "pw"])
    #expect(flow.phase == .done)
    let sent = script.requests.withLock { $0 }
    #expect(sent.first == .start("line"))
    #expect(sent[1] == .answering(form, of: "line", with: ["email": "a@example.test", "password": "pw"]))
    // The code's wait is asked twice (once `waiting`), each with no answers.
    #expect(sent[2...].map(\.answers) == [nil, nil])
    #expect(sent[2...].map(\.type) == ["display_and_wait", "display_and_wait"])
}

@MainActor @Test func lifesRefusalIsShownInPlainWords() async {
    let flow = NetworkSignIn(network: "line") { _ in
        throw MCPError.refused("Not done: LINE didn't accept that. Try again.")
    }
    await flow.start()
    #expect(flow.phase == .failed("LINE didn't accept that. Try again."))
    let unreachable = NetworkSignIn(network: "line") { _ in throw MCPError.unreachable }
    await unreachable.start()
    #expect(unreachable.phase == .failed("Life can't reach your Mac right now."))
}

@MainActor @Test func aNetworkThatNeedsNoSignInIsDone() async {
    let flow = NetworkSignIn(network: "line") { _ in
        throw MCPError.refused("Not done: LINE doesn't need signing in now.")
    }
    await flow.start()
    #expect(flow.phase == .done)
}

@MainActor @Test func aWaitCutWhileHeIsInTheOtherAppIsAskedAgainOnReturn() async throws {
    let replies = try wireReplies()
    let script = Script([.success(replies[1]), .failure(.streamDropped), .success(replies[3])])
    let held = Mutex<NetworkSignIn?>(nil)
    let flow = NetworkSignIn(network: "line") { request in
        // He leaves for LINE while the wait is held; iOS then cuts it.
        if script.requests.withLock({ $0.count }) == 1, let flow = held.withLock({ $0 }) { await flow.setAway(true) }
        return try script.call(request)
    }
    held.withLock { $0 = flow }
    await flow.start()
    guard case .waiting = flow.phase else {
        Issue.record("\(flow.phase)")
        return
    }
    await flow.setAway(false)
    #expect(flow.phase == .done)
    #expect(script.requests.withLock { $0.count } == 3)
}

@MainActor @Test func aClosedSheetAsksNothingMore() async throws {
    let replies = try wireReplies()
    let script = Script([.success(replies[1]), .success(replies[2]), .success(replies[3])])
    let held = Mutex<NetworkSignIn?>(nil)
    let flow = NetworkSignIn(network: "line") { request in
        // He closes the sheet while the first wait is held.
        if script.requests.withLock({ $0.count }) == 1, let flow = held.withLock({ $0 }) { await flow.stop() }
        return try script.call(request)
    }
    held.withLock { $0 = flow }
    await flow.start()
    #expect(script.requests.withLock { $0.count } == 2)
}
