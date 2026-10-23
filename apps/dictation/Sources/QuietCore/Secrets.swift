import Foundation

/// The Mac's Life secrets, in one owner-only file, read once at launch: the helper's two, and Voice Host's. They
/// used to sit in the login Keychain, whose trust in one binary broke on every rebuild or OS update: macOS then asked
/// for the password, nothing could be sent, and the phone held all uploads.
public struct Secrets: Codable, Equatable, Sendable {
    /// The server's token for the socket (README).
    public var macToken: String?
    /// The token `claude setup-token` prints (`--setup-claude-token`).
    public var claudeToken: String?
    /// Voice Host's: the phone's token, a reader's (for Life), the owner's keys, the Cloudflare tunnel's token
    /// ("My own domain"), the backup's restic password (minted once, the owner copies it somewhere safe) and the
    /// secret the server and speaker recognition share.
    public var deviceToken: String?
    public var readerToken: String?
    public var elevenLabsKey: String?
    public var openAIKey: String?
    public var cloudflareToken: String?
    public var resticPassword: String?
    public var identitySecret: String?

    public init(
        macToken: String? = nil, claudeToken: String? = nil, deviceToken: String? = nil, readerToken: String? = nil,
        elevenLabsKey: String? = nil, openAIKey: String? = nil, cloudflareToken: String? = nil,
        resticPassword: String? = nil, identitySecret: String? = nil
    ) {
        self.macToken = macToken
        self.claudeToken = claudeToken
        self.deviceToken = deviceToken
        self.readerToken = readerToken
        self.elevenLabsKey = elevenLabsKey
        self.openAIKey = openAIKey
        self.cloudflareToken = cloudflareToken
        self.resticPassword = resticPassword
        self.identitySecret = identitySecret
    }

    public static let file = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Application Support/lifelog-quiet/secrets.json")

    public struct Unsafe: Error, CustomStringConvertible, Equatable {
        public var path: String
        public var mode: Int
        public var description: String {
            "\(path) is readable by others (mode \(String(mode, radix: 8))); run chmod 600 on it, then restart"
        }
    }

    /// Reads `file`, refusing one that group or others can access; no secrets without one.
    public static func load(from file: URL) throws -> Secrets {
        guard let data = try ownerOnly(file) else { return Secrets() }
        return try JSONDecoder().decode(Secrets.self, from: data).trimmed
    }

    /// The bytes of a file only its owner can access, nil when there is none; any other file is refused.
    public static func ownerOnly(_ file: URL) throws -> Data? {
        let manager = FileManager.default
        guard manager.fileExists(atPath: file.path) else { return nil }
        let mode = (try manager.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int) ?? 0
        guard mode & 0o077 == 0 else { throw Unsafe(path: file.path, mode: mode) }
        return try Data(contentsOf: file)
    }

    /// Writes the file with mode 0600 from the first byte, in a folder made 0700 if it didn't exist.
    public func save(to file: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(
            at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let temporary = file.appendingPathExtension("tmp")
        try? manager.removeItem(at: temporary)
        guard
            manager.createFile(
                atPath: temporary.path, contents: try JSONEncoder().encode(self),
                attributes: [.posixPermissions: 0o600])
        else { throw CocoaError(.fileWriteUnknown) }
        _ = try manager.replaceItemAt(file, withItemAt: temporary)
    }

    private var trimmed: Secrets {
        let fields: [WritableKeyPath<Secrets, String?>] = [
            \.macToken, \.claudeToken, \.deviceToken, \.readerToken, \.elevenLabsKey, \.openAIKey,
            \.cloudflareToken, \.resticPassword, \.identitySecret,
        ]
        var copy = self
        for field in fields {
            let text = copy[keyPath: field]?.trimmingCharacters(in: .whitespacesAndNewlines)
            copy[keyPath: field] = text?.isEmpty == false ? text : nil
        }
        return copy
    }
}
