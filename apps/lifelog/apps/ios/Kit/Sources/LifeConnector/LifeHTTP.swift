import Foundation
import Library

/// One HTTP exchange, its failures as `MCPError`. `URLSession` is the only thing a test replaces (a `URLProtocol`).
struct LifeHTTP: Sendable {
    let session: URLSession

    /// The whole answer. Through `MacLink`'s bridge when it carries this URL's host (`MacRoute`), else as addressed.
    func data(for request: URLRequest, followingRedirects: Bool = true) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(
                for: routed(request), delegate: followingRedirects ? nil : NoRedirect())
            guard let http = response as? HTTPURLResponse else { throw MCPError.failed("Not an HTTP answer.") }
            return (data, http)
        } catch { throw MCPError.of(error) }
    }

    /// The answer as it streams (`MCPClient`'s calls with progress): the same bridge as `data(for:)`.
    func bytes(for request: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        do { return try await session.bytes(for: routed(request)) } catch let error as URLError
            where error.code == .timedOut
        { throw MCPError.timedOut } catch { throw MCPError.of(error) }
    }

    /// `request` against the bridge when there is one for its host: path, query and headers stay the client's own.
    private func routed(_ request: URLRequest) -> URLRequest {
        guard let url = request.url else { return request }
        var request = request
        request.url = MacRoute.route(url)
        return request
    }

    func get(_ url: URL) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.timeoutInterval = MCPClient.readTimeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return try await data(for: request)
    }

    static func post(_ url: URL, form: [(String, String)]) -> URLRequest {
        var request = URLRequest(url: url)
        request.timeoutInterval = MCPClient.readTimeoutSeconds
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.httpBody = Data(
            form.map { "\(escape($0.0))=\(escape($0.1))" }.joined(separator: "&").utf8)
        return request
    }

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    private static func escape(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
    }
}

/// The approval answers with a redirect to an address that is never opened: its `code` is read, not followed.
final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? { nil }
}
