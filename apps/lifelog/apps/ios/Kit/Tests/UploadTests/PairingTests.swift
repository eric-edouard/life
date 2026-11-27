import Foundation
import Synchronization
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

@Test func aServerUnderAPathKeepsItInEveryRequest() throws {
    let client = ServerClient(server: { URL(string: "https://life.example/voice") }, token: { "t" })
    #expect(try client.request("/health").url?.absoluteString == "https://life.example/voice/health")
}

/// Answers the pairing's one read with the status the test set for its host.
private final class Verdict: URLProtocol {
    nonisolated(unsafe) static var status = [String: Int]()
    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        guard let url = request.url, let status = Self.status[url.host() ?? ""],
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)
        else { return client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) ?? () }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"unauthorized","message":"Bad token."}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Test func aCandidateIsKeptOnlyOnceTheServerAcceptsItsToken() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [Verdict.self]
    let session = URLSession(configuration: configuration)
    func candidate(_ host: String, _ token: String) throws -> Pairing {
        try #require(Pairing(link: URL(string: "lifelog://pair?url=https%3A%2F%2F\(host)&token=\(token)")!))
    }
    Verdict.status = ["refuses.example": 401, "accepts.example": 200]
    let kept = Mutex("old-token-0123456789")
    for host in ["refuses.example", "gone.example"] {
        do {
            try await candidate(host, "new-token-0123456789").pair(session: session) { pairing in
                kept.withLock { $0 = pairing.token }; return true
            }
            Issue.record("\(host) was kept")
        } catch {}
        #expect(kept.withLock { $0 } == "old-token-0123456789", "\(host)")
    }
    try await candidate("accepts.example", "new-token-0123456789").pair(session: session) { pairing in
        kept.withLock { $0 = pairing.token }; return true
    }
    #expect(kept.withLock { $0 } == "new-token-0123456789")
}
