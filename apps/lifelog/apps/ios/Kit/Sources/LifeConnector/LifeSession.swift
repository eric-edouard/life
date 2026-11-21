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
    /// The refresh under way, with the Life it is for: a caller for another Life never waits on it.
    private var refreshing: (origin: URL, task: Task<LifeTokens, any Error>)?

    public init(store: any TokenStore, oauth: LifeOAuth = LifeOAuth(), now: @escaping @Sendable () -> Date = { Date() })
    {
        self.store = store
        self.oauth = oauth
        self.now = now
    }

    public func origin() throws -> URL { try credentials().endpoint.origin }

    /// The bearer for the Life at `origin` (nil: the one paired now): never another Life's, so a call decided under one
    /// pairing is refused, not sent, once the phone is paired with another.
    public func bearer(at origin: URL? = nil) async throws -> String {
        let held = try credentials(at: origin)
        guard held.tokens.expiresAt.timeIntervalSince(now()) < Self.margin else { return held.tokens.access }
        return try await refreshed(from: held)
    }

    /// The bearer after Life refused `rejected` (a 401): the one a refresh already made, else a new one.
    public func refreshed(rejecting rejected: String, at origin: URL? = nil) async throws -> String {
        let held = try credentials(at: origin)
        return held.tokens.access == rejected ? try await refreshed(from: held) : held.tokens.access
    }

    private func credentials(at origin: URL? = nil) throws -> LifeCredentials {
        guard let held = store.load(), origin.map({ $0 == held.endpoint.origin }) != false else {
            throw MCPError.notPaired
        }
        return held
    }

    private func refreshed(from held: LifeCredentials) async throws -> String {
        let origin = held.endpoint.origin
        if let refreshing, refreshing.origin == origin { return try await refreshing.task.value.access }
        let (store, oauth) = (store, oauth)
        // Kept inside the task, so every caller waiting on it gets the same end: whoever asks after it ends finds the new
        // tokens, never the replaced ones.
        let task = Task {
            do {
                let tokens = try await oauth.refresh(held)
                // Kept only while this Life is still the one paired: a refresh never brings back the last pairing.
                if store.load()?.endpoint.origin == origin {
                    store.save(LifeCredentials(endpoint: held.endpoint, tokens: tokens))
                }
                return tokens
            } catch MCPError.notPaired {
                // Refused because another process already used this refresh token: it saved newer tokens, which hold.
                guard let saved = store.load(), saved.endpoint.origin == origin else { throw MCPError.notPaired }
                if saved.tokens.refresh != held.tokens.refresh { return saved.tokens }
                store.clear()
                throw MCPError.notPaired
            }
        }
        refreshing = (origin, task)
        defer { if refreshing?.task == task { refreshing = nil } }
        return try await task.value.access
    }
}
