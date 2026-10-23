import AppKit
import QuietCore
import ServiceManagement

/// The owner's choices that aren't secrets, in the app's defaults.
struct HostSettings: Equatable {
    var reach = Host.Reach.tailnet
    /// The owner's own address, as typed ("My own domain").
    var domain = ""
    /// A daily restic snapshot into iCloud Drive, run by the server.
    var backups = false
    /// Speaker recognition (apps/speech) on this Mac: on unless turned off.
    var speakers = true

    static func load() -> HostSettings {
        let defaults = UserDefaults.standard
        var settings = HostSettings()
        settings.reach = defaults.string(forKey: "reach").flatMap(Host.Reach.init) ?? .tailnet
        settings.domain = defaults.string(forKey: "domain") ?? ""
        settings.backups = defaults.bool(forKey: "backups")
        settings.speakers = defaults.object(forKey: "speakers") as? Bool ?? true
        return settings
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(reach.rawValue, forKey: "reach")
        defaults.set(domain, forKey: "domain")
        defaults.set(backups, forKey: "backups")
        defaults.set(speakers, forKey: "speakers")
    }
}

/// Tailscale on this Mac, for "On my tailnet".
enum Tailnet: Equatable {
    case missing, signedOut
    case serving(URL)
}

/// Lifelog on this Mac: its settings and secrets, how each child runs (`Supervisor` keeps them alive), the server's
/// status, and the setup, import and export. The decisions are `QuietCore.Host`'s.
@MainActor @Observable
final class HostModel {
    let supervisor = Supervisor()
    /// The address phones reach: the tailnet name, the owner's domain, or nil (this Mac alone).
    private(set) var server: URL?
    private(set) var tailnet = Tailnet.missing
    /// What's wrong with Host itself: its secrets, a save, open at login.
    private(set) var problem: String?
    private(set) var secrets = Secrets()
    private(set) var settings = HostSettings.load()
    /// `/status/live`, every 30 s, for the menu and Settings.
    private(set) var status: HostStatus?
    private(set) var statusAt: Date?
    /// The full `/status`, for the status window.
    private(set) var fullStatus: HostStatus?
    private(set) var fullStatusAt: Date?
    /// The server has its key and an archive: the first run is over.
    private(set) var setUp = false
    /// How the last import or export went, or that one is under way.
    private(set) var progress = ""
    /// A Save, a start, an import or an export is under way.
    private(set) var busy = false
    /// Speaker recognition's install, checked once per launch (`installIdentity`).
    private(set) var identityInstall = Install.needed
    enum Install: Equatable {
        case needed, installing, done
        case failed(String)
    }
    private var awake: NSObjectProtocol?

    nonisolated static let home = FileManager.default.homeDirectoryForCurrentUser
    nonisolated static let support = home.appending(path: "Library/Application Support/lifelog")
    /// The owner's own server keys Host doesn't manage (APNs, Resend, …): `KEY='value'` lines, mode 0600.
    static let serverEnv = support.appending(path: "server.env")
    static let iCloud = home.appending(path: "Library/Mobile Documents/com~apple~CloudDocs")
    static let backupRepository = iCloud.appending(path: "lifelog backup/restic")

    /// Everything wrong now: Host's own, then each child's.
    var problems: [String] { [problem].compactMap(\.self) + Child.allCases.compactMap { supervisor.problems[$0] } }

    var pairingLink: URL? {
        guard let server, let token = secrets.deviceToken else { return nil }
        return Host.pairingLink(server: server, token: token)
    }

