import Foundation
import Library

/// What pairs the phone with Life: the origin of its connector and the pairing code its Mac shows (5 minutes), as
/// `lifelog://pair?life=https%3A%2F%2F…&code=ABC234`. One link may also carry `url` and `token` (`Pairing`, the lifelog
/// server): both are read from it, each on its own. HTTPS only, but for a Life on this device's own loopback (a demo
/// Life on the Mac, read by the simulator), whose words never leave the machine.
public struct LifePairing: Equatable, Sendable {
    public let origin: URL
    public let code: String
    /// The Mac's iroh key and relay (`mac=`, `relay=`), when the link names them: the phone reaches the Mac over iroh
    /// first and its origin only if that fails (`MacLink`). Nil: Life over Tailscale as before.
    public let mac: MacKey?

    /// Where `MacLink` dials for this pairing: nil when it names no Mac (Tailscale carries the requests).
    public var macTarget: MacTarget? {
        mac.map { MacTarget(origin: origin, key: $0) }
    }

    public init(origin: URL, code: String, mac: MacKey? = nil) {
        self.origin = origin
        self.code = code
        self.mac = mac
    }

    private static let loopback: Set<String?> = ["127.0.0.1", "localhost"]

    public init?(link: URL) {
        guard link.scheme == "lifelog", link.host() == "pair",
            let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems,
            let origin = items.first(where: { $0.name == "life" })?.value.flatMap(URL.init(string:)),
            origin.scheme == "https" || (origin.scheme == "http" && Self.loopback.contains(origin.host())),
            origin.host() != nil,
            let code = items.first(where: { $0.name == "code" })?.value,
            code.wholeMatch(of: /[A-Za-z0-9]{6}/) != nil
        else { return nil }
        self.origin = origin
        self.code = code
        mac = Self.mac(of: items)
    }

    /// The Mac an offer names: `mac=` and `relay=`, both of them, an endpoint id's own shape and a relay over HTTPS, or
    /// none. Read once, so a link that names half of it pairs over Tailscale rather than failing: its Mac is simply not
    /// reachable this way.
    static func mac(of items: [URLQueryItem]) -> MacKey? {
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        // The id's shape only: iroh is what refuses anything that is not a key, at the dial, and the phone then has no
        // bridge rather than a broken one.
        guard let id = value("mac"), id.wholeMatch(of: /[A-Za-z0-9_-]{32,64}/) != nil,
            let relay = value("relay").flatMap(URL.init(string:)), relay.scheme == "https", relay.host() != nil
        else { return nil }
        return MacKey(id: id, relay: relay)
    }
}
