import Foundation
import Testing

@testable import ServerAPI

/// The links every app must read alike (`fixtures/wire/pairing-links.json`, shared with the Android app): the server
/// and token over HTTPS only.
@Test func aPairingLinkGivesTheServerAndTokenOverHTTPSOnly() throws {
    struct Case: Decodable {
        struct Expected: Decodable { let server: String, token: String }
        let `case`: String
        let link: String
        let pairing: Expected?
    }
    let cases = try JSONDecoder().decode([Case].self, from: try wireFile("pairing-links"))
    #expect(cases.count > 5)
    for c in cases {
        let pairing = Pairing(link: try #require(URL(string: c.link), "\(c.case)"))
        #expect(pairing?.server.absoluteString == c.pairing?.server, "\(c.case)")
        #expect(pairing?.token == c.pairing?.token, "\(c.case)")
    }
}

@Test func anUnpairedClientSendsNothing() async throws {
    let client = ServerClient(server: { nil }, token: { "t" })
    #expect(throws: ServerClient.ClientError.notPaired) { try client.request("/health") }
}
