import Foundation
import MacLink
import Synchronization
import Testing

@testable import LifeConnector

/// RFC 7636, appendix B.
@Test func theChallengeIsTheRFCsForItsVerifier() {
    #expect(
        LifeOAuth.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
            == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    #expect(LifeOAuth.newVerifier().count == 43)
}

/// A Life's sign-in: its metadata, a registration, an approval by code, tokens.
private func life(host: String, code: String = "ABC234") -> @Sendable (Seen) -> Reply {
    { request in
        let origin = "https://\(host)"
        switch request.url.path {
        case "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource":
            return .json(#"{"resource":"\#(origin)/mcp","authorization_servers":["\#(origin)/auth"]}"#)
        case "/.well-known/oauth-authorization-server/auth":
            return .json(
                #"{"issuer":"\#(origin)/auth","authorization_endpoint":"\#(origin)/auth/oauth2/authorize","token_endpoint":"\#(origin)/auth/oauth2/token","registration_endpoint":"\#(origin)/auth/oauth2/register"}"#
            )
        case "/auth/oauth2/register":
            return .json(#"{"client_id":"client-9"}"#, status: 201)
        case "/auth/oauth2/authorize":
            guard request.form["pairing"] == code else { return .json("<form>", status: 200) }
            return Reply(
                status: 302,
                redirect: "http://127.0.0.1/life-app?code=auth-code&state=\(request.form["state"] ?? "")")
        case "/auth/oauth2/token":
            return request.form["grant_type"] == "refresh_token" && request.form["refresh_token"] != "refresh-2"
                ? .json(#"{"error":"invalid_grant"}"#, status: 400) : tokenReply(access: "access-9")
        default: return Reply(status: 404)
        }
    }
}

@Test func theFullPairingTradesTheCodeForTokens() async throws {
    let host = newHost()
    let posts = Mutex<[String: Seen]>([:])
    let handler = life(host: host)
    let session = Stub.session(host: host) { request in
        posts.withLock { $0[request.url.path] = request }
        return handler(request)
    }
    let steps = Mutex<[LifeOAuth.Step]>([])
    let found = try await LifeOAuth(session: session, now: { epoch }).pair(
        LifePairing(origin: URL(string: "https://\(host)")!, code: "ABC234")
    ) { step in steps.withLock { $0.append(step) } }
    #expect(steps.withLock { $0 } == [.registering, .approving, .exchanging])
    #expect(found.endpoint.clientID == "client-9")
    #expect(found.endpoint.resource == "https://\(host)/mcp")
    #expect(
        found.tokens == LifeTokens(access: "access-9", refresh: "refresh-2", expiresAt: epoch.addingTimeInterval(3600)))
    let registration = try #require(posts.withLock { $0["/auth/oauth2/register"] })
    #expect(registration.json["client_name"] as? String == "Life for iPhone")
    // The challenge sent for approval is the verifier's, sent when the code is traded.
    let approval = try #require(posts.withLock { $0["/auth/oauth2/authorize"] })
    let exchange = try #require(posts.withLock { $0["/auth/oauth2/token"] })
    #expect(approval.form["code_challenge_method"] == "S256")
    #expect(approval.form["code_challenge"] == LifeOAuth.challenge(for: try #require(exchange.form["code_verifier"])))
    #expect(exchange.form["code"] == "auth-code")
}

@Test func aWrongOrExpiredCodeIsTheFormAgain() async throws {
    let host = newHost()
    let session = Stub.session(host: host, life(host: host))
    await #expect(throws: MCPError.wrongCode) {
        try await LifeOAuth(session: session).pair(LifePairing(origin: URL(string: "https://\(host)")!, code: "ZZZ999"))
    }
}

@Test func metadataIsAlsoFoundWithoutTheMCPPath() async throws {
    let host = newHost()
    let inner = life(host: host)
    let session = Stub.session(host: host) { request in
        request.url.path.hasSuffix("-resource/mcp") ? Reply(status: 404) : inner(request)
    }
    let paired = try await LifeOAuth(session: session).pair(
        LifePairing(origin: URL(string: "https://\(host)")!, code: "ABC234"))
    #expect(paired.endpoint.clientID == "client-9")
}

@Test func aRefreshLifeRefusesForGoodIsNotPaired() async throws {
    let host = newHost()
    let session = Stub.session(host: host, life(host: host))
    let oauth = LifeOAuth(session: session, now: { epoch })
    // "refresh-1" is not the one Life holds.
    await #expect(throws: MCPError.notPaired) { try await oauth.refresh(credentials(host: host)) }
}

@Test func aRefreshWhoseReplyWasLostIsAskedOnceMore() async throws {
    let host = newHost()
    let calls = Mutex(0)
    let inner = life(host: host)
    let session = Stub.session(host: host) { request in
        guard request.form["grant_type"] == "refresh_token" else { return inner(request) }
        return calls.withLock { n in
            n += 1
            switch n {
            case 1: return Reply(failure: .networkConnectionLost)
            // The tunnel lost Life's answer: a 502, then a 400 that is not Life's word on the grant.
            case 3: return .json("bad gateway", status: 502)
            case 5: return .json(#"{"error":"unsupported_grant_type"}"#, status: 400)
            default: return tokenReply(access: "access-9")
            }
        }
    }
    let stored = credentials(host: host)
    let oauth = LifeOAuth(session: session, now: { epoch })
    let held = LifeCredentials(
        endpoint: stored.endpoint, tokens: LifeTokens(access: "a", refresh: "refresh-2", expiresAt: epoch))
    for _ in 0..<3 { #expect(try await oauth.refresh(held).access == "access-9") }
    #expect(calls.withLock { $0 } == 6)
}

@Test func theApprovalsRedirectIsDeclinedNotFollowed() async throws {
    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: URL(string: "https://life.test/authorize")!)
    let response = HTTPURLResponse(
        url: task.originalRequest!.url!, statusCode: 302, httpVersion: nil,
        headerFields: ["location": "http://127.0.0.1/x"])!
    let followed = await NoRedirect().urlSession(
        session, task: task, willPerformHTTPRedirection: response,
        newRequest: URLRequest(url: URL(string: "http://127.0.0.1/x")!))
    #expect(followed == nil)
}
