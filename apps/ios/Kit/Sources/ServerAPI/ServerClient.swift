import Foundation
import Library
import Timeline

/// Typed client for the lifelog server (`apps/server/openapi.json`), one file per domain as in `apps/server/src/routes`.
/// Every call goes to the paired server (read on each request, like the token) and carries the device token as a
/// bearer. Nothing here retries on its own: the server's idempotency makes a
/// repeated submit return the same job.
public struct ServerClient: Sendable {
    public enum ClientError: Error, Equatable {
        /// No server or no token yet: the phone isn't paired (`Pairing`).
        case notPaired
        /// `code` is the server's `Error.error` (`held`, `transcription_off`, …).
        case server(status: Int, code: String?, message: String)
        case notHTTP
    }

    /// A 4xx caused by the request itself, so sending it again won't help: not a missing or rejected token (401, 403),
    /// a timeout (408) or a rate limit (429), which pass.
    public static func refuses(_ status: Int) -> Bool {
        (400..<500).contains(status) && ![401, 403, 408, 429].contains(status)
    }

    let server: @Sendable () -> URL?
    let token: @Sendable () -> String?
    let session: URLSession

    public init(
        server: @escaping @Sendable () -> URL?, session: URLSession = .shared,
        token: @escaping @Sendable () -> String?
    ) {
        self.server = server
        self.session = session
        self.token = token
    }

    // MARK: Plumbing

    func lower(_ id: UUID) -> String { id.uuidString.lowercased() }
    static func date(_ instant: CaptureInstant) -> Date {
        Date(timeIntervalSince1970: Double(instant.millis) / 1000)
    }

    func send(_ path: String, method: String, _ body: some Encodable) async throws -> Data {
        var request = try request(path, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(request, body: try Self.encode(body))
    }

    /// A JSON body as the client sends it, dates as `iso`, keys sorted: the same value always encodes to the same
    /// bytes (`JSONEncoder` otherwise orders keys by hash, per run), so a saved body and a rehearsed one compare.
    public static func encode(_ body: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(LibraryStore.iso))
        }
        return try encoder.encode(body)
    }

    func request(_ path: String, method: String = "GET") throws -> URLRequest {
        guard let server = server(), let token = token() else { throw ClientError.notPaired }
        var request = URLRequest(url: server.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// A read retries once when the connection drops: the first request after the app was suspended often finds the
    /// pooled connection already closed (`networkConnectionLost`), and a pass would otherwise lose its first step.
    func send(_ request: URLRequest, body: Data? = nil) async throws -> Data {
        let data: Data
        let response: URLResponse
        if let body {
            (data, response) = try await session.upload(for: request, from: body)
        } else {
            do {
                (data, response) = try await session.data(for: request)
            } catch URLError.networkConnectionLost where request.httpMethod == "GET" {
                (data, response) = try await session.data(for: request)
            }
        }
        return try Self.check(data, response)
    }

    /// The body of a 2xx; the server's error otherwise.
    static func check(_ data: Data, _ response: URLResponse) throws -> Data {
        guard let http = response as? HTTPURLResponse else { throw ClientError.notHTTP }
        guard (200..<300).contains(http.statusCode) else {
            struct Failure: Decodable {
                var error: String
                var message: String
            }
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            throw ClientError.server(
                status: http.statusCode, code: failure?.error,
                message: failure?.message ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
        return data
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        try LibraryStore.feedDecoder.decode(type, from: data)
    }
}

extension URLError {
    /// The request got no answer for a reason that passes on its own (no signal, a dropped connection, DNS, a
    /// timeout): trying again later is the whole fix.
    public var isTransient: Bool {
        [
            .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost,
            .dnsLookupFailed, .internationalRoamingOff, .callIsActive, .dataNotAllowed, .secureConnectionFailed,
        ]
        .contains(code)
    }
}
