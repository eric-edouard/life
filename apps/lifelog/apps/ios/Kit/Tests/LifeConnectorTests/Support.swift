import Foundation
import Synchronization

@testable import LifeConnector

/// What the stub saw of one request.
struct Seen: Sendable {
    let url: URL
    let method: String
    let headers: [String: String]
    let body: Data

    var json: [String: Any] { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:] }
    /// The form fields of the body.
    var form: [String: String] {
        Dictionary(
            uniqueKeysWithValues: String(decoding: body, as: UTF8.self).split(separator: "&").map { pair in
                let parts = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? "" }
                return (parts[0], parts.count > 1 ? parts[1] : "")
            })
    }
}

/// What the stub answers: a status with headers and body chunks, a redirect, or a failure after the chunks.
struct Reply: Sendable {
    var status = 200
    var headers: [String: String] = [:]
    var chunks: [Data] = []
    var redirect: String?
    var failure: URLError.Code?

    static func json(_ text: String, status: Int = 200) -> Reply {
        Reply(status: status, headers: ["content-type": "application/json"], chunks: [Data(text.utf8)])
    }
    static func stream(_ events: String..., failure: URLError.Code? = nil) -> Reply {
        Reply(
            headers: ["content-type": "text/event-stream"], chunks: events.map { Data($0.utf8) }, failure: failure)
    }
}

/// A `URLProtocol` that answers by host, so tests that run side by side never share a handler.
final class Stub: URLProtocol, @unchecked Sendable {
    private static let handlers = Mutex<[String: @Sendable (Seen) -> Reply]>([:])
    private static let hostsSeen = Mutex<[String]>([])

    /// A session whose requests to `host` go to `handler`.
    static func session(host: String, _ handler: @escaping @Sendable (Seen) -> Reply) -> URLSession {
        handlers.withLock { $0[host] = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Stub.self]
        return URLSession(configuration: configuration)
    }

    static func requested(_ host: String) -> Bool { hostsSeen.withLock { $0.contains(host) } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host() else { return }
        Self.hostsSeen.withLock { $0.append(host) }
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        let seen = Seen(
            url: url, method: request.httpMethod ?? "GET", headers: request.allHTTPHeaderFields ?? [:], body: body)
        guard let handler = Self.handlers.withLock({ $0[host] }) else { return }
        let reply = handler(seen)
        var headers = reply.headers
        if let redirect = reply.redirect { headers["location"] = redirect }
        guard
            let response = HTTPURLResponse(
                url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)
        else { return }
        // Answered as a plain 302: a stub cannot make URLSession ask its delegate (`NoRedirect` is tested apart).
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in reply.chunks { client?.urlProtocol(self, didLoad: chunk) }
        if let failure = reply.failure {
            client?.urlProtocol(self, didFailWithError: URLError(failure))
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}

/// Credentials in memory.
final class MemoryStore: TokenStore {
    private let held: Mutex<LifeCredentials?>
    init(_ credentials: LifeCredentials? = nil) { held = Mutex(credentials) }
    func load() -> LifeCredentials? { held.withLock { $0 } }
    func save(_ credentials: LifeCredentials) { held.withLock { $0 = credentials } }
    func clear() { held.withLock { $0 = nil } }
}

let epoch = Date(timeIntervalSince1970: 1_800_000_000)

func credentials(host: String, access: String = "access-1", expiresIn: TimeInterval = 3600) -> LifeCredentials {
    return LifeCredentials(
        endpoint: LifeEndpoint(
            origin: testURL("https://\(host)"), clientID: "client-1",
            tokenEndpoint: testURL("https://\(host)/auth/oauth2/token"), resource: "https://\(host)/mcp"),
        tokens: LifeTokens(access: access, refresh: "refresh-1", expiresAt: epoch.addingTimeInterval(expiresIn)))
}

/// A URL a test wrote down: a bad one is a typo in the test, so it stops the test.
func testURL(_ text: String) -> URL {
    guard let url = URL(string: text) else { preconditionFailure("bad test URL \(text)") }
    return url
}

func newHost() -> String { "\(UUID().uuidString.lowercased()).life.test" }

/// The tokens Life's token endpoint answers.
func tokenReply(access: String, refresh: String = "refresh-2") -> Reply {
    .json(#"{"access_token":"\#(access)","refresh_token":"\#(refresh)","expires_in":3600,"token_type":"Bearer"}"#)
}

/// A tool's answer as one JSON-RPC message.
func resultMessage(_ text: String, isError: Bool = false) -> String {
    let content = (try? JSONSerialization.data(withJSONObject: [["type": "text", "text": text]])) ?? Data()
    return
        #"{"jsonrpc":"2.0","id":1,"result":{"content":\#(String(decoding: content, as: UTF8.self)),"isError":\#(isError)}}"#
}

private let fixtures = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "fixtures")

/// A file of `fixtures/wire/` (written by Life's server tests, or shared with the Android app).
func wireText(_ path: String) throws -> String {
    try String(contentsOf: fixtures.appending(path: "wire/\(path)"), encoding: .utf8)
}

/// A file of `fixtures/design/` (the simulator's design data), its zoneless instants read as UTC.
func designText(_ name: String) throws -> String {
    try String(contentsOf: fixtures.appending(path: "design/\(name).json"), encoding: .utf8)
        .replacing(/(T\d\d:\d\d:\d\d)"/) { "\($0.1)Z\"" }
}
