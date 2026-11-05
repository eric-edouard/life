import AppKit
import QuietCore

/// The processes Host runs: from its bundle's `Contents/Helpers`, and speaker recognition from the venv Host installs.
enum Child: String, CaseIterable, Sendable {
    case server, quiet, tunnel, identity, embedder

    static let helpers = Bundle.main.bundleURL.appending(path: "Contents/Helpers")
    /// Speaker recognition's files (apps/identity's `app.py`, `pyproject.toml`, `uv.lock`), in the bundle.
    static let identityProject = Bundle.main.bundleURL.appending(path: "Contents/Resources/identity")
    static let identityScript = identityProject.appending(path: "app.py")
    /// Its venv, Python and model, installed by `uv sync` and `app.py download` (`HostModel.installIdentity`).
    static let identityHome = HostModel.support.appending(path: "identity")
    static let uv = helpers.appending(path: "uv")
    /// Search by meaning's model (Life's core/embedder.ts), in the bundle.
    static let embedderModel = Bundle.main.bundleURL.appending(path: "Contents/Resources/embedder/model.gguf")

    var title: String {
        switch self {
        case .server: "Server"
        case .quiet: "Mac helper"
        case .tunnel: "Cloudflare tunnel"
        case .identity: "Speaker recognition"
        case .embedder: "Search by meaning"
        }
    }

    var executable: URL {
        switch self {
        case .server: Self.helpers.appending(path: "lifelog-server")
        case .quiet: Self.helpers.appending(path: "lifelog-quiet")
        case .tunnel: Self.helpers.appending(path: "cloudflared")
        case .identity: Self.identityHome.appending(path: "venv/bin/python3")
        case .embedder: Self.helpers.appending(path: "llama/llama-server")
        }
    }

    /// Codex, for summaries on ChatGPT: the helper runs it, Host signs it in.
    static let codex = helpers.appending(path: "codex")

    /// ~/Library/Logs/lifelog-server.log, -quiet.log (`bun run events` reads it), -tunnel.log, -identity.log and
    /// -embedder.log.
    var log: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/lifelog-\(rawValue).log")
    }
}

/// How a child is to run now.
enum Launch {
    case run(arguments: [String], environment: [String: String])
    /// Not wanted: the tunnel while phones come through the tailnet, speaker recognition while it is off.
    case skip
    /// Wanted, but it can't: why.
    case blocked(String)
}

/// Keeps Host's children alive, as Life's Supervisor does: each starts again 5 s after it stops, with `launch` read
/// anew, and all end with the app. A child is stopped on purpose only through `halt`, which lets go of it first, so
/// its restart never fires.
@MainActor @Observable
final class Supervisor {
    private(set) var running: [Child: Bool] = [:]
    /// Unexpected stops since launch.
    private(set) var restarts: [Child: Int] = [:]
    private(set) var problems: [Child: String] = [:]
    /// How each child runs, from the host's settings and secrets.
    @ObservationIgnored var launch: (Child) -> Launch = { _ in .skip }
    @ObservationIgnored private var children: [Child: Process] = [:]
    @ObservationIgnored private var restarting = false
    /// The app is ending: nothing starts again, even from a restart under way.
    @ObservationIgnored private var stopped = false

    /// Every child stopped and waited for, any left by a host that crashed too (they hold the archive's lock, the
    /// helper's socket and the tunnel), then started again on fresh settings. One at a time: a second call while one
    /// runs does nothing. The host never calls it while `lifelog-server import` or `export` runs, which the orphan
    /// stop would kill.
    func restart() async {
        guard !restarting else { return }
        restarting = true
        defer { restarting = false }
        for child in Child.allCases {
            await halt(child)
            await stopOrphan(child)
        }
        for child in Child.allCases { keep(child) }
    }

    /// Every child ends with the app, and none starts after: a restart under way starts nothing more.
    func stop() {
        stopped = true
        let stopping = children.values
        children = [:]
        for process in stopping { CLI.stop(process) }
    }

