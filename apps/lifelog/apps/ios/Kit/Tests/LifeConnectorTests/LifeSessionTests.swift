import Foundation
import MacLink
import Synchronization
import Testing

@testable import LifeConnector

@Test func tenCallsWithAnExpiredTokenMakeOneRefresh() async throws {
    let host = newHost()
    let refreshes = Mutex(0)
    let session = Stub.session(host: host) { _ in
        refreshes.withLock { $0 += 1 }
        return tokenReply(access: "access-2")
    }
    let store = MemoryStore(credentials(host: host, expiresIn: 30))
    let life = LifeSession(store: store, oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    let bearers = try await withThrowingTaskGroup(of: String.self) { group in
        for _ in 0..<10 { group.addTask { try await life.bearer() } }
        return try await group.reduce(into: []) { $0.append($1) }
    }
    #expect(bearers == Array(repeating: "access-2", count: 10))
    #expect(refreshes.withLock { $0 } == 1)
    #expect(store.load()?.tokens.refresh == "refresh-2")
    // A token with time left is used as it is.
    #expect(try await life.bearer() == "access-2")
    #expect(refreshes.withLock { $0 } == 1)
}

@Test func aRefusedTokenIsReplacedOnceNoMatterHowManyAsk() async throws {
    let host = newHost()
    let refreshes = Mutex(0)
    let session = Stub.session(host: host) { _ in
        refreshes.withLock { $0 += 1 }
        return tokenReply(access: "access-2")
    }
    let life = LifeSession(
        store: MemoryStore(credentials(host: host)), oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    #expect(try await life.refreshed(rejecting: "access-1") == "access-2")
    // The second caller was refused the same token: it takes the new one.
    #expect(try await life.refreshed(rejecting: "access-1") == "access-2")
    #expect(refreshes.withLock { $0 } == 1)
}

@Test func lifeRefusingTheRefreshTokenEndsThePairing() async throws {
    let host = newHost()
    let session = Stub.session(host: host) { _ in .json(#"{"error":"invalid_grant"}"#, status: 400) }
    let store = MemoryStore(credentials(host: host, expiresIn: 0))
    let life = LifeSession(store: store, oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    await #expect(throws: MCPError.notPaired) { try await life.bearer() }
    #expect(store.load() == nil)
    await #expect(throws: MCPError.notPaired) { try await life.bearer() }
}

@Test func aRefusedRefreshKeepsThePairingWhenAnotherProcessSavedNewerTokens() async throws {
    let host = newHost()
    let store = MemoryStore(credentials(host: host, expiresIn: 0))
    // Another process (the notification extension) refreshed first: Life refuses this one, the store holds its tokens.
    let session = Stub.session(host: host) { _ in
        store.save(
            LifeCredentials(
                endpoint: credentials(host: host).endpoint,
                tokens: LifeTokens(access: "access-9", refresh: "refresh-9", expiresAt: epoch.addingTimeInterval(3600)))
        )
        return .json(#"{"error":"invalid_grant"}"#, status: 400)
    }
    let life = LifeSession(store: store, oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    // Every caller waiting on that refresh keeps the pairing, not only the one that started it.
    let bearers = try await withThrowingTaskGroup(of: String.self) { group in
        for _ in 0..<3 { group.addTask { try await life.bearer() } }
        return try await group.reduce(into: []) { $0.append($1) }
    }
    #expect(bearers == Array(repeating: "access-9", count: 3))
    #expect(store.load()?.tokens.refresh == "refresh-9")
}

@Test func aRefreshFailingForAnyOtherReasonKeepsThePairing() async throws {
    for reply in [Reply.json("bad gateway", status: 502), .json("<html>proxy</html>", status: 400)] {
        let host = newHost()
        let session = Stub.session(host: host) { _ in reply }
        let store = MemoryStore(credentials(host: host, expiresIn: 0))
        let life = LifeSession(store: store, oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
        await #expect(throws: MCPError.failed("Life gave no tokens (\(reply.status)).")) { try await life.bearer() }
        #expect(store.load() != nil)
    }
}
