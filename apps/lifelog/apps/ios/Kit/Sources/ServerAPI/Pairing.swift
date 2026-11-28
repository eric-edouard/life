import Foundation
import MacLink

extension Pairing {
    /// The Keychain did not take the token.
    public struct NotKept: Error, Equatable {}

    /// Keeps this pairing only once the server it names accepts its token: one authed read (the owner's switches, which
    /// `bun run switches` also sets, a few bytes where the feed from the start is not). A refused or unreachable
    /// candidate throws with its reason and `keep` is never called, so the pairing in use stays.
    public func pair(session: URLSession = IrohURLProtocol.makeURLSession(), keep: @Sendable (Pairing) -> Bool)
        async throws
    {
        let client = ServerClient(server: { server }, session: session, token: { token })
        var request = try client.request("switches")
        request.timeoutInterval = 15
        _ = try await client.send(request)
        guard keep(self) else { throw NotKept() }
    }
}