    /// `child` alone stopped and started again on fresh settings.
    func restart(_ child: Child) async {
        await halt(child)
        keep(child)
    }

    /// Stops `child` without a restart, and returns once it has exited.
    func halt(_ child: Child) async {
        guard let process = children.removeValue(forKey: child) else { return }
        running[child] = false
        CLI.stop(process)
        while process.isRunning { try? await Task.sleep(for: .milliseconds(100)) }
    }

    /// Starts `child`, unless one is already tracked (halt it first) or the app is ending.
    private func keep(_ child: Child) {
        guard children[child] == nil, !stopped else { return }
        running[child] = false
        let arguments: [String]
        let environment: [String: String]
        switch launch(child) {
        case .skip:
            problems[child] = nil
            return
        case .blocked(let why):
            problems[child] = why
            return
        case .run(let args, let env):
            (arguments, environment) = (args, env)
        }
        let process = Process()
        process.executableURL = child.executable
        process.arguments = arguments
        process.environment = CLI.environment(adding: environment)
        process.currentDirectoryURL = HostModel.support
        process.standardOutput = log(child)
        process.standardError = process.standardOutput
        let started = Date.now
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.children[child] === process else { return }
                self.running[child] = false
                self.restarts[child, default: 0] += 1
                if Date.now.timeIntervalSince(started) < 10 {
                    self.problems[child] = "lifelog's \(child.title) keeps stopping: see \(child.log.path)"
                }
                try? await Task.sleep(for: .seconds(5))
                guard self.children[child] === process else { return }
                self.children[child] = nil
                self.keep(child)
            }
        }
        do {
            try process.run()
            children[child] = process
            running[child] = true
        } catch {
            problems[child] = "lifelog's \(child.title) didn't start: \(error.localizedDescription)"
            return
        }
        // Up for 10 s: whatever was wrong with it is over.
        Task {
            try? await Task.sleep(for: .seconds(10))
            if children[child] === process { problems[child] = nil }
        }
    }

    /// One left running by a host that crashed: asked to stop, killed after 5 s, gone before this returns.
    private func stopOrphan(_ child: Child) async {
        let pattern = child.executable.path
        /// Whether one is still running after up to `tries` checks 100 ms apart.
        func alive(_ tries: Int) async -> Bool {
            for _ in 0..<tries {
                if await shell(URL(filePath: "/usr/bin/pgrep"), ["-f", pattern]).status != 0 { return false }
                try? await Task.sleep(for: .milliseconds(100))
            }
            return true
        }
        guard await alive(1) else { return }
        _ = await shell(URL(filePath: "/usr/bin/pkill"), ["-f", pattern])
        guard await alive(50) else { return }
        _ = await shell(URL(filePath: "/usr/bin/pkill"), ["-KILL", "-f", pattern])
        _ = await alive(20)
    }

    private func log(_ child: Child) -> FileHandle? {
        if !FileManager.default.fileExists(atPath: child.log.path) {
            FileManager.default.createFile(atPath: child.log.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: child.log)
        handle?.seekToEndOfFile()
        return handle
    }
}

/// A program run to its end: its exit status and all its output (its errors too, unless `errors` is false), the last
/// line included. The output is read to its end on a dispatch thread, never the cooperative pool, and the exit
/// resumes the caller.
func shell(
    _ executable: URL, _ arguments: [String], environment: [String: String]? = nil, errors: Bool = true
) async -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    if let environment { process.environment = CLI.environment(adding: environment) }
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = errors ? pipe : FileHandle.nullDevice
    let (exits, exited) = AsyncStream<Int32>.makeStream()
    process.terminationHandler = { process in
        exited.yield(process.terminationStatus)
        exited.finish()
    }
    do { try process.run() } catch { return (-1, error.localizedDescription) }
    let output = await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .utility).async {
            continuation.resume(returning: (try? pipe.fileHandleForReading.readToEnd()) ?? Data())
        }
    }
    var status: Int32 = -1
    for await code in exits { status = code }
    return (status, String(decoding: output, as: UTF8.self))
}
