import Foundation
import Testing

@testable import MacLink

private let fixtures = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "fixtures")

/// The links every app reads alike (`fixtures/wire/pairing-links.json`, shared with the Android app): each half on its
/// own, over HTTPS or Life on this device's loopback, or any address over the Mac link the link names.
@Test func aLinkGivesEachHalfWithItsMacLink() throws {
    struct Case: Decodable {
        struct Server: Decodable { let server: String, token: String }
        struct Life: Decodable { let origin: String, code: String }
        let `case`: String
        let link: String
        let pairing: Server?
        let life: Life?
        let macLink: MacLinkAddress?
    }
    let cases = try JSONDecoder().decode(
        [Case].self, from: Data(contentsOf: fixtures.appending(path: "wire/pairing-links.json")))
    #expect(cases.filter { $0.macLink != nil }.count == 3)
    for c in cases {
        let link = PairLink(link: try #require(URL(string: c.link), "\(c.case)"))
        #expect(link?.server?.server.absoluteString == c.pairing?.server, "\(c.case)")
        #expect(link?.server?.token == c.pairing?.token, "\(c.case)")
        #expect(link?.life?.origin.absoluteString == c.life?.origin, "\(c.case)")
        #expect(link?.life?.code == c.life?.code, "\(c.case)")
        for macLink in [link?.life?.macLink, link?.server?.macLink] where macLink != nil {
            #expect(macLink == c.macLink, "\(c.case)")
        }
    }
}

@Test func aRequestCarriesItsMacLink() throws {
    let address = try #require(
        MacLinkAddress(mac: String(repeating: "ab12", count: 16), relay: "https://relay.example./"))
    var request = URLRequest(url: URL(string: "http://127.0.0.1:46200/mcp")!)
    #expect(request.macLink == nil && !MacLinkURLProtocol.canInit(with: request))
    request.macLink = address
    #expect(request.macLink == address && MacLinkURLProtocol.canInit(with: request))
    request.macLink = nil
    #expect(request.macLink == nil)
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

/// Never sent to an HTTP/1.0 request; refused rather than passed on with its chunk sizes in the body.
@Test func aChunkedAnswerIsRefused() async {
    let stream = FakeStream([piece("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n")])
    let (answer, _, error) = await exchange(URLRequest(url: URL(string: "http://127.0.0.1:46200/mcp")!), stream)
    #expect(answer == nil)
    #expect((error as? URLError)?.code == .badServerResponse)
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
