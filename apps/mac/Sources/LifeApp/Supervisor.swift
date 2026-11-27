import AppKit
import Observation

/// What launchd did for the owner's checkout, for the app: the archive and the watcher always running (started again
/// a few seconds after either stops), the desk too while it is on, and the nightly tick every 30 minutes (its own
/// schedule decides what is due).
@MainActor @Observable
final class Supervisor {
  /// The helper's last `app` answer: whether Life is set up, its sources, its newest report, its status reads.
  private(set) var info: Info?
  /// The status snapshot, as the watcher last served it.
  private(set) var snapshot: StatusSnapshot?
  private var services: [String: Process] = [:]
  private var nightly: Process?
  private var timer: Timer?
  private var looks: Timer?

  init() {
    // However the app ends (Quit, an update's relaunch), Life's processes end with it: never two watchers.
    NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.stop() } }
  }

  /// The helpers kept running: the archive, the watcher, and the desk only while `desk` is set.
  private var kept: [[String]] { [["archive"], ["watch"]] + (info?.desk == true ? [["desk"]] : []) }
  static let tickEvery: TimeInterval = 30 * 60

  func refresh() async {
    info = await Helper.info() ?? info
    await refreshSnapshot()
  }

  /// The status snapshot again, from the watcher: the panel when it opens, the status window every 3 s while open.
  func refreshSnapshot() async {
    snapshot = await info?.status.snapshot()
  }

  func start() async {
    await refresh()
    guard info?.started == true else { return }
    if services.isEmpty {
      for args in kept { keep(args) }
      // Voice's launchd jobs as the settings now say (`life voice start`): at launch and after every change. They
      // outlive the app; a job whose launch is unchanged is left running. Not awaited: nothing above may wait (two
      // starts at once would keep two watchers).
      Task { _ = await Helper.run(["voice", "start"]) }
    }
    if timer == nil {
      tick()
      timer = Timer.scheduledTimer(withTimeInterval: Self.tickEvery, repeats: true) { _ in
        Task { @MainActor in self.tick() }
      }
      // The panel shows the status snapshot as of the last minute (and reads it again when opened).
      looks = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
        Task { @MainActor in await self.refreshSnapshot() }
      }
    }
  }

  /// The app ends: every process of Life's with it.
  func stop() {
    timer?.invalidate()
    timer = nil
    looks?.invalidate()
    looks = nil
    endServices()
    nightly?.terminate()
    nightly = nil
  }

  /// Settings changed: the helper reads them once per process, so each service starts again (a nightly running
  /// finishes on the settings it started with).
  func restart() async {
    endServices()
    await start()
  }

  private func endServices() {
    for p in services.values { p.terminate() }
    services = [:]
  }

  private func keep(_ args: [String]) {
    let name = args.joined(separator: " ")
    let p = Helper.process(args)
    p.standardOutput = log(name)
    p.standardError = p.standardOutput
    p.terminationHandler = { [weak self] _ in
      Task { @MainActor in
        guard let self, self.services[name] === p else { return }
        try? await Task.sleep(for: .seconds(5))
        if self.services[name] === p { self.keep(args) }
      }
    }
    do {
      try p.run()
      services[name] = p
    } catch {
    }
  }

  /// A nightly still running is left to finish (its own lock would refuse a second).
  private func tick() {
    if nightly?.isRunning == true { return }
    let p = Helper.process(["memory", "nightly"])
    p.standardOutput = log("memory-nightly")
    p.standardError = p.standardOutput
    try? p.run()
    nightly = p
  }

  /// The helper's output: ~/Library/Logs/life-<name>.log, opened to append (`O_APPEND`), so the server's one
  /// rotation rule (`rotateProcessLogs`, core/service.ts) can empty it while the helper writes.
  private func log(_ name: String) -> FileHandle? {
    let path = FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library/Logs/life-\(name.replacingOccurrences(of: " ", with: "-")).log").path
    let fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    return fd < 0 ? nil : FileHandle(fileDescriptor: fd, closeOnDealloc: true)
  }
}
