import Foundation

/// Life's helper: the compiled binary in the bundle (`Contents/Helpers/life`), run with its files (`LIFE_ROOT`), the
/// owner's data and Life's state under Application Support, and the secrets the Keychain holds. The app never reads
/// Life's files itself: it asks the helper (`settings`, `init`, `pair`, `connect`), so their shape lives in one place.
enum Helper {
  static let support = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Application Support/Life")
  static let data = support.appending(path: "data")
  static let state = support.appending(path: "state")
  static let binary = Bundle.main.bundleURL.appending(path: "Contents/Helpers/life")
  static let resources = Bundle.main.bundleURL.appending(path: "Contents/Resources/life")

  /// The secrets the helper reads from its environment, kept in the Keychain by name.
  static let secrets = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LIFELOG_TOKEN", "RESEND_PERSONAL_API_KEY"]

  /// The helper's environment: a GUI app's PATH is bare, so the usual tool folders are added (claude, codex, git).
  static var environment: [String: String] {
    var env = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let extra = ["\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
    env["LIFE_ROOT"] = resources.path
    env["LIFE_DATA"] = data.path
    env["LIFE_STATE"] = state.path
    env["LIFE_EVENTKIT"] = Bundle.main.bundleURL.appending(path: "Contents/Helpers/life-eventkit").path
    for name in secrets {
      if let value = Keychain.read(name) { env[name] = value }
    }
    return env
  }

  static func process(_ args: [String]) -> Process {
    let p = Process()
    p.executableURL = binary
    p.arguments = args
    p.environment = environment
    p.currentDirectoryURL = support
    return p
  }

  /// One command to its end: its exit code and what it printed.
  static func run(_ args: [String]) async -> (code: Int32, out: String) {
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    let p = process(args)
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, error.localizedDescription) }
    let out = await Task.detached { pipe.fileHandleForReading.readDataToEndOfFile() }.value
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: out, as: UTF8.self))
  }

  /// Whether the owner's data exists yet (the helper's `init` makes it).
  static var started: Bool {
    FileManager.default.fileExists(atPath: data.appending(path: "truth/people.yaml").path)
  }
}

/// The app's few secrets, as generic passwords under the service "Life".
enum Keychain {
  static func read(_ name: String) -> String? {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Life",
      kSecAttrAccount as String: name, kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let d = item as? Data else { return nil }
    return String(decoding: d, as: UTF8.self)
  }

  static func write(_ name: String, _ value: String) {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Life",
      kSecAttrAccount as String: name,
    ]
    SecItemDelete(q as CFDictionary)
    guard !value.isEmpty else { return }
    var add = q
    add[kSecValueData as String] = Data(value.utf8)
    SecItemAdd(add as CFDictionary, nil)
  }
}
