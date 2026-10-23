// lifelog-quiet: reports to the lifelog server which processes have the microphone on, and when the Mac sleeps, so
// the server leaves the Pendant's audio of the owner's dictation out of transcription (apps/dictation/README.md).
// It is a sensor and a runner: which apps count as dictation, and every other rule, is the server's.
//
// It watches Core Audio's per-process "capturing input" flag (macOS 14.2+) of every process using audio, and sends
// the set of those capturing whenever it changes. No microphone permission, nothing read from the apps. It keeps one
// WebSocket open to the server and sends each event on it. Events the server hasn't acked wait in a JSON file and go
// again, in order, on every new socket, before its hello. The token is the Mac's own (it opens only the socket), read
// from `secrets.json` (QuietCore/Secrets.swift). `--list` prints every process Core Audio knows, with its flag, to
// check the bundle ids.
//
// The server also sends model calls on the socket (`llm`): Codex or Claude Code on the selected subscription, killed
// at the call's timeout, with the raw output on the same socket. `--setup-codex` signs in the helper's dedicated
// ChatGPT login; `--setup-claude-token` stores in `secrets.json` the token `claude setup-token` prints.
//
// On power it holds off idle sleep, so summaries run while the owner is away from the Mac.
import AppKit
import CoreAudio
import Foundation
import IOKit.ps
import IOKit.pwr_mgt
import Network
import QuietCore

/// The server: Lifelog Host passes it; a helper run on its own has it in its LaunchAgent (README, Install).
let server = ProcessInfo.processInfo.environment["LIFELOG_URL"] ?? ""
let outboxFile = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Application Support/lifelog-quiet/outbox.json")

func log(_ message: String) {
    FileHandle.standardError.write(Data("\(Date.now.formatted(.iso8601)) \(message)\n".utf8))
}

// MARK: Core Audio

