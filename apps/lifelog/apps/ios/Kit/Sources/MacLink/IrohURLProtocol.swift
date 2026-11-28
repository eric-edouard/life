import Foundation
import IrohLib

/// Requests to an origin paired with a Mac's key (`MacLinkBook`) go over the Mac link: each one on its own stream of
/// one iroh connection to that Mac, which pipes it to the connector's port (mac-link.ts). Every other request goes as
/// usual. Its callers see plain `URLSession` answers: a body as it arrives (an event stream piece by piece), and a
/// dropped connection as `URLError.networkConnectionLost`, which a read retries once (`ServerClient.send`).
public final class IrohURLProtocol: URLProtocol, @unchecked Sendable {
    #if DEBUG
        /// The end-to-end tests' fake Life (`Lifelog/E2E`): a `URLProtocol` set before any session is made. Debug only.
        public nonisolated(unsafe) static var protocolsOfTests: [AnyClass] = []
    #endif

    /// The one session maker for every client of Life and the voice server: with no path to the Mac a request fails
    /// at once, never waits for one. Ephemeral: nothing is cached or kept on disk.
    public static func makeURLSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        var protocols: [AnyClass] = [IrohURLProtocol.self]
        #if DEBUG
            protocols = protocolsOfTests + protocols
        #endif
        configuration.protocolClasses = protocols + (configuration.protocolClasses ?? [])
        return URLSession(configuration: configuration)
    }

    private var loading: Task<Void, Never>?

    override public static func canInit(with request: URLRequest) -> Bool {
        request.url.flatMap(MacLinkBook.address(for:)) != nil
    }

    override public static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override public func startLoading() {
        let request = request
        loading = Task {
            do {
                guard let address = request.url.flatMap(MacLinkBook.address(for:)) else {
                    throw URLError(.unsupportedURL)
                }
                let stream = try await MacLinkDialer.shared.stream(to: address)
                try await MacLinkExchange.run(request, over: stream) { response in
                    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                } body: { data in
                    client?.urlProtocol(self, didLoad: data)
                }
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                guard !Task.isCancelled else { return }
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }

    override public func stopLoading() { loading?.cancel() }
}

/// One stream of the Mac link, as an exchange uses it: IrohLib's `BiStream` in the app, a fake in tests.
protocol MacLinkStream: Sendable {
    func write(_ data: Data) async throws
    /// No more bytes from the phone: the request is whole.
    func finish() async throws
    /// The next bytes of the answer; empty at its end.
    func read() async throws -> Data
}

extension BiStream: MacLinkStream {
    func write(_ data: Data) async throws { try await send().writeAll(buf: data) }
    func finish() async throws { try await send().finish() }
    func read() async throws -> Data { try await recv().read(sizeLimit: 64 * 1024) }
}

/// One request and its answer as bytes on a stream (the wire contract in docs/architecture.md, "Mac link"): HTTP/1.0
/// with `Connection: close` and `Host:`, and an answer read to the end of the stream (Bun answers with an `HTTP/1.1`
/// status line, and a streamed body has no length).
enum MacLinkExchange {
    static func run(
        _ request: URLRequest, over stream: some MacLinkStream, response: (HTTPURLResponse) -> Void,
        body: (Data) -> Void
    ) async throws {
        guard let url = request.url else { throw URLError(.badURL) }
        let payload = request.httpBody ?? request.httpBodyStream.map(readAll) ?? Data()
        var head: Data
        var rest = Data()
        do {
            try await stream.write(Self.head(of: request, url: url, length: payload.count) + payload)
            try await stream.finish()
            head = Data()
            while true {
                let read = try await stream.read()
                guard !read.isEmpty else { throw URLError(.networkConnectionLost) }
                head.append(read)
                if let end = head.range(of: Data("\r\n\r\n".utf8)) {
                    rest = head[end.upperBound...]
                    head = head[..<end.lowerBound]
                    break
                }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw URLError(.networkConnectionLost)
        }
        response(try Self.response(String(decoding: head, as: UTF8.self), url: url))
        if !rest.isEmpty { body(Data(rest)) }
        do {
            while case let read = try await stream.read(), !read.isEmpty { body(read) }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw URLError(.networkConnectionLost)
        }
    }

    static func head(of request: URLRequest, url: URL, length: Int) -> Data {
        let path = url.path(percentEncoded: true)
        let target = (path.isEmpty ? "/" : path) + (url.query(percentEncoded: true).map { "?\($0)" } ?? "")
        let host = (url.host() ?? "") + (url.port.map { ":\($0)" } ?? "")
        let ours: Set = ["host", "connection", "content-length"]
        var lines = ["\(request.httpMethod ?? "GET") \(target) HTTP/1.0", "Host: \(host)", "Connection: close"]
        if length > 0 || request.httpMethod ?? "GET" != "GET" {
            lines.append("Content-Length: \(length)")
        }
        for (name, value) in (request.allHTTPHeaderFields ?? [:]).sorted(by: { $0.key < $1.key })
        where !ours.contains(name.lowercased()) {
            lines.append("\(name): \(value)")
        }
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    /// The status line and headers, as `URLSession` would have given them.
    static func response(_ head: String, url: URL) throws -> HTTPURLResponse {
        let lines = head.components(separatedBy: "\r\n")
        let status = lines.first?.split(separator: " ").dropFirst().first.flatMap { Int($0) }
        var fields: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = String(line[..<colon])
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            fields[name] = fields[name].map { "\($0), \(value)" } ?? value
        }
        guard let status, let answer = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)
        else { throw URLError(.badServerResponse) }
        return answer
    }

    /// An upload's body, whole: its length goes in the head.
    // ponytail: the body is held in memory (a 50 MB speech upload at most); stream it with its length once one is larger.
    private static func readAll(_ stream: InputStream) -> Data {
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        stream.open()
        defer { stream.close() }
        while case let count = stream.read(&chunk, maxLength: chunk.count), count > 0 {
            data.append(chunk, count: count)
        }
        return data
    }
}

/// The phone's one iroh endpoint and its connection to each Mac, shared by every request of this process. The phone's
/// key is new in each process and kept nowhere (the app and each extension dial on their own). No discovery: the Mac
/// is dialed by its key through its relay, and iroh moves to a direct path when one opens.
actor MacLinkDialer {
    static let shared = MacLinkDialer()
    private static let alpn = Data("life/1".utf8)
    /// The Mac link starts up to 5 s after the first pairing makes the Mac's key (`KEY_EVERY`, mac-link.ts).
    private static let dialFor = Duration.seconds(10)

    private var endpoint: Task<Endpoint, any Error>?
    private var connections: [String: Task<Connection, any Error>] = [:]

    /// A new stream to the Mac: on the connection held, or a new one when it is gone.
    func stream(to address: MacLinkAddress) async throws -> BiStream {
        if let held = connections[address.mac], let connection = try? await held.value,
            connection.closeReason() == nil, let stream = try? await connection.openBi()
        {
            return stream
        }
        let dial = Task { try await Self.dial(address, from: try await bound(relay: address.relay).value) }
        connections[address.mac] = dial
        do {
            return try await dial.value.openBi()
        } catch {
            connections[address.mac] = nil
            if (try? await endpoint?.value) == nil { endpoint = nil }
            throw URLError(.cannotConnectToHost)
        }
    }

    // ponytail: the endpoint keeps the relay of the first Mac dialed; rebind when a phone pairs with a Mac on another relay.
    private func bound(relay: String) -> Task<Endpoint, any Error> {
        if let endpoint { return endpoint }
        let bind = Task {
            let builder = EndpointBuilder()
            builder.applyMinimal()
            builder.relayMode(mode: try RelayMode.customFromUrls(urls: [relay]))
            return try await builder.bind()
        }
        endpoint = bind
        return bind
    }

    private static func dial(_ address: MacLinkAddress, from endpoint: Endpoint) async throws -> Connection {
        let to = EndpointAddr(id: try EndpointId.fromString(s: address.mac), relayUrl: address.relay, addresses: [])
        let deadline = ContinuousClock.now + dialFor
        while true {
            do {
                return try await endpoint.connect(addr: to, alpn: alpn)
            } catch where ContinuousClock.now < deadline {
                try await Task.sleep(for: .seconds(1))
            }
        }
    }
}
