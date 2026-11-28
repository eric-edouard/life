import Foundation

/// Where the Mac link reaches a Mac (`mac` and `relay` in the pairing link, `MacLinkAddress` in mac-link.ts): the Mac's
/// endpoint id, the public half of its key, and the one relay it keeps its home on. Not secret.
public struct MacLinkAddress: Codable, Hashable, Sendable {
    public let mac: String
    public let relay: String

    public init?(mac: String?, relay: String?) {
        guard let mac, mac.wholeMatch(of: /[A-Za-z0-9]{32,128}/) != nil, let relay,
            URL(string: relay)?.scheme == "https"
        else { return nil }
        (self.mac, self.relay) = (mac, relay)
    }
}

/// Which origins the phone reaches over the Mac link, and the Mac's address for each, kept once per origin in the app
/// group's defaults (`LifelogAppGroup` in the target's Info.plist), so the notification extension reads what the app
/// paired. Life's connector and the voice server share the origin, so one address serves both.
public enum MacLinkBook {
    private static let key = "macLinks"
    // UserDefaults is thread-safe; the SDK just doesn't mark it Sendable.
    nonisolated(unsafe) private static let defaults =
        (Bundle.main.object(forInfoDictionaryKey: "LifelogAppGroup") as? String).flatMap(UserDefaults.init(suiteName:))
        ?? .standard

    /// `scheme://host:port`: every URL under one origin shares its address.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme, let host = url.host() else { return nil }
        return "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
    }

    private static var all: [String: MacLinkAddress] {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([String: MacLinkAddress].self, from: $0) } ?? [:]
    }

    /// The Mac link's address for `url`'s origin; nil: the phone reaches it directly.
    public static func address(for url: URL) -> MacLinkAddress? {
        origin(of: url).flatMap { all[$0] }
    }

    /// Reaches `url`'s origin over the Mac link at `address` from now on; nil: directly.
    public static func remember(_ address: MacLinkAddress?, for url: URL) {
        guard let origin = origin(of: url) else { return }
        var all = all
        all[origin] = address
        defaults.set(try? JSONEncoder().encode(all), forKey: key)
    }
}
