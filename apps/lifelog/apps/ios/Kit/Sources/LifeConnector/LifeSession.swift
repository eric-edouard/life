import Foundation

/// The bearer every call carries. Life replaces the refresh token each time it is used, so two refreshes at once would
/// lose the pairing: there is one at a time in a process, and whoever asks meanwhile waits for it. Another process on
/// the same store (the notification extension) may still refresh at the same moment: a refused refresh reads the store
/// again before it ends the pairing.
public actor LifeSession {
    /// A token with less than this left is replaced before it is used.
    private static let margin: TimeInterval = 60

    private let store: any TokenStore
    private let oauth: LifeOAuth
    private let now: @Sendable () -> Date
    /// The refresh under way, with the pairing it is for: a caller for another pairing never waits on it.
    private var refreshing: (pairing: LifeEndpoint, task: Task<LifeTokens, any Error>)?

    public init(store: any TokenStore, oauth: LifeOAuth = LifeOAuth(), now: @escaping @Sendable () -> Date = { Date() })
    {
        self.store = store
        self.oauth = oauth
        self.now = now
    }

    /// The pairing held now with the Life at `origin` (nil: whichever): a call binds its bearer and any refresh to it.
    public func pairing(at origin: URL? = nil) throws -> LifeEndpoint {
        let held = try credentials()
        guard origin.map({ $0 == held.endpoint.origin }) != false else { throw MCPError.notPaired }
        return held.endpoint
    }

    /// The bearer of `pairing` (nil: the one held now): never another pairing's, so a call decided under one is
    /// refused, not sent, once the phone is paired again, with another Life or the same one at the same address.
    public func bearer(of pairing: LifeEndpoint? = nil) async throws -> String {
        let held = try credentials(of: pairing)
        guard held.tokens.expiresAt.timeIntervalSince(now()) < Self.margin else { return held.tokens.access }
        return try await refreshed(from: held)
    }

    /// The bearer of `pairing` after Life refused `rejected` (a 401): the one a refresh already made, else a new one.
    public func refreshed(rejecting rejected: String, of pairing: LifeEndpoint? = nil) async throws -> String {
        let held = try credentials(of: pairing)
        return held.tokens.access == rejected ? try await refreshed(from: held) : held.tokens.access
    }

    private func credentials(of pairing: LifeEndpoint? = nil) throws -> LifeCredentials {
        guard let held = store.load(), pairing.map({ $0 == held.endpoint }) != false else {
            throw MCPError.notPaired
        }
        return held
    }

    private func refreshed(from held: LifeCredentials) async throws -> String {
        let pairing = held.endpoint
        if let refreshing, refreshing.pairing == pairing { return try await refreshing.task.value.access }
        let (store, oauth) = (store, oauth)
        // Kept inside the task, so every caller waiting on it gets the same end: whoever asks after it ends finds the new
        // tokens, never the replaced ones.
        let task = Task {
            do {
                let tokens = try await oauth.refresh(held)
                // Kept only while this pairing still holds: a refresh never brings back the last one.
                if store.load()?.endpoint == pairing {
                    store.save(LifeCredentials(endpoint: held.endpoint, tokens: tokens))
                }
                return tokens
            } catch MCPError.notPaired {
                // Refused because another process already used this refresh token: it saved newer tokens, which hold.
                guard let saved = store.load(), saved.endpoint == pairing else { throw MCPError.notPaired }
                if saved.tokens.refresh != held.tokens.refresh { return saved.tokens }
                store.clear()
                throw MCPError.notPaired
            }
        }
        refreshing = (pairing, task)
        defer { if refreshing?.task == task { refreshing = nil } }
        return try await task.value.access
    }
}