enum Audio {
    static func property(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    /// One object per process using audio.
    static func processes() -> [AudioObjectID] {
        var address = property(kAudioHardwarePropertyProcessObjectList)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func bundleID(_ process: AudioObjectID) -> String? {
        var address = property(kAudioProcessPropertyBundleID)
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var value: Unmanaged<CFString>?
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(process, &address, 0, nil, &size, $0)
        }
        guard status == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    /// Its bundle id, or for a process without one, its executable's name.
    static func name(_ process: AudioObjectID) -> String? {
        if let id = bundleID(process), !id.isEmpty { return id }
        var address = property(kAudioProcessPropertyPID)
        var size = UInt32(MemoryLayout<pid_t>.size)
        var pid: pid_t = 0
        guard AudioObjectGetPropertyData(process, &address, 0, nil, &size, &pid) == noErr, pid > 0 else { return nil }
        var name = [UInt8](repeating: 0, count: 256)
        let length = proc_name(pid, &name, UInt32(name.count))
        return length > 0 ? String(decoding: name.prefix(Int(length)), as: UTF8.self) : nil
    }

    static func isCapturing(_ process: AudioObjectID) -> Bool {
        var address = property(kAudioProcessPropertyIsRunningInput)
        var size = UInt32(MemoryLayout<UInt32>.size)
        var value: UInt32 = 0
        return AudioObjectGetPropertyData(process, &address, 0, nil, &size, &value) == noErr && value != 0
    }
}

// MARK: Secrets

/// Read once at launch, then kept in memory. Refuses a file others can read.
func loadSecrets() -> Secrets {
    do {
        let secrets = try Secrets.load(from: Secrets.file)
        if secrets.macToken == nil {
            log("no Mac token in \(Secrets.file.path) (README, Install step 3); the socket can't open without it")
        }
        return secrets
    } catch {
        log("not starting: \(error)")
        exit(1)
    }
}

let claudeUsageFile = FileManager.default.homeDirectoryForCurrentUser
    .appending(path: "Library/Application Support/lifelog-quiet/claude-usage.json")

// MARK: The helper

/// Everything runs on `queue`: Core Audio's listeners, timers, sleep, the socket and network answers all land there,
/// so its state needs no lock.
final class Helper: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "lifelog-quiet")
    /// Every process using audio, with its name and listener (needed to remove it).
    private var watched: [AudioObjectID: (name: String, listener: AudioObjectPropertyListenerBlock)] = [:]
    /// Events the server hasn't acked yet, oldest first, mirrored in `outboxFile`.
    private var outbox = Outbox()
    /// The processes capturing as last reported; nil until the first report, which always goes.
    private var reported: [String]?
    private var asleep = false
    /// The socket to the server; `nil` while asleep or waiting to reconnect. It counts once it is open.
    private var socket: URLSessionWebSocketTask?
    private var isOpen = false
    private var awaitingPong = false
    private var backoff = Backoff()
    private var reconnecting = false
    private var pinger: DispatchSourceTimer?
    private var checker: DispatchSourceTimer?
    private var checks = 0
    private let network = NWPathMonitor()
    /// Calls running now, by id: the hello lists them.
    private var running: Set<String> = []
    /// Outputs finished while no socket was open, sent once one is.
    private var unsent: [LLMOutput] = []
    /// Calls killed for running too long.
    private var timedOut: Set<String> = []
    private lazy var session: URLSession = {
        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = queue
        return URLSession(configuration: .default, delegate: self, delegateQueue: delegateQueue)
    }()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    override init() {
        let style = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(style.format(date))
        }
        decoder.dateDecodingStrategy = .custom { decoder in
            try style.parse(try decoder.singleValueContainer().decode(String.self))
        }
        super.init()
    }

    func start() {
        queue.async { [self] in
            do {
                // Protocol 1's ranges become events here (Outbox.read): the cutover loses none.
                outbox = try Outbox.read(Data(contentsOf: outboxFile), using: decoder)
                save()
            } catch CocoaError.fileReadNoSuchFile {
            } catch {
                // Its events are lost to the server; the file stays for the owner, never overwritten.
                log("outbox unreadable, kept as outbox.json.unreadable: \(error)")
                try? FileManager.default.moveItem(at: outboxFile, to: outboxFile.appendingPathExtension("unreadable"))
            }
            var address = Audio.property(kAudioHardwarePropertyProcessObjectList)
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue) {
                [self] _, _ in rewatch()
            }
            rewatch()
            // Each process's input flag has a listener (rewatch), which says when it changes. ponytail: Core Audio
            // doesn't always call it (missed FluidVoice dictations on 2026-10-10), so a read of the flags each
            // second backs it up: a missed start then costs at most the server's 1 s padding. No network, only
            // property reads; slow it or drop it if the listener proves reliable.
            let check = DispatchSource.makeTimerSource(queue: queue)
            check.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
            check.setEventHandler { [self] in
                checks += 1
                // Every 5 s, look for processes launched without the process-list listener firing.
                if checks % 5 == 0 { rewatch() } else { refresh() }
            }
            check.resume()
            checker = check
            // Protocol pings keep the socket honest: a missing pong means it is dead. The leeway lets macOS batch
            // the wake-ups.
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 30, repeating: 30, leeway: .seconds(5))
            timer.setEventHandler { [self] in
                ping()
                refreshUsage()
            }
            timer.resume()
            pinger = timer
            // The network back (Wi-Fi rejoined, a dark wake): reconnect now, not after the backoff.
            network.pathUpdateHandler = { [self] path in
                guard path.status == .satisfied, socket == nil, !asleep else { return }
                backoff.reset()
                connect()
            }
            network.start(queue: queue)
            connect()
        }
    }

    /// The server hears "sleep", then the socket closes cleanly so the server freezes its watermark now.
    func sleep() {
        queue.async { [self] in
            asleep = true
            enqueue(capturing: nil) { [self] in
                socket?.cancel(with: .goingAway, reason: nil)
                socket = nil
                isOpen = false
            }
        }
    }

    /// A fresh socket: one left from before sleep may be dead without knowing it. Its hello says the Mac is awake.
    func wake() {
        queue.async { [self] in
            asleep = false
            socket?.cancel()
            socket = nil
            isOpen = false
            backoff.reset()
            refresh()
            connect()
        }
    }

    /// Follows the processes using audio as they come and go (launched, quit, updated).
    private func rewatch() {
        var current: [AudioObjectID: String] = [:]
        for process in Audio.processes() {
            if let name = watched[process]?.name ?? Audio.name(process) { current[process] = name }
        }
        var address = Audio.property(kAudioProcessPropertyIsRunningInput)
        for (process, entry) in watched where current[process] == nil {
            AudioObjectRemovePropertyListenerBlock(process, &address, queue, entry.listener)
            watched[process] = nil
        }
        for (process, name) in current where watched[process] == nil {
            let listener: AudioObjectPropertyListenerBlock = { [self] _, _ in refresh() }
            AudioObjectAddPropertyListenerBlock(process, &address, queue, listener)
            watched[process] = (name, listener)
        }
        refresh()
    }

    /// The processes capturing now, by name, sorted and once each.
    private func capturing() -> [String] {
        Set(watched.filter { Audio.isCapturing($0.key) }.map(\.value.name)).sorted()
    }

    private func refresh() {
        let now = capturing()
        guard now != reported else { return }
        log("capturing: \(now.isEmpty ? "nothing" : now.joined(separator: ", "))")
        reported = now
        enqueue(capturing: now)
    }

    /// A new event, now: the processes capturing, or nil for sleep. Kept until the server acks it; the outbox goes
    /// out, then `done`, once sent or when no socket is open.
    private func enqueue(capturing: [String]?, then done: (@Sendable () -> Void)? = nil) {
        outbox.add(capturing: capturing, at: .now)
        save()
        sendEvents(then: done)
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(
                at: outboxFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encoder.encode(outbox).write(to: outboxFile, options: .atomic)
        } catch {
            log("outbox not saved: \(error)")
        }
    }

    // MARK: Events

    /// Sends every unacked event on the open socket, oldest first; the server applies each seq once and acks it each
    /// time. Nothing here retries on a timer: a new socket and every ping send them again.
    private func sendEvents(then done: (@Sendable () -> Void)? = nil) {
        let frames = outbox.frames(using: encoder)
        guard let task = socket, isOpen, !frames.isEmpty else {
            done?()
            return
        }
        for (index, frame) in frames.enumerated() {
            task.send(.string(frame)) { [self] error in
                queue.async { [self] in
                    if let error { drop(task, error.localizedDescription) }
                    if index == frames.count - 1 { done?() }
                }
            }
        }
    }

    // MARK: The socket

    /// Opens the socket at this helper's protocol, authenticated with the Mac's token.
    private func connect() {
        guard socket == nil, !asleep else { return }
        let address = server.replacingOccurrences(of: "http", with: "ws", options: .anchored)
        guard let token = secrets.macToken,
            let url = URL(string: address)?.appending(path: "quiet-ranges/socket")
                .appending(queryItems: [URLQueryItem(name: "protocol", value: String(macProtocol))])
        else {
            log("no Mac token in \(Secrets.file.path) for the socket; retrying")
            return reconnect()
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        socket = task
        task.resume()
        listen(task)
    }

    /// The server speaks to ack an event or to ask for a model call; reading is also how a closed socket shows up.
    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [self] result in
            queue.async { [self] in
                switch result {
                case let .success(.string(message)):
                    if outbox.ack(message: message) {
                        save()
                    } else if let applied = Outbox.welcome(message: message) {
                        welcomed(task, applied: applied)
                    } else if let request = LLMRequest(message: message) {
                        run(request)
                    }
                    listen(task)
                case .success: listen(task)
                case .failure: drop(task, "closed")
                }
            }
        }
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
    ) {
        queue.async { [self] in
            guard webSocketTask === socket else { return }
            awaitingPong = false
            backoff.reset()
            log("socket open; waiting for the welcome")
        }
    }

    /// The server said the last seq it applied: a file no welcome numbered yet goes above it (`Outbox.rebase`), then
    /// the outbox goes out, then the hello, which vouches for everything sent before it.
    /// Until then nothing is sent.
    private func welcomed(_ task: URLSessionWebSocketTask, applied: Int) {
        guard task === socket else { return }
        outbox.rebase(above: applied)
        save()
        isOpen = true
        sendEvents()
        task.send(.string(helloMessage(running: Array(running)))) { [self] error in
            guard let error else { return }
            queue.async { [self] in drop(task, error.localizedDescription) }
        }
        refreshUsage()
        unsent.forEach(answer)
        unsent = []
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        queue.async { [self] in drop(task, error?.localizedDescription ?? "closed") }
    }

    private func ping() {
        guard let task = socket, isOpen else { return }
        if awaitingPong { return drop(task, "no pong in 30 s") }
        // Covers an event the server could not apply (it closes the socket then, but a resend costs nothing).
        sendEvents()
        awaitingPong = true
        task.sendPing { [self] error in
            queue.async { [self] in
                guard task === socket else { return }
                if let error { drop(task, error.localizedDescription) } else { awaitingPong = false }
            }
        }
    }

    /// Forgets a socket that closed or went quiet and opens another after the backoff. Asleep, it waits for the wake.
    private func drop(_ task: URLSessionTask, _ why: String) {
        guard task === socket else { return }
        refused(task)
        task.cancel()
        socket = nil
        isOpen = false
        let status = (task.response as? HTTPURLResponse)?.statusCode
        let hint =
            switch status {
            case 401: " (is MAC_TOKEN_HASH set?)"
            case 426: " (the server speaks another protocol: install the helper built with it)"
            default: ""
            }
        log("socket \(why)\(hint); reconnecting")
        reconnect()
    }

    /// The current socket closed over an event (`Outbox.refused`): an invalid one is logged and dropped, the capture set
    /// following at once; a seq behind marks the file for renumbering. Only the current socket, and on `queue`, so
    /// the acks it received before the close are already applied. The reason, not the code: Foundation's CloseCode
    /// has no case for a custom one.
    private func refused(_ task: URLSessionTask) {
        guard let reason = (task as? URLSessionWebSocketTask)?.closeReason else { return }
        let why = String(decoding: reason, as: UTF8.self)
        let now = capturing()
        let dropped = outbox.refused(reason: why, capturing: now, at: .now)
        save()
        if let dropped {
            reported = now
            log("the server refused event \(dropped.seq) as invalid; dropped: \(dropped.frame(using: encoder) ?? "?")")
        } else if why == "seq behind" {
            log("the server applied more than the outbox knows; the next welcome renumbers it")
        }
    }

    private func reconnect() {
        guard !reconnecting, !asleep else { return }
        reconnecting = true
        queue.asyncAfter(deadline: .now() + backoff.next()) { [self] in
            reconnecting = false
            connect()
        }
    }

    // MARK: Model calls

    /// Usage reads never generate model calls. The status-line bridge writes Claude's observed limits locally;
    /// Codex's app-server can read its account limits even while no model call is running.
    private var usageReadAt = Date.distantPast
    private var readingUsage = false

    private func refreshUsage() {
        guard isOpen, !asleep, !readingUsage, Date.now.timeIntervalSince(usageReadAt) >= 5 * 60 else { return }
        readingUsage = true
        usageReadAt = .now
        // Not beside a model call: two Codex processes on one CODEX_HOME could both refresh its login token.
        let codexFree = running.isEmpty
        DispatchQueue.global(qos: .utility).async { [self] in
            let claude = (try? Data(contentsOf: claudeUsageFile)).flatMap {
                try? JSONDecoder().decode(SubscriptionReading.self, from: $0)
            }
            let codex =
                codexFree && Summaries.codexSignedIn
                ? Summaries.codexBinary().flatMap { CodexUsageReader.read(binary: $0, home: Summaries.codexHome) } : nil
            queue.async { [self] in
                readingUsage = false
                guard isOpen, let socket else { return }
                for (engine, reading) in [("claude", claude), ("codex", codex)] {
                    guard let message = reading?.message(engine: engine) else { continue }
                    socket.send(.string(message)) { _ in }
                }
            }
        }
    }

    /// Runs one call and answers it on whichever socket is open then (the server keeps a call across a reconnect and
    /// takes even a late answer). The server sends no more calls than it wants run at once.
    private func run(_ request: LLMRequest) {
        let started = Date.now
        running.insert(request.id)
        model(request) { [self] output in
            running.remove(request.id)
            let ms = Int(Date.now.timeIntervalSince(started) * 1000)
            switch output {
            case let .ran(id, _, _, _, status, timedOut):
                log("llm \(id) \(ms) ms: \(timedOut ? "killed at its timeout" : "exit \(status)")")
            case let .unrun(id, _, why):
                log("llm \(id): not run (\(why))")
            }
            answer(output)
        }
    }

    /// On the open socket, or once one is: a send that fails keeps the output for the next socket.
    private func answer(_ output: LLMOutput) {
        guard let socket, isOpen else { return unsent.append(output) }
        socket.send(.string(output.message)) { [self] error in
            guard let error else { return }
            queue.async { [self] in
                drop(socket, error.localizedDescription)
                answer(output)
            }
        }
    }

    /// The selected CLI in a fresh temp folder, with no tools, personal settings, MCP servers or session, signed in with the
    /// owner's subscription token; killed at the call's timeout. Prompt, output and errors go through files, so no
    /// pipe can fill up. `done` runs on `queue`.
    private func model(_ request: LLMRequest, then done: @escaping @Sendable (LLMOutput) -> Void) {
        let token = request.engine == .claude ? secrets.claudeToken : nil
        if request.engine == .claude, token == nil {
            return done(.unrun(id: request.id, signedOut: true, why: "no claudeToken in secrets.json"))
        }
        guard let binary = request.engine == .claude ? Summaries.claudeBinary() : Summaries.codexBinary() else {
            return done(.unrun(id: request.id, signedOut: false, why: "\(request.engine.rawValue) CLI not found"))
        }
        if request.engine == .codex, !Summaries.codexSignedIn {
            return done(
                .unrun(id: request.id, signedOut: true, why: "sign in: Lifelog Host → Settings → Summaries"))
        }
        let files = FileManager.default
        let folder = files.temporaryDirectory.appending(path: "lifelog-llm-\(UUID().uuidString)")
        let input = folder.appending(path: "prompt.txt")
        let output = folder.appending(path: "out.json")
        let errors = folder.appending(path: "err.txt")
        let schema = folder.appending(path: "schema.json")
        let final = folder.appending(path: "final.json")
        let process = Process()
        process.executableURL = URL(filePath: binary)
        process.currentDirectoryURL = folder
        process.arguments =
            request.engine == .codex
            ? request.codexArguments(schema: schema.path, output: final.path, directory: folder.path)
            : request.claudeArguments
        process.environment = CLI.environment(
            adding: request.engine == .claude
                ? ["CLAUDE_CODE_OAUTH_TOKEN": token ?? "", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": String(request.maxTokens)]
                : ["CODEX_HOME": Summaries.codexHome.path])
        process.terminationHandler = { [self] _ in
            queue.async { [self] in
                let read = { (file: URL) in String(decoding: (try? Data(contentsOf: file)) ?? Data(), as: UTF8.self) }
                let reply = LLMOutput.ran(
                    id: request.id, stdout: read(output), stderr: read(errors),
                    final: request.engine == .codex ? read(final) : nil, status: process.terminationStatus,
                    timedOut: timedOut.remove(request.id) != nil)
                try? FileManager.default.removeItem(at: folder)
                done(reply)
            }
        }
        do {
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
            try Data(request.prompt.utf8).write(to: input)
            try Data(request.schema.utf8).write(to: schema)
            for file in [output, errors] { try Data().write(to: file) }
            process.standardInput = try FileHandle(forReadingFrom: input)
            process.standardOutput = try FileHandle(forWritingTo: output)
            process.standardError = try FileHandle(forWritingTo: errors)
            try process.run()
        } catch {
            try? files.removeItem(at: folder)
            return done(.unrun(id: request.id, signedOut: false, why: "\(request.engine.rawValue) did not start"))
        }
        queue.asyncAfter(deadline: .now() + request.timeout) { [self] in
            guard process.isRunning else { return }
            timedOut.insert(request.id)
            // One that ignores SIGTERM would run on for good.
            CLI.stop(process)
        }
    }
}

