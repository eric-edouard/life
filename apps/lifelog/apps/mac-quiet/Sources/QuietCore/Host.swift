import CryptoKit
import Foundation

/// What Lifelog Host (the menu-bar app, packaging 4.6b) decides without the system: the tokens it mints, the server's
/// environment, how phones reach the Mac, and the link a phone pairs with. The app does the I/O.
public enum Host {
    /// The server's port on this Mac, on loopback only; Tailscale Serve or a Cloudflare tunnel puts HTTPS in front.
    public static let port = 47613
    public static let loopback = "http://127.0.0.1:\(port)"
    /// Speaker recognition's (apps/identity), on loopback beside it.
    public static let identityPort = 47614
    /// Search by meaning's embedder (llama.cpp's server), on loopback too: Life's core/embedder.ts `EMBEDDER_URL`.
    public static let embedderPort = 47615

    /// The embedder's arguments: `model` (a GGUF) served for embeddings only, on loopback. Four slots of 2048 tokens,
    /// the model's longest input, on the GPU.
    public static func embedderArguments(model: String) -> [String] {
        [
            "--embedding", "--model", model, "--host", "127.0.0.1", "--port", String(embedderPort),
            "--ctx-size", "8192", "--batch-size", "2048", "--ubatch-size", "2048", "--parallel", "4",
            "--n-gpu-layers", "999",
        ]
    }

    /// How phones reach this Mac: Tailscale Serve on the owner's tailnet (the default), or a Cloudflare tunnel to an
    /// address of the owner's own, which Host runs.
    public enum Reach: String, CaseIterable, Sendable {
        case tailnet, domain
    }

    /// cloudflared's options: the owner's network needs HTTP/2 and IPv4 to Cloudflare's edge.
    public static let tunnelOptions = ["--protocol", "http2", "--edge-ip-version", "4"]

    /// `cloudflared`'s arguments: the tunnel in front of the server's port. The token goes in its environment
    /// (`TUNNEL_TOKEN`), never on the command line, where `ps` shows it.
    public static func tunnelArguments() -> [String] {
        ["tunnel", "--no-autoupdate"] + tunnelOptions + ["run", "--url", loopback]
    }

