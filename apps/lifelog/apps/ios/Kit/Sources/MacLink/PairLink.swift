import Foundation

/// The pairing link the Mac shows as a QR code (`pairLinkOf`, voice.ts), read once:
/// `lifelog://pair?life=<origin>&code=<code>&url=<origin>/voice&token=<token>&mac=<key>&relay=<url>`. Each half (Life,
/// the voice server) is read on its own; the Mac link's address applies to both. Over the Mac link any address is
/// valid (a loopback one too): iroh carries the words, encrypted to the Mac's key. Without it, HTTPS only, but for a
/// Life on this device's own loopback (a demo Life on the Mac, read by the simulator), whose words never leave the
/// machine.
public struct PairLink: Equatable, Sendable {
    public let life: LifePairing?
    public let server: Pairing?
    public let macLink: MacLinkAddress?

    private static let loopback: Set<String?> = ["127.0.0.1", "localhost"]

    public init?(link: URL) {
        guard link.scheme == "lifelog", link.host() == "pair",
            let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        let value = { (name: String) in items.first(where: { $0.name == name })?.value }
        macLink = MacLinkAddress(mac: value("mac"), relay: value("relay"))
        let isLinked = macLink != nil
        func origin(_ name: String, loopback: Bool) -> URL? {
            guard let url = value(name).flatMap(URL.init(string:)), url.host() != nil,
                url.scheme == "https"
                    || (url.scheme == "http" && (isLinked || (loopback && Self.loopback.contains(url.host()))))
            else { return nil }
            return url
        }
        if let origin = origin("life", loopback: true), let code = value("code"),
            code.wholeMatch(of: /[A-Za-z0-9]{6}/) != nil
        {
            life = LifePairing(origin: origin, code: code)
        } else {
            life = nil
        }
        // The token is base64url, as `mint-token` makes it: nothing else reaches a header.
        if let server = origin("url", loopback: false), let token = value("token"),
            token.wholeMatch(of: /[A-Za-z0-9_-]{16,256}/) != nil
        {
            self.server = Pairing(server: server, token: token)
        } else {
            server = nil
        }
        if life == nil && server == nil { return nil }
    }
}

/// Life's half of a pairing link: the origin of its connector and the pairing code its Mac shows (5 minutes).
public struct LifePairing: Equatable, Sendable {
    public let origin: URL
    public let code: String

    public init(origin: URL, code: String) {
        self.origin = origin
        self.code = code
    }
}

/// The voice server's half of a pairing link: its URL and this phone's token, which travels in every request.
public struct Pairing: Equatable, Sendable {
    public let server: URL
    public let token: String

    public init(server: URL, token: String) {
        self.server = server
        self.token = token
    }
}
