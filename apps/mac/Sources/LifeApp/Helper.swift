import Foundation
import os

/// Life's helper: the compiled binary in the bundle (`Contents/Helpers/life`), run with its files (`LIFE_CODE_DIR`), the
/// owner's data and Life's state under Application Support, and every secret the Keychain holds for it. The app never
/// reads Life's files itself: it asks the helper (`app`, `settings`, `init`, `pair`, `connect`, `voice`), so their
/// shape lives in one place.
enum Helper {
  static let support = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Application Support/Life")
  static let data = support.appending(path: "data")
  static let state = support.appending(path: "state")
  static let binary = Bundle.main.bundleURL.appending(path: "Contents/Helpers/life")
  static let resources = Bundle.main.bundleURL.appending(path: "Contents/Resources/life")

  /// The helper's environment: a GUI app's PATH is bare, so the usual tool folders are added (claude, codex), after the bundled tools (git, gog, and uv in `Helpers`, which the homeserver setup runs), which come first.
  static var environment: [String: String] {
    var env = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let helpers = Bundle.main.bundleURL.appending(path: "Contents/Helpers")
    let extra = [helpers.appending(path: "tools/bin").path, helpers.path, "\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
    env["LIFE_CODE_DIR"] = resources.path
    env["LIFE_OWNER_DATA_DIR"] = data.path
    env["LIFE_STATE_DIR"] = state.path
    env["LIFE_EVENTKIT"] = Bundle.main.bundleURL.appending(path: "Contents/Helpers/life-eventkit").path
    env["LIFE_FOUNDATION_MODEL"] = Bundle.main.bundleURL.appending(path: "Contents/Helpers/life-foundation-model").path
    env["GIT_TEMPLATE_DIR"] = ""  // the bundled git carries no templates (a signed app holds only code)
    env["LIFE_BRIDGES_DIR"] = Bundle.main.bundleURL.appending(path: "Contents/Helpers/bridges").path
    env["LIFE_LLAMA_SERVER"] = Bundle.main.bundleURL.appending(path: "Contents/Helpers/llama/llama-server").path
    env.merge(Keychain.all()) { _, kept in kept }
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

  /// One command to its end: its exit code, what it printed (JSON for the app's reads) and its errors apart. `input`
  /// goes to its stdin (a key, never an argument other processes could list).
  static func run(_ args: [String], input: String? = nil) async -> (code: Int32, out: String, err: String) {
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    let p = process(args)
    let out = Pipe()
    let err = Pipe()
    p.standardOutput = out
    p.standardError = err
    let stdin = Pipe()
    if input != nil { p.standardInput = stdin }
    do { try p.run() } catch { return (-1, "", error.localizedDescription) }
    if let input {
      stdin.fileHandleForWriting.write(Data(input.utf8))
      try? stdin.fileHandleForWriting.close()
    }
    async let o = Task.detached { out.fileHandleForReading.readDataToEndOfFile() }.value
    async let e = Task.detached { err.fileHandleForReading.readDataToEndOfFile() }.value
    let (od, ed) = await (o, e)
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: od, as: UTF8.self), String(decoding: ed, as: UTF8.self))
  }

  /// What the app shows (`life app`): nil while the helper can't answer.
  static func info() async -> Info? {
    try? JSONDecoder().decode(Info.self, from: Data(await run(["app"]).out.utf8))
  }
}

/// The helper's `app` answer.
struct Info: Decodable {
  let started: Bool
  /// Whether the desk is on (the `desk` setting): its helper runs only then.
  let desk: Bool
  /// The keys each engine takes, by engine (`PROVIDERS` in llm.ts): the subscription engines take none.
  let engineKeys: [String: [String]]
  /// The keys of his agents' skills (`skillKeys` in cli.ts: Apify's token): Keychain items like the engines'.
  let skillKeys: [String]
  let lastReport: String?
  let sources: [Source]
  /// The to-do list backend chosen ("reminders", "google"), nil while the to-do list is off.
  let todoList: String?
  let reminders: Reminders
  let status: Status
}

/// The watcher's status reads on this Mac (`apps/server/src/host/http/status-reads.ts`, the local port) and the key that opens them.
struct Status: Decodable {
  let url: String
  let key: String

  /// One read, decoded: nil while the watcher doesn't answer.
  func read<T: Decodable>(_ path: String) async -> T? {
    guard let url = URL(string: url + path) else { return nil }
    var req = URLRequest(url: url)
    req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    guard let (data, res) = try? await URLSession.shared.data(for: req),
      (res as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    do {
      return try JSONDecoder.life().decode(T.self, from: data)
    } catch {
      // The watcher answered in a shape the app doesn't know: an update of one without the other.
      Logger(subsystem: "app.life.mac", category: "status").error("\(path): \(error)")
      return nil
    }
  }

  func snapshot() async -> StatusSnapshot? { await read("status/snapshot") }

  func detail(_ card: String, before: String? = nil) async -> Detail? {
    let id = card.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? card
    let page = before.map { "?before=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
    return await read("status/card/\(id)\(page)")
  }

  func run(_ id: String) async -> RunView? {
    await read("status/run?id=\(id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id)")
  }
}

/// The Reminders plugin: on or not, the remctl installed (its version), whether that is the release Life installs
/// (`ready`, decided by the helper), and that release.
struct Reminders: Decodable {
  let on: Bool
  let installed: String?
  let ready: Bool
  let release: Release
  struct Release: Decodable {
    let version: String
    let url: String
    let sha256: String
  }
}

/// One source: whether he turned it on, what keeps it from being read now, and whether that is Full Disk Access.
struct Source: Decodable, Identifiable {
  let name: String
  let label: String
  let on: Bool
  let missing: String?
  let fullDisk: Bool
  var id: String { name }
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

  /// Every secret kept for Life, by name: the helper takes what it reads from its environment.
  static func all() -> [String: String] {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Life",
      kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnAttributes as String: true,
    ]
    var items: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &items) == errSecSuccess,
      let list = items as? [[String: Any]]
    else { return [:] }
    var out: [String: String] = [:]
    for name in list.compactMap({ $0[kSecAttrAccount as String] as? String }) {
      out[name] = read(name)
    }
    return out
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