    /// The owner's own address, as typed: HTTPS, a host, nothing after it.
    public static func domainAddress(_ text: String) -> URL? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text.contains("://") ? text : "https://\(text)"),
            url.scheme == "https", let host = url.host(), !host.isEmpty, ["", "/"].contains(url.path())
        else { return nil }
        return URL(string: "https://\(host)")
    }

    /// `secrets` with what it lacks minted: the phone's token (in the pairing link), the helper's (its socket only),
    /// a reader's with corrections (for Life, docs/voice-source.md), the backup's password and speaker recognition's
    /// secret. Any already there is kept: a new backup password would lock out every snapshot made with the old one.
    public static func minted(_ secrets: Secrets) -> Secrets {
        var secrets = secrets
        secrets.deviceToken = secrets.deviceToken ?? token()
        secrets.macToken = secrets.macToken ?? token()
        secrets.readerToken = secrets.readerToken ?? token()
        secrets.resticPassword = secrets.resticPassword ?? token()
        secrets.identitySecret = secrets.identitySecret ?? token()
        return secrets
    }

    /// 32 random bytes, base64url without padding, as `mint-token` makes them.
    static func token() -> String {
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Where restic is and where it keeps the backup; the password is the secrets'.
    public struct Restic: Sendable {
        public var binary: URL
        public var repository: URL
        public init(binary: URL, repository: URL) {
            self.binary = binary
            self.repository = repository
        }
    }

    /// The server's environment: its file and audio under `support`, the token hashes (never the tokens), the
    /// owner's keys, the address the phone reaches (`server`: Tailscale's HTTPS name, the owner's domain, or this Mac
    /// alone), the embedder, restic when backups are on, speaker recognition when it is on, the commit Host was built from
    /// (`build`, naming the server's error reports), and `extra` (the owner's `server.env`) under them: restic's and
    /// speaker recognition's keys are Host's, set or unset, so turning either off can't be undone by `server.env`.
    public static func serverEnvironment(
        support: URL, secrets: Secrets, server: URL?, restic: Restic? = nil, identity: Bool = false,
        build: String? = nil, extra: [String: String] = [:]
    ) -> [String: String] {
        let values: [String: String?] = [
            "BUILD_SHA": build,
            "LISTEN_HOST": "127.0.0.1",
            "PORT": String(port),
            "PUBLIC_BASE_URL": server?.absoluteString ?? loopback,
            "DEVICE_TOKEN_HASH": secrets.deviceToken.map(sha256Hex),
            "MAC_TOKEN_HASH": secrets.macToken.map(sha256Hex),
            "CORRECTIONS_TOKEN_HASH": secrets.readerToken.map(sha256Hex),
            "ELEVENLABS_API_KEY": secrets.elevenLabsKey,
            "RESTIC_BINARY": restic?.binary.path,
            "RESTIC_REPOSITORY": restic?.repository.path,
            "RESTIC_PASSWORD": restic == nil ? nil : secrets.resticPassword,
            "IDENTITY_URL": identity ? "http://127.0.0.1:\(identityPort)" : nil,
            "IDENTITY_SECRET": identity ? secrets.identitySecret : nil,
        ]
        return extra.filter { !$0.key.hasPrefix("RESTIC_") && !$0.key.hasPrefix("IDENTITY_") }
            .merging(archiveEnvironment(support: support).merging(values.compactMapValues { $0 }) { $1 }) { $1 }
    }

    /// Speaker recognition's environment, for its install (`uv sync`, `app.py download`) and its run: the venv, uv's
    /// own Python and the model all under `home`, never a Python of the system's that an upgrade could remove; the
    /// service on loopback with the secret the server sends.
    public static func identityEnvironment(home: URL, secrets: Secrets) -> [String: String] {
        [
            "UV_PROJECT_ENVIRONMENT": home.appending(path: "venv").path,
            "UV_PYTHON_INSTALL_DIR": home.appending(path: "python").path,
            "UV_PYTHON_PREFERENCE": "only-managed",
            "MODEL_DIR": home.appending(path: "model").path,
            "HOST": "127.0.0.1",
            "PORT": String(identityPort),
            "IDENTITY_SECRET": secrets.identitySecret,
        ].compactMapValues { $0 }
    }

    /// The archive's file and audio under `support`: all that `lifelog-server export` and `import` need.
    public static func archiveEnvironment(support: URL) -> [String: String] {
        [
            "DATABASE_PATH": support.appending(path: "archive.sqlite").path,
            "AUDIO_DIR": support.appending(path: "audio").path,
        ]
    }

    /// What `lifelog-server export|import` ended with, in words, from its last line (`{ok, files, bytes}` or
    /// `{ok: false, error}`): never its JSON.
    public static func archiveResult(_ command: String, status: Int32, output: String) -> (ok: Bool, message: String) {
        struct Result: Decodable {
            let ok: Bool
            let files: Int?
            let bytes: Int64?
            let error: String?
        }
        let last = output.split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
        let done = command == "export" ? "Exported" : "Imported"
        guard let result = try? JSONDecoder().decode(Result.self, from: Data(last.utf8)) else {
            let said = last.isEmpty || last.hasPrefix("{") ? "it stopped with status \(status)" : last
            return (false, "The \(command) failed: \(said)")
        }
        guard result.ok, status == 0 else {
            return (false, "The \(command) failed: \(result.error ?? "it stopped with status \(status)")")
        }
        let size = (result.bytes ?? 0).formatted(.byteCount(style: .file))
        return (true, "\(done) \(result.files ?? 0) files (\(size)).")
    }

    /// `server.env`: `KEY='value'` lines (a single-quoted value may span lines, as a PEM key does), `KEY="value"` or
    /// `KEY=value`; blank lines and `#` comments are skipped.
    public static func environmentFile(_ text: String) -> [String: String] {
        let line = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\n]*))$/
        var values: [String: String] = [:]
        for match in text.matches(of: line.anchorsMatchLineEndings()) {
            let (_, key, single, double, bare) = match.output
            values[String(key)] =
                (single ?? double).map(String.init)
                ?? bare.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        }
        return values
    }

    /// This Mac's HTTPS name on the tailnet, from `tailscale status --json` (`Self.DNSName`, with its final dot).
    public static func tailnetAddress(status: Data) -> URL? {
        struct Status: Decodable {
            struct Peer: Decodable { let DNSName: String? }
            let Self_: Peer?
            enum CodingKeys: String, CodingKey { case Self_ = "Self" }
        }
        guard let name = (try? JSONDecoder().decode(Status.self, from: status))?.Self_?.DNSName,
            !name.isEmpty
        else { return nil }
        let host = name.hasSuffix(".") ? String(name.dropLast()) : name
        return URL(string: "https://\(host)")
    }

    /// The link the phone's Camera opens from the QR code (the app's `Pairing`): HTTPS servers only.
    public static func pairingLink(server: URL, token: String) -> URL? {
        guard server.scheme == "https" else { return nil }
        var link = URLComponents()
        link.scheme = "lifelog"
        link.host = "pair"
        link.queryItems = [.init(name: "url", value: server.absoluteString), .init(name: "token", value: token)]
        return link.url
    }
}
