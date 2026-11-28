import Foundation
import MacLink

/// Where Life is and which app the phone registered as: not secret, kept in the app's defaults.
public struct LifeEndpoint: Codable, Equatable, Sendable {
    public let origin: URL
    public let clientID: String
    public let tokenEndpoint: URL
    /// The `resource` Life named (`<origin>/mcp`), sent again when a token is asked.
    public let resource: String
    /// The Mac link every request of this pairing goes over (nil: directly); absent from pairings made before it.
    public let macLink: MacLinkAddress?

    public init(origin: URL, clientID: String, tokenEndpoint: URL, resource: String, macLink: MacLinkAddress? = nil) {
        self.origin = origin
        self.clientID = clientID
        self.tokenEndpoint = tokenEndpoint
        self.resource = resource
        self.macLink = macLink
    }
}

/// The secret half: kept in the Keychain. The refresh token is replaced each time it is used.
public struct LifeTokens: Codable, Equatable, Sendable {
    public let access: String
    public let refresh: String
    public let expiresAt: Date

    public init(access: String, refresh: String, expiresAt: Date) {
        self.access = access
        self.refresh = refresh
        self.expiresAt = expiresAt
    }
}

public struct LifeCredentials: Equatable, Sendable {
    public let endpoint: LifeEndpoint
    public var tokens: LifeTokens

    public init(endpoint: LifeEndpoint, tokens: LifeTokens) {
        self.endpoint = endpoint
        self.tokens = tokens
    }
}

/// Where the credentials are kept. The app's is the defaults and the Keychain (`LifeToken`); a test's is memory.
public protocol TokenStore: Sendable {
    func load() -> LifeCredentials?
    func save(_ credentials: LifeCredentials)
    func clear()
}