    init() {
        do {
            let stored = try Secrets.load(from: Secrets.file)
            secrets = Host.minted(stored)
            if secrets != stored { try secrets.save(to: Secrets.file) }
        } catch {
            problem = "lifelog can't start: \(error)"
        }
        setUp =
            secrets.elevenLabsKey != nil
            && FileManager.default.fileExists(atPath: Self.support.appending(path: "archive.sqlite").path)
        supervisor.launch = { [weak self] child in self?.launch(child) ?? .skip }
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.stop() } }
    }

    /// Called once, by the app delegate that owns this model.
    func start() async {
        guard problem == nil else { return }
        Task {
            while !Task.isCancelled {
                await refreshStatus()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        if setUp { await exclusive { await restart() } } else { tailnet = await Tailscale.serve(serving: false) }
    }

    /// Every child started again on the current settings. Only ever inside `exclusive`: no restart overlaps another,
    /// a Save, an import or an export.
    private func restart() async {
        server = await address()
        // Like `caffeinate -i`: the Mac doesn't idle-sleep while lifelog runs; the screen still sleeps.
        awake =
            awake
            ?? ProcessInfo.processInfo.beginActivity(
                options: .idleSystemSleepDisabled, reason: "lifelog: the server runs on this Mac")
        if case .failed = identityInstall { identityInstall = .needed }
        await supervisor.restart()
        if settings.speakers, identityInstall == .needed {
            identityInstall = .installing
            Task { await installIdentity() }
        }
    }

    /// Speaker recognition's venv (`uv sync`, from the bundled lock) and model (`app.py download`), under
    /// `Child.identityHome`, then the child started. Both steps are no-ops once done, offline too, so they run once
    /// per launch. Outside `exclusive`, so the first install (about 630 MB) holds no Save, import or export; its
    /// restart touches this child alone, never the archive. A failure shows as the child's problem, and the next Save
    /// tries again; one cut short by a quit is finished by the next launch's `uv sync`.
    private func installIdentity() async {
        let environment = Host.identityEnvironment(home: Child.identityHome, secrets: secrets)
        var step = await shell(
            Child.uv, ["sync", "--frozen", "--project", Child.identityProject.path], environment: environment)
        if step.status == 0 {
            step = await shell(
                Child.identity.executable, [Child.identityScript.path, "download"], environment: environment)
        }
        let said = step.output.split(whereSeparator: \.isNewline).last.map(String.init)
        identityInstall = step.status == 0 ? .done : .failed(said ?? "it stopped with status \(step.status)")
        await supervisor.restart(.identity)
    }

    func stop() {
        supervisor.stop()
        if let awake { ProcessInfo.processInfo.endActivity(awake) }
        awake = nil
    }

    // MARK: Setup and settings

    struct Keys {
        var elevenLabs = ""
        var openAI = ""
        var cloudflare = ""
    }

    /// Runs `work` unless a Save, a start, an import or an export is under way: they never overlap, so no restart (and
    /// its orphan stop) runs while `lifelog-server import` or `export` does.
    private func exclusive(_ work: () async -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await work()
    }

    /// Saves the keys and settings; every child starts again on them.
    func apply(_ keys: Keys, _ settings: HostSettings) async {
        await exclusive {
            let leavingTailnet = self.settings.reach == .tailnet && settings.reach == .domain
            guard save(keys, settings), setUp else { return }
            if leavingTailnet { await Tailscale.stopServing() }
            await restart()
        }
    }

    /// The first run's "Start fresh": the server makes a new archive.
    func startFresh(_ keys: Keys, _ settings: HostSettings) async {
        await exclusive {
            guard save(keys, settings) else { return }
            openAtLogin(true)
            setUp = true
            await restart()
        }
    }

    /// An export from this Mac or another into this install, all or nothing; the server refuses an install that
    /// isn't empty. It is stopped meanwhile, then every child starts again.
    func importExport(from folder: URL, _ keys: Keys, _ settings: HostSettings) async {
        await exclusive {
            guard save(keys, settings) else { return }
            await supervisor.halt(.server)
            progress = "Importing \(folder.lastPathComponent)…"
            if await runArchive("import", folder: folder), !setUp {
                openAtLogin(true)
                setUp = true
            }
            if setUp { await restart() }
        }
    }

    /// Everything into a new folder; safe while the server runs.
    func export(to folder: URL) async {
        await exclusive {
            progress = "Exporting to \(folder.lastPathComponent)…"
            _ = await runArchive("export", folder: folder)
        }
    }

    /// `lifelog-server export|import <folder>`, with only the archive's paths; how it went is in `progress`.
    private func runArchive(_ command: String, folder: URL) async -> Bool {
        try? FileManager.default.createDirectory(
            at: Self.support.appending(path: "audio"), withIntermediateDirectories: true)
        let result = await shell(
            Child.server.executable, [command, folder.path],
            environment: Host.archiveEnvironment(support: Self.support))
        let outcome = Host.archiveResult(command, status: result.status, output: result.output)
        progress = outcome.message
        return outcome.ok
    }

    /// Open at login on or off; a refusal shows.
    func openAtLogin(_ on: Bool) {
        do {
            try on ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister()
        } catch {
            problem = "Open at login: \(error.localizedDescription)"
        }
    }

    // MARK: Summaries

    /// The helper's own ChatGPT login is there, read again after each sign-in.
    private(set) var codexSignedIn = Summaries.codexSignedIn
    /// `codex login`, while a sign-in to ChatGPT waits in the browser.
    private var login: Process?
    var signingIn: Bool { login != nil }

    /// The engine summaries run on: the server's switch, as the phone's Settings sets it.
    func choose(_ engine: LLMEngine) async {
        let body = try? JSONEncoder().encode(["engine": engine.rawValue])
        let ok = await request("/switches", token: secrets.deviceToken, method: "PUT", body: body) != nil
        progress = ok ? "" : "The engine wasn't changed: the server didn't answer."
        await refreshStatus()
    }

    /// Signs the helper's own Codex in with the owner's ChatGPT, in the browser, outside `exclusive` so it blocks no
    /// Save; stopped by Cancel or after 10 minutes. The helper reads the login on every call: no restart.
    func signInToChatGPT() async {
        guard login == nil else { return }
        let process = Process()
        process.executableURL = Child.codex
        process.arguments = Summaries.codexLogin
        process.environment = CLI.environment(adding: Summaries.codexLoginEnvironment)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try Summaries.makeCodexHome()
            try process.run()
        } catch {
            progress = "The ChatGPT sign-in didn't start: \(error.localizedDescription)"
            return
        }
        login = process
        progress = "Sign in to ChatGPT in your browser…"
        let deadline = Date.now.addingTimeInterval(600)
        while process.isRunning, Date.now < deadline { try? await Task.sleep(for: .milliseconds(500)) }
        CLI.stop(process)
        login = nil
        codexSignedIn = Summaries.codexSignedIn
        progress = codexSignedIn ? "Signed in to ChatGPT." : "The ChatGPT sign-in didn't finish."
    }

    func cancelSignIn() {
        login.map { CLI.stop($0) }
    }

    /// Keeps the token `claude setup-token` printed, then starts the helper again, which reads it at launch.
    func saveClaudeToken(_ pasted: String) async {
        guard let token = Summaries.claudeToken(pasted) else {
            progress = "Paste the one token `claude setup-token` printed."
            return
        }
        await exclusive {
            do {
                var updated = try Secrets.load(from: Secrets.file)
                updated.claudeToken = token
                try updated.save(to: Secrets.file)
                secrets = updated
            } catch {
                problem = "The Claude token wasn't saved: \(error.localizedDescription)"
                return
            }
            progress = "Claude token saved."
            if setUp { await supervisor.restart(.quiet) }
        }
    }

    /// Life's lifelog settings: the address and the reader's token (corrections scope).
    func copyReaderSettings() {
        guard let server, let token = secrets.readerToken else { return }
        copy("lifelog url: \(server.absoluteString)\nLIFELOG_TOKEN=\(token)")
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func checkTailscale() async {
        tailnet = await Tailscale.serve(serving: setUp && settings.reach == .tailnet)
        if settings.reach == .tailnet, case .serving(let url) = tailnet { server = url }
    }

    /// The menu's: `/status/live`, owner-only, with the phone's token.
    func refreshStatus() async {
        status = await request("/status/live", token: secrets.deviceToken).flatMap(HostStatus.decode)
        statusAt = .now
    }

    /// The status window's, on open and on "Check now": the full `/status` with the archive checks, the last day's
    /// problems and latency, read with the reader's token (least privilege).
    func refreshFullStatus() async {
        fullStatus = await request("/status", token: secrets.readerToken).flatMap(HostStatus.decode)
        fullStatusAt = .now
    }

    /// The server on loopback with `token`: the answer's body when it is a 200, else nil.
    private func request(_ path: String, token: String?, method: String = "GET", body: Data? = nil) async -> Data? {
        guard let token, let url = URL(string: Host.loopback + path) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return data
    }

    /// Read again first: the helper may have written its own fields since launch.
    private func save(_ keys: Keys, _ settings: HostSettings) -> Bool {
        do {
            var updated = try Secrets.load(from: Secrets.file)
            updated.elevenLabsKey = keys.elevenLabs.isEmpty ? nil : keys.elevenLabs
            updated.openAIKey = keys.openAI.isEmpty ? nil : keys.openAI
            updated.cloudflareToken = keys.cloudflare.isEmpty ? nil : keys.cloudflare
            updated = Host.minted(updated)
            try updated.save(to: Secrets.file)
            secrets = updated
        } catch {
            problem = "The settings weren't saved: \(error.localizedDescription)"
            return false
        }
        settings.save()
        self.settings = settings
        problem = nil
        return true
    }

    private func address() async -> URL? {
        switch settings.reach {
        case .domain:
            return Host.domainAddress(settings.domain)
        case .tailnet:
            tailnet = await Tailscale.serve()
            if case .serving(let url) = tailnet { return url }
            return nil
        }
    }

    // MARK: How each child runs

    private func launch(_ child: Child) -> Launch {
        switch child {
        case .server:
            return serverLaunch()
        case .quiet:
            return .run(arguments: [], environment: ["LIFELOG_URL": Host.loopback, "LIFELOG_CODEX": Child.codex.path])
        case .tunnel:
            guard settings.reach == .domain else { return .skip }
            guard let token = secrets.cloudflareToken else {
                return .blocked("Add your Cloudflare tunnel token in Settings.")
            }
            return .run(arguments: Host.tunnelArguments(), environment: ["TUNNEL_TOKEN": token])
        case .identity:
            guard settings.speakers else { return .skip }
            switch identityInstall {
            case .needed, .installing:
                return .blocked("Installing speaker recognition (about 630 MB the first time)…")
            case .failed(let why):
                return .blocked("Speaker recognition didn't install: \(why). Save in Settings to try again.")
            case .done:
                return .run(
                    arguments: [Child.identityScript.path],
                    environment: Host.identityEnvironment(home: Child.identityHome, secrets: secrets))
            }
        }
    }

    private func serverLaunch() -> Launch {
        guard secrets.elevenLabsKey != nil else {
            return .blocked("Add your ElevenLabs key in Settings to start transcribing.")
        }
        let extra: [String: String]
        do {
            let file = try Secrets.ownerOnly(Self.serverEnv)
            extra = file.map { Host.environmentFile(String(decoding: $0, as: UTF8.self)) } ?? [:]
        } catch {
            return .blocked("lifelog's server.env: \(error)")
        }
        try? FileManager.default.createDirectory(
            at: Self.support.appending(path: "audio"), withIntermediateDirectories: true)
        let restic =
            settings.backups
            ? Host.Restic(binary: Child.helpers.appending(path: "restic"), repository: Self.backupRepository) : nil
        return .run(
            arguments: [],
            environment: Host.serverEnvironment(
                support: Self.support, secrets: secrets, server: server, restic: restic, identity: settings.speakers,
                build: Bundle.main.object(forInfoDictionaryKey: "LifelogCommit") as? String, extra: extra))
    }
}

/// Tailscale Serve: HTTPS on the tailnet in front of the server's port, set at each launch and each save (Serve,
/// never Funnel: lifelog stays inside the owner's tailnet).
enum Tailscale {
    static var cli: URL? {
        [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
        ]
        .first(where: FileManager.default.isExecutableFile(atPath:)).map { URL(filePath: $0) }
    }

    /// Tailscale's state; with `serving`, Serve set in front of the server.
    static func serve(serving: Bool = true) async -> Tailnet {
        guard let cli else { return .missing }
        let status = await shell(cli, ["status", "--json"], errors: false)
        guard status.status == 0, let address = Host.tailnetAddress(status: Data(status.output.utf8)) else {
            return .signedOut
        }
        guard serving else { return .serving(address) }
        return await shell(cli, ["serve", "--bg", "--https=443", Host.loopback]).status == 0
            ? .serving(address) : .signedOut
    }

    /// Serve off, when phones move to the owner's own domain.
    static func stopServing() async {
        guard let cli else { return }
        _ = await shell(cli, ["serve", "--https=443", "off"])
    }
}
