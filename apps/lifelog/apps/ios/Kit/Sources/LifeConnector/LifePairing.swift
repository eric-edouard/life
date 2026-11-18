import Foundation

/// What pairs the phone with Life: the origin of its connector and the pairing code its Mac shows (5 minutes), as
/// `lifelog://pair?life=https%3A%2F%2F…&code=ABC234`. One link may also carry `url` and `token` (`Pairing`, the lifelog
/// server): both are read from it, each on its own. HTTPS only.
public struct LifePairing: Equatable, Sendable {
    public let origin: URL
    public let code: String

    public init(origin: URL, code: String) {
        self.origin = origin
        self.code = code
    }

    public init?(link: URL) {
        guard link.scheme == "lifelog", link.host() == "pair",
            let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems,
            let origin = items.first(where: { $0.name == "life" })?.value.flatMap(URL.init(string:)),
            origin.scheme == "https", origin.host() != nil,
            let code = items.first(where: { $0.name == "code" })?.value,
            code.wholeMatch(of: /[A-Za-z0-9]{6}/) != nil
        else { return nil }
        self.origin = origin
        self.code = code
    }
}
