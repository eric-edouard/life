import Foundation

/// Which site a link goes to, for the card that draws its brand: the link's own host, never text elsewhere in it
/// (`https://evil.example/?u=paypal.com` is not PayPal, nor is `paypal.com.evil.io`).
public enum LinkHost {
    /// Whether `url` is on `entry`: a host (`paypal.com`: that host or one under it) or a host with a path
    /// (`google.com/maps`: that host and a path that begins with it, at a `/`). Only an https or http link has a host.
    public static func matches(_ url: URL, entry: String) -> Bool {
        guard ["https", "http"].contains(url.scheme?.lowercased()), let host = url.host()?.lowercased() else {
            return false
        }
        let parts = entry.split(separator: "/", maxSplits: 1).map(String.init)
        guard let name = parts.first, host == name || host.hasSuffix("." + name) else { return false }
        guard parts.count == 2 else { return true }
        let path = url.path(percentEncoded: false).lowercased()
        return path == "/" + parts[1] || path.hasPrefix("/" + parts[1] + "/")
    }
}

extension Check {
    /// The party a payment goes to, when an account need names them as its holder: a guess beside an amount to pay
    /// is never shown as the payee.
    public var namedPayee: Party? {
        let holders = (needs ?? []).compactMap(\.holder).map { $0.lowercased() }
        return likelyPeople.first { party in
            !party.isOwner && holders.contains { $0 == party.name.lowercased() }
        }
    }
}
