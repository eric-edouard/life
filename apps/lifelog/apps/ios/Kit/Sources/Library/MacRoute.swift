import Foundation
import Synchronization

/// The Mac's iroh endpoint id and the relay it is reached through: what the pairing link names (`mac=`, `relay=`), and
/// what `MacLink` dials. Not a secret: it is the Mac's public key, and the relay is a public one.
public struct MacKey: Codable, Equatable, Hashable, Sendable {
    /// The Mac's iroh endpoint id: 64 hex characters, as the Mac writes it in the pairing link (`EndpointId.toString`).
    public let id: String
    /// The relay the two meet through when they cannot reach each other directly (`RelayMode.customFromUrls`).
    public let relay: URL

    public init(id: String, relay: URL) {
        self.id = id
        self.relay = relay
    }
}

/// Where a pairing put the Mac: the origin the phone's requests are made for, and the key and relay that carry them
/// over iroh. One for the Life paired now; `MacLink` is pointed at it on launch and by a pairing.
public struct MacTarget: Equatable, Sendable {
    public let origin: URL
    public let key: MacKey

    public init(origin: URL, key: MacKey) {
        self.origin = origin
        self.key = key
    }
}

/// The one hook between the phone's requests and the bridge `MacLink` opened on this device: while a
/// bridge carries the paired origin's host, a request for that host goes to the Mac's own loopback port instead, its
/// path, query and headers untouched. Set when a dial to the paired Mac worked, cleared when it gave up, so nothing in
/// the clients knows iroh exists.
public enum MacRoute {
    /// The bridge's loopback address and the origin's host it carries.
    public struct Bridge: Equatable, Sendable {
        public let host: String
        public let port: UInt16

        public init(host: String, port: UInt16) {
            self.host = host
            self.port = port
        }
    }

    private static let bridge = Mutex<Bridge?>(nil)

    /// The live bridge, read on every request from whatever thread made it.
    public static var current: Bridge? {
        get { bridge.withLock { $0 } }
        set { bridge.withLock { $0 = newValue } }
    }

    /// `url` as it is sent: through the bridge while the bridge carries its host, as it was addressed otherwise.
    public static func route(_ url: URL) -> URL {
        guard let bridge = current else { return url }
        return routed(url, pairedHost: bridge.host, bridgePort: bridge.port)
    }

    /// The same request on the bridge's loopback port, for a URL of the paired origin's host (pure): scheme, host and
    /// port only, so the path, the query and the request itself are the ones the client made.
    public static func routed(_ url: URL, pairedHost: String, bridgePort: UInt16) -> URL {
        guard url.host() == pairedHost else { return url }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.scheme = "http"
        components?.host = "127.0.0.1"
        components?.port = Int(bridgePort)
        return components?.url ?? url
    }
}
