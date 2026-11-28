import Foundation
import Library

/// Where Life is and which app the phone registered as: not secret, kept in the app's defaults.
public struct LifeEndpoint: Codable, Equatable, Sendable {
    public let origin: URL
    public let clientID: String
    public let tokenEndpoint: URL
    /// The `resource` Life named (`<origin>/mcp`), sent again when a token is asked.
    public let resource: String
    /// The Mac this pairing named over iroh (`mac=`, `relay=`), if it did: absent in a pairing made before it, and in
    /// one over Tailscale. Kept so `MacLink` is pointed at the same Mac on the next launch.
    public let mac: MacKey?

    public init(origin: URL, clientID: String, tokenEndpoint: URL, resource: String, mac: MacKey? = nil) {
        self.origin = origin
        self.clientID = clientID
        self.tokenEndpoint = tokenEndpoint
        self.resource = resource
        self.mac = mac
    }

    /// Where `MacLink` dials for this pairing: nil when it names no Mac (Tailscale carries the requests).
    public var macTarget: MacTarget? {
        mac.map { MacTarget(origin: origin, key: $0) }
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