// MARK: Main

// The documented Claude Code statusLine payload enters here, before secrets or audio monitoring are loaded.
// Only the limits are written, and nothing is printed: an existing status line can call this alongside its renderer.
if CommandLine.arguments.contains("--claude-usage") {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let reading = SubscriptionReading.claude(input) else { exit(0) }
    let folder = claudeUsageFile.deletingLastPathComponent()
    try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try JSONEncoder().encode(reading).write(to: claudeUsageFile, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: claudeUsageFile.path)
    exit(0)
}

if CommandLine.arguments.contains("--list") {
    for process in Audio.processes() {
        print("\(Audio.isCapturing(process) ? "capturing" : "idle     ")  \(Audio.name(process) ?? "?")")
    }
    exit(0)
}

if CommandLine.arguments.contains("--setup-claude-token") {
    FileHandle.standardError.write(Data("Paste the token `claude setup-token` printed, then Return: ".utf8))
    guard let token = Summaries.claudeToken(readLine() ?? "") else {
        print("No token given; nothing stored.")
        exit(1)
    }
    var stored = loadSecrets()
    stored.claudeToken = token
    try stored.save(to: Secrets.file)
    print("Stored in \(Secrets.file.path). Restart the helper to use it.")
    exit(0)
}

if CommandLine.arguments.contains("--setup-codex") {
    guard let binary = Summaries.codexBinary() else {
        print("Codex CLI not found.")
        exit(1)
    }
    try Summaries.makeCodexHome()
    let login = Process()
    login.executableURL = URL(filePath: binary)
    login.arguments = Summaries.codexLogin
    login.environment = CLI.environment(adding: Summaries.codexLoginEnvironment)
    try login.run()
    login.waitUntilExit()
    exit(login.terminationStatus)
}

