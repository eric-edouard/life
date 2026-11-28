import Foundation
import Testing

@testable import MacLink

private let fixtures = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "fixtures")

/// The links every app reads alike (`fixtures/wire/pairing-links.json`, shared with the Android app): each half on its
/// own, over HTTPS, or Life on this device's loopback.
@Test func aLinkGivesEachHalfOverHTTPSOrLoopback() throws {
    struct Case: Decodable {
        struct Server: Decodable { let server: String, token: String }
        struct Life: Decodable { let origin: String, code: String }
        let `case`: String
        let link: String
        let pairing: Server?
        let life: Life?
    }
    let cases = try JSONDecoder().decode(
        [Case].self, from: Data(contentsOf: fixtures.appending(path: "wire/pairing-links.json")))
    #expect(cases.count > 10)
    for c in cases {
        let link = PairLink(link: try #require(URL(string: c.link), "\(c.case)"))
        #expect(link?.server?.server.absoluteString == c.pairing?.server, "\(c.case)")
        #expect(link?.server?.token == c.pairing?.token, "\(c.case)")
        #expect(link?.life?.origin.absoluteString == c.life?.origin, "\(c.case)")
        #expect(link?.life?.code == c.life?.code, "\(c.case)")
        #expect(link?.macLink == nil, "\(c.case)")
    }
}

private let key = String(repeating: "ab12", count: 16)
private let relay = "https%3A%2F%2Frelay.example.%2F"

/// With the Mac's key any address is valid, the Mac's loopback too; without it, plain HTTP stays refused.
@Test(arguments: [
    (
        "life=http%3A%2F%2F127.0.0.1%3A46200&code=ABC234&token=abc_DEF-123-xyz_789&url=http%3A%2F%2F127.0.0.1%3A46200%2Fvoice&mac=\(key)&relay=\(relay)",
        true, true, true
    ),
    ("life=http%3A%2F%2Flife.example&code=ABC234&mac=\(key)&relay=\(relay)", true, false, true),
    ("url=http%3A%2F%2Flife.example%2Fvoice&token=abc_DEF-123-xyz_789&mac=\(key)&relay=\(relay)", false, true, true),
    ("url=http%3A%2F%2Flife.example%2Fvoice&token=abc_DEF-123-xyz_789&mac=\(key)", false, false, false),
    (
        "url=http%3A%2F%2Flife.example%2Fvoice&token=abc_DEF-123-xyz_789&mac=\(key)&relay=http%3A%2F%2Frelay.example",
        false, false, false
    ),
    ("life=https%3A%2F%2Flife.example&code=ABC234&mac=short&relay=\(relay)", true, false, false),
])
func theMacsKeyCarriesAnyAddress(query: String, hasLife: Bool, hasServer: Bool, isLinked: Bool) {
    let link = PairLink(link: URL(string: "lifelog://pair?\(query)")!)
    #expect((link?.life != nil) == hasLife)
    #expect((link?.server != nil) == hasServer)
    #expect(link?.macLink == (isLinked ? MacLinkAddress(mac: key, relay: "https://relay.example./") : nil))
}

@Test func anOriginKeepsItsAddressForEveryPathAndNoOtherPort() throws {
    let origin = URL(string: "http://127.0.0.1:\(Int.random(in: 50000...60000))")!
    let address = try #require(MacLinkAddress(mac: key, relay: "https://relay.example./"))
    MacLinkBook.remember(address, for: origin.appending(path: "mcp"))
    #expect(MacLinkBook.address(for: origin.appending(path: "voice/switches")) == address)
    #expect(MacLinkBook.address(for: URL(string: "http://127.0.0.1:1/mcp")!) == nil)
    MacLinkBook.remember(nil, for: origin)
    #expect(MacLinkBook.address(for: origin) == nil)
}

/// A stream that records what the phone writes and answers with the reads given, in order.
private actor FakeStream: MacLinkStream {
    private(set) var written = Data()
    private(set) var isFinished = false
    private var reads: [Result<Data, any Error>]

    init(_ reads: [Result<Data, any Error>]) { self.reads = reads }

    func write(_ data: Data) { written.append(data) }
    func finish() { isFinished = true }
    func read() throws -> Data { reads.isEmpty ? Data() : try reads.removeFirst().get() }
}

private struct Dropped: Error {}

private func piece(_ text: String) -> Result<Data, any Error> { .success(Data(text.utf8)) }

/// What one exchange gave: the answer, each piece of body as it came, and how it ended.
private func exchange(_ request: URLRequest, _ stream: FakeStream) async -> (HTTPURLResponse?, [String], (any Error)?) {
    nonisolated(unsafe) var answer: HTTPURLResponse?
    nonisolated(unsafe) var pieces: [String] = []
    do {
        try await MacLinkExchange.run(request, over: stream) {
            answer = $0
        } body: {
            pieces.append(String(decoding: $0, as: UTF8.self))
        }
        return (answer, pieces, nil)
    } catch { return (answer, pieces, error) }
}

@Test func aRequestGoesAsHTTP10AndItsAnswerIsReadToTheEndOfTheStream() async throws {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:46200/voice/upload?job=a%20b")!)
    request.httpMethod = "PUT"
    request.httpBody = Data("words".utf8)
    request.setValue("Bearer t", forHTTPHeaderField: "Authorization")
    request.setValue("keep-alive", forHTTPHeaderField: "Connection")
    let stream = FakeStream([
        piece("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: a\r\n"),
        piece("Set-Cookie: b\r\n\r\n{\"ok\""), piece(":true}"),
    ])
    let (answer, pieces, error) = await exchange(request, stream)
    #expect(error == nil)
    #expect(
        String(decoding: await stream.written, as: UTF8.self)
            == "PUT /voice/upload?job=a%20b HTTP/1.0\r\nHost: 127.0.0.1:46200\r\nConnection: close\r\n"
            + "Content-Length: 5\r\nAuthorization: Bearer t\r\n\r\nwords")
    #expect(await stream.isFinished)
    #expect(answer?.statusCode == 200)
    #expect(answer?.value(forHTTPHeaderField: "content-type") == "application/json")
    #expect(answer?.value(forHTTPHeaderField: "set-cookie") == "a, b")
    #expect(pieces.joined() == #"{"ok":true}"#)
}

@Test func anEventStreamArrivesPieceByPiece() async {
    let stream = FakeStream([
        piece("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"),
        piece("data: {\"progress\":1}\n\n"), piece("data: {\"result\":2}\n\n"),
    ])
    let (answer, pieces, error) = await exchange(URLRequest(url: URL(string: "http://127.0.0.1:46200/mcp")!), stream)
    #expect(error == nil)
    #expect(answer?.statusCode == 200)
    #expect(pieces == ["data: {\"progress\":1}\n\n", "data: {\"result\":2}\n\n"])
    #expect(String(decoding: await stream.written, as: UTF8.self).hasPrefix("GET /mcp HTTP/1.0\r\n"))
}

/// A connection lost before or during the answer reads as one, so a read is tried again (`ServerClient.send`).
@Test(arguments: [
    [piece("HTTP/1.1 200 OK\r\n"), .failure(Dropped())],
    [piece("HTTP/1.1 200 OK\r\n")],
    [piece("HTTP/1.1 200 OK\r\n\r\npart"), .failure(Dropped())],
])
func aDroppedConnectionIsALostConnection(reads: [Result<Data, any Error>]) async {
    let (_, _, error) = await exchange(URLRequest(url: URL(string: "http://127.0.0.1:46200/mcp")!), FakeStream(reads))
    #expect((error as? URLError)?.code == .networkConnectionLost)
}
