import Foundation

/// The subscription the summaries run on, and the helper's sign-in to it: ChatGPT through Codex, or Claude through
/// Claude Code. Shared by the helper (its calls and its `--setup-*` flags) and Lifelog Host's Summaries section,
/// which do the I/O.
public enum Summaries {
    static let folder = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Application Support/lifelog-quiet")

    /// A dedicated ChatGPT login, with none of the owner's everyday rules or skills.
    public static let codexHome = folder.appending(path: "codex")

    /// `codex login` with `codexLoginEnvironment` signed the helper's own Codex login in.
    public static var codexSignedIn: Bool {
        FileManager.default.fileExists(atPath: codexHome.appending(path: "auth.json").path)
    }

    /// `codex login` in the browser, into the helper's own home: the subscription's login, never an API key's.
    public static let codexLogin = ["login"]
    public static var codexLoginEnvironment: [String: String] { ["CODEX_HOME": codexHome.path] }

    /// The login's home, the owner's only.
    public static func makeCodexHome() throws {
        try FileManager.default.createDirectory(
            at: codexHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    /// The token `claude setup-token` printed, as pasted: one word, or nil.
    public static func claudeToken(_ pasted: String) -> String? {
        let token = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty || token.contains(where: \.isWhitespace) ? nil : token
    }

    /// The LaunchAgent's PATH is minimal, so the CLI is looked for where its installers put it.
    public static func claudeBinary() -> String? {
        [
            FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/bin/claude").path,
            "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
        ].first(where: FileManager.default.isExecutableFile(atPath:))
    }

    /// `LIFELOG_CODEX` (Lifelog Host's own copy), else the native binary in the helper's own runtime (README), found
    /// by name so a new package layout still works, else the usual install places. The LaunchAgent has no Node, so
    /// npm's `codex` script won't do.
    public static func codexBinary() -> String? {
        let files = FileManager.default
        let home = files.homeDirectoryForCurrentUser
        let runtime = folder.appending(path: "codex-runtime/node_modules")
        let vendored = (files.enumerator(at: runtime, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? [])
            .filter { $0.lastPathComponent == "codex" && $0.path.contains("/vendor/") }.map(\.path)
        let candidates =
            [ProcessInfo.processInfo.environment["LIFELOG_CODEX"]].compactMap(\.self) + vendored + [
                home.appending(path: ".local/bin/codex").path, "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
            ]
        return candidates.first(where: files.isExecutableFile(atPath:))
    }
}
