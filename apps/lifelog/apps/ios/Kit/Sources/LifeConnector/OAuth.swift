import CryptoKit
import Foundation

/// Life's own sign-in (`oauth.ts`) from the phone: discovery, registration, PKCE, and the approval by the pairing code.
/// No browser and no web view: the code in the link is the approval. Redirects are never followed, the address
/// registered is never opened.
public struct LifeOAuth: Sendable {
    public enum Step: String, Sendable { case registering, approving, exchanging }

    private static let redirect = "http://127.0.0.1/life-app"
    private let http: LifeHTTP
    private let now: @Sendable () -> Date

    public init(
        session: URLSession? = nil, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        http = LifeHTTP(session: session ?? MCPClient.makeURLSession())
        self.now = now
    }

    // MARK: PKCE (RFC 7636)

    public static func newVerifier() -> String {
        Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }).base64URL
    }

    public static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
    }

    // MARK: Pairing

    /// Registers this app, has the pairing code approve it and trades the approval for tokens.
    public func pair(_ link: LifePairing, onStep: @Sendable (Step) async -> Void = { _ in }) async throws
        -> LifeCredentials
    {
        let found = try await discover(link.origin)
        await onStep(.registering)
        let clientID = try await register(found.registration)
        await onStep(.approving)
        let verifier = Self.newVerifier()
        let state = Self.newVerifier()
        let approval = try await approve(
            found, clientID: clientID, code: link.code, challenge: Self.challenge(for: verifier), state: state)
        await onStep(.exchanging)
        let endpoint = LifeEndpoint(
            origin: link.origin, clientID: clientID, tokenEndpoint: found.token, resource: found.resource)
        let tokens = try await tokens(
            at: found.token,
            form: [
                ("grant_type", "authorization_code"), ("code", approval), ("code_verifier", verifier),
                ("client_id", clientID), ("redirect_uri", Self.redirect), ("resource", found.resource),
            ])
        return LifeCredentials(endpoint: endpoint, tokens: tokens)
    }

    /// New tokens for the refresh token held. Life refuses it for good (`invalid_grant`): `.notPaired`.
    public func refresh(_ credentials: LifeCredentials) async throws -> LifeTokens {
        let endpoint = credentials.endpoint
        let form = [
            ("grant_type", "refresh_token"), ("refresh_token", credentials.tokens.refresh),
            ("client_id", endpoint.clientID), ("resource", endpoint.resource),
        ]
        do {
            // A lost reply (no connection, or a proxy's 502 or 524 while Life did rotate it) is asked once more: Life
            // serves a used refresh token one more time within a minute.
            do { return try await tokens(at: endpoint.tokenEndpoint, form: form) } catch MCPError.refused(let why) {
                throw MCPError.refused(why)
            } catch {}
            return try await tokens(at: endpoint.tokenEndpoint, form: form)
        } catch MCPError.refused(_) { throw MCPError.notPaired }
    }

    // MARK: The steps

    private struct Found {
        let resource: String
        let authorization: URL
        let token: URL
        let registration: URL
    }

    private struct ResourceMetadata: Decodable {
        let resource: String
        let authorizationServers: [String]
    }

    private struct ServerMetadata: Decodable {
        let authorizationEndpoint: URL
        let tokenEndpoint: URL
        let registrationEndpoint: URL
    }

    private func discover(_ origin: URL) async throws -> Found {
        let well = origin.appending(path: ".well-known")
        let resource: ResourceMetadata = try await first(
            [well.appending(path: "oauth-protected-resource/mcp"), well.appending(path: "oauth-protected-resource")])
        guard let issuer = resource.authorizationServers.first.flatMap(URL.init(string:)) else {
            throw MCPError.failed("Life names no sign-in server.")
        }
        // RFC 8414: the well-known path goes between the host and the issuer's own path.
        let root = well.appending(path: "oauth-authorization-server")
        let issuerRoot = URL(string: root.absoluteString + issuer.path) ?? root
        let server: ServerMetadata = try await first([issuerRoot, root])
        return Found(
            resource: resource.resource, authorization: server.authorizationEndpoint, token: server.tokenEndpoint,
            registration: server.registrationEndpoint)
    }

    /// The first of `urls` that answers 200 with `T`.
    private func first<T: Decodable>(_ urls: [URL]) async throws -> T {
        var last = MCPError.failed("Life has no sign-in to pair with.")
        for url in urls {
            let (data, response) = try await http.get(url)
            guard response.statusCode == 200 else { continue }
            do { return try Self.decoder.decode(T.self, from: data) } catch {
                last = .failed("Life's sign-in is not readable.")
            }
        }
        throw last
    }

    private func register(_ url: URL) async throws -> String {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(
            withJSONObject: ["client_name": "Life for iPhone", "redirect_uris": [Self.redirect]])
        let (data, response) = try await http.data(for: request)
        struct Registered: Decodable { let clientId: String }
        guard response.statusCode == 201, let registered = try? Self.decoder.decode(Registered.self, from: data) else {
            throw MCPError.failed("Life did not register this app (\(response.statusCode)).")
        }
        return registered.clientId
    }

    /// The pairing code approves the registration: Life answers a redirect with the authorization code, or the form
    /// again (a 200) when the code is wrong or has expired.
    private func approve(_ found: Found, clientID: String, code: String, challenge: String, state: String) async throws
        -> String
    {
        let request = LifeHTTP.post(
            found.authorization,
            form: [
                ("client_id", clientID), ("code_challenge", challenge), ("code_challenge_method", "S256"),
                ("redirect_uri", Self.redirect), ("resource", found.resource), ("response_type", "code"),
                ("state", state), ("pairing", code),
            ])
        let (_, response) = try await http.data(for: request, followingRedirects: false)
        if response.statusCode == 200 { throw MCPError.wrongCode }
        let items = response.value(forHTTPHeaderField: "location").flatMap(URLComponents.init(string:))?.queryItems
        guard response.statusCode == 302, items?.first(where: { $0.name == "state" })?.value == state,
            let code = items?.first(where: { $0.name == "code" })?.value
        else { throw MCPError.failed("Life did not approve this app (\(response.statusCode)).") }
        return code
    }

    private func tokens(at url: URL, form: [(String, String)]) async throws -> LifeTokens {
        let (data, response) = try await http.data(for: LifeHTTP.post(url, form: form))
        struct Issued: Decodable {
            let accessToken: String
            let refreshToken: String
            let expiresIn: Double
        }
        guard response.statusCode == 200, let issued = try? Self.decoder.decode(Issued.self, from: data) else {
            // Only Life's own word that the grant is dead ends the pairing; a proxy's 400 or a 502 changes nothing.
            struct Refusal: Decodable { let error: String }
            if response.statusCode == 400, let refusal = try? JSONDecoder().decode(Refusal.self, from: data),
                refusal.error == "invalid_grant"
            {
                throw MCPError.refused(refusal.error)
            }
            throw MCPError.failed("Life gave no tokens (\(response.statusCode)).")
        }
        return LifeTokens(
            access: issued.accessToken, refresh: issued.refreshToken,
            expiresAt: now().addingTimeInterval(issued.expiresIn))
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()
}

extension Data {
    fileprivate var base64URL: String {
        base64EncodedString().replacing("+", with: "-").replacing("/", with: "_").replacing("=", with: "")
    }
}
