import AppKit
import Observation

/// What launchd did for the owner's checkout, for the app: the archive and the watcher always running (started again
/// a few seconds after either stops), and the nightly tick every 30 minutes (its own guard decides what is due).
@MainActor @Observable
final class Supervisor {
  /// The helper's last `app` answer: whether Life is set up, its sources, its newest report, its status page.
  private(set) var info: Info?
  /// The status page's plate, as the watcher last served it.
  private(set) var plate: Plate?
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

  static let services = [["archive"], ["watch"]]
  static let tickEvery: TimeInterval = 30 * 60

  func refresh() async {
    info = await Helper.info() ?? info
    plate = await info?.status.plate()
  }

  func start() async {
    await refresh()
    guard info?.started == true else { return }
    if services.isEmpty {
      for args in Self.services { keep(args) }
    }
    if timer == nil {
      tick()
      timer = Timer.scheduledTimer(withTimeInterval: Self.tickEvery, repeats: true) { _ in
        Task { @MainActor in self.tick() }
      }
      // The menu shows the status page's plate as of the last minute.
      looks = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
        Task { @MainActor in self.plate = await self.info?.status.plate() }
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

  /// The helper's output, as the LaunchAgents kept it: ~/Library/Logs/life-<name>.log.
  private func log(_ name: String) -> FileHandle? {
    let url = FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library/Logs/life-\(name.replacingOccurrences(of: " ", with: "-")).log")
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    let h = try? FileHandle(forWritingTo: url)
    h?.seekToEndOfFile()
    return h
  }
}