/// Holds off idle sleep while the Mac is on power, so model calls run while the owner is away. The screen still sleeps,
/// and closing the lid still sleeps the Mac (the helper then says "sleep"). On battery, macOS decides.
enum StayAwake {
    /// Touched only on the main run loop.
    nonisolated(unsafe) private static var assertion: IOPMAssertionID?

    static func start() {
        update()
        let source = IOPSNotificationCreateRunLoopSource({ _ in StayAwake.update() }, nil).takeRetainedValue()
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
    }

    static func update() {
        let info = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        let onPower = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? == kIOPMACPowerKey
        if onPower, assertion == nil {
            var id = IOPMAssertionID(0)
            let created = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "lifelog: summaries run while the Mac is on power" as CFString, &id)
            if created == kIOReturnSuccess {
                assertion = id
                log("on power: idle sleep held off")
            }
        } else if !onPower, let id = assertion {
            IOPMAssertionRelease(id)
            assertion = nil
            log("on battery: idle sleep allowed")
        }
    }
}

if server.isEmpty {
    log("not starting: LIFELOG_URL names no server (README, Install)")
    exit(1)
}
let secrets = loadSecrets()
let helper = Helper()
helper.start()
StayAwake.start()
let workspace = NSWorkspace.shared.notificationCenter
_ = workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in helper.sleep() }
_ = workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in helper.wake() }
log("reporting which processes capture audio to \(server) (protocol \(macProtocol))")
RunLoop.main.run()
