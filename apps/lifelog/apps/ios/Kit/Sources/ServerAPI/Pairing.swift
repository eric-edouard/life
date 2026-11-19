import Foundation

/// What pairs the phone with a server: its URL and this phone's token, as the link the server's Mac shows as a QR
/// code, `lifelog://pair?url=https%3A%2F%2F…&token=…`. The Camera opens it in the app. HTTPS only: the token travels
/// in every request. The token is base64url, as `mint-token` makes it: nothing else reaches a header.
public struct Pairing: Equatable, Sendable {
    public let server: URL
    public let token: String

    public init?(link: URL) {
        guard link.scheme == "lifelog", link.host() == "pair",
            let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems,
            let server = items.first(where: { $0.name == "url" })?.value.flatMap(URL.init(string:)),
            server.scheme == "https", server.host() != nil,
            let token = items.first(where: { $0.name == "token" })?.value,
            token.wholeMatch(of: /[A-Za-z0-9_-]{16,256}/) != nil
        else { return nil }
        self.server = server
        self.token = token
    }
}

extension Pairing {
    /// The Keychain did not take the token.
    public struct NotKept: Error, Equatable {}

    /// Keeps this pairing only once the server it names accepts its token: one authed read (the owner's switches, which
    /// `bun run switches` also sets, a few bytes where the feed from the start is not). A refused or unreachable
    /// candidate throws with its reason and `keep` is never called, so the pairing in use stays.
    public func pair(session: URLSession = .shared, keep: (Pairing) -> Bool) async throws {
        let client = ServerClient(server: { server }, session: session, token: { token })
        var request = try client.request("switches")
        request.timeoutInterval = 15
        _ = try await client.send(request)
        guard keep(self) else { throw NotKept() }
    }
}
