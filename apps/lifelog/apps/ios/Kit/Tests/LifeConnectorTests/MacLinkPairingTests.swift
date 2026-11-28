import Foundation
import MacLink
import Synchronization
import Testing

@testable import LifeConnector
@testable import ServerAPI

/// Each pairing carries its own Mac link: Life paired with another Mac at the same address leaves the voice server's
/// requests on their own Mac, and every request of Life's pairing (sign-in included) goes over Life's.
@Test func aLifePairingWithAnotherMacsKeyLeavesTheVoiceServersRequestsOnTheirOwnMac() async throws {
    let host = newHost()
    let lifeMac = try #require(
        MacLinkAddress(mac: String(repeating: "a1", count: 32), relay: "https://relay.example./"))
    let voiceMac = try #require(
        MacLinkAddress(mac: String(repeating: "b2", count: 32), relay: "https://relay.example./"))
    let seen = Mutex<[MacLinkAddress?]>([])
    let session = Stub.session(host: host) { request in
        seen.withLock { $0.append(request.macLink) }
        if request.url.path.hasSuffix("/token") { return tokenReply(access: "access-2") }
        return .json(request.url.path.hasSuffix("/mcp") ? resultMessage("{}") : "{}")
    }
    let held = credentials(host: host, expiresIn: 0)
    let endpoint = held.endpoint
    let life = MCPClient(
        session: LifeSession(
            store: MemoryStore(
                LifeCredentials(
                    endpoint: LifeEndpoint(
                        origin: endpoint.origin, clientID: endpoint.clientID, tokenEndpoint: endpoint.tokenEndpoint,
                        resource: endpoint.resource, macLink: lifeMac),
                    tokens: held.tokens)),
            oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch }),
        urlSession: session)
    let voice = ServerClient(
        server: { testURL("https://\(host)/voice") }, session: session, token: { "t" }, macLink: { voiceMac })
    _ = try await voice.send(voice.request("switches"))
    _ = try await life.call("read_inbox")
    #expect(seen.withLock { $0 } == [voiceMac, lifeMac, lifeMac])
}
