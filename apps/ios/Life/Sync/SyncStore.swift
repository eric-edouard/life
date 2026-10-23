import AudioPipeline
import BackgroundTasks
import Foundation
import Library
import Network
import Observation
import ServerAPI
import SourceStore
import Synchronization
import Timeline
import UIKit
import Upload

/// The phone's one run owner (docs/voice/sync.md): it starts the Kit driver's run (`Driver`, whose steps are listed there)
/// after each Bluetooth sync that saved audio, on the server's silent push, on an edit, in a `BGProcessingTask`, when
/// the app comes forward. One task does it, one run at a time: a trigger
/// during a run makes one more. While the app is in front and nothing else is asked, that same task follows the feed
/// with a long poll, which a trigger cuts short. A cancelled run loses nothing: the next resumes. The raw backup goes in
/// a second task beside it (`backUp`), so new speech never waits behind an item that takes minutes.
///
/// It also owns the one status every tab shows (`ConnectionSummary`), read from the uploader, the outbox and the last
/// pull, nothing else. Screens read again (`generation`) only when a run or a pull
/// changed something, or the outbox did, and only while the app is in front: once more when it comes forward.
@Observable
final class SyncStore {
    /// The one in Info.plist (`$(LIFE_BUNDLE_ID).processing`, project.yml).
    static let backgroundTaskID =
        (Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String])?.first ?? ""

    private(set) var network = ConnectionSummary.Network.unknown
    /// Bumped whenever the cache, the uploads or the outbox changed while the app is in front, and when it comes
    /// forward: screens read again. Never in the background, where nothing shows them and the reloads cost about a
    /// third of the app's CPU (Oct 20).
    private(set) var generation = 0
    /// Blocks or maps the server doesn't have yet; `nil` before the cutover.
    private(set) var uploads: UploadStatus?
    /// Raw packs and old jobs' audio the bucket doesn't have yet (`Uploader.backUp`).
    private(set) var backup: Uploader.BackupStatus?
    /// The owner's edits not accepted yet, and the refused ones.
    private(set) var pending = PendingEdits([])
    /// The last complete pull: the Mac, the switches, and when it ended (`pulledAt`).
    private(set) var feed = ServerClient.FeedState()
    /// Live conversations waiting, by the feed's reason.
    private(set) var waiting: [WaitingReason: Int] = [:]
    /// The last pull got no answer from the network.
    private(set) var pullFailed = false
    /// What was spent today and this month, refreshed when the app comes forward; `nil` until the server answered.
    private(set) var spending: ServerClient.UsageSummary?
    /// The server this phone is paired with (`DeviceToken.paired`); nil until it is.
    private(set) var server: URL?
    var isPaired: Bool { server != nil }

    @ObservationIgnored private let capture: CaptureStore
    @ObservationIgnored let library: LibraryStore?
    @ObservationIgnored private var driver: Driver?
    /// The capture slot `driver` reads (`CaptureStore.deviceID`).
    @ObservationIgnored private var driverDeviceID: String?
    /// The driver's derived-audio worker, for playback.
    @ObservationIgnored private var worker: DerivedAudioWorker?
    /// The one task that runs and pulls (`loop`).
    @ObservationIgnored private var current: Task<Void, Never>?
    /// A run was asked for since the last one started.
    @ObservationIgnored private var again = false
    /// Only new audio asked for the run waiting, which in the background may wait for `audioGap`.
    @ObservationIgnored private var audioOnly = false
    @ObservationIgnored private var lastRunStart = Date.distantPast
    /// The long poll (or its wait after a failure) going on, which a trigger cancels.
    @ObservationIgnored private var polling: Task<Void, Never>?
    /// The raw backup's round going on, beside the runs (`backUp`).
    @ObservationIgnored private var backingUp: Task<Void, Never>?
    /// Keeps the app running while a run finishes after it went to the background (about 30 s).
    @ObservationIgnored private var awake = UIBackgroundTaskIdentifier.invalid
    @ObservationIgnored private var backgroundRunRequested = false
    /// Read by the uploader off the main actor, to rest between renders in the background.
    private nonisolated static let inBackground = Mutex(false)

    init(capture: CaptureStore, library: LibraryStore?, server: URL? = DeviceToken.paired) {
        self.capture = capture
        self.library = library
        self.server = server
    }

    #if DEBUG
        static func preview(capture: CaptureStore = .preview(), library: LibraryStore? = nil) -> SyncStore {
            SyncStore(capture: capture, library: library, server: nil)
        }
    #endif

    // MARK: Status

    /// Since when the owner has been dictating to the Mac, as the feed last said.
    var macDictatingSince: Date? { feed.mac?.dictatingSince }

    /// Follows the network path for the life of the app; back online, a run goes at once.
    func followNetwork() async {
        #if DEBUG
            // `-offline` fails every request as if there were no network: show what the owner sees then.
            if OfflineProtocol.isRequested { return network = .none }
        #endif
        for await path in NWPathMonitor() {
            let next = ConnectionSummary.Network(path)
            let back = network == .none && next != .none
            if next != network { network = next }
            if back { run() }
        }
    }

    // MARK: Triggers

    /// In the background, a run that only new audio asked for starts at least this long after the previous one started:
    /// cheap runs back to back cost CPU for no gain.
    private static let audioGap: TimeInterval = 15

    /// New audio was saved, the server pushed, the owner edited or came back: run now, or once more after the run going
    /// on. A long poll going on stops for it. `audio`: a Bluetooth sync saved pages; in the background that waits out
    /// `audioGap`, remembered, unless another trigger comes first.
    func run(audio: Bool = false) {
        if UIApplication.shared.applicationState == .background { requestBackgroundRun() }
        audioOnly = audio && (!again || audioOnly)
        again = true
        polling?.cancel()
        guard current == nil else { return }
        stayAwake()
        current = Task {
            await loop()
            current = nil
            if backingUp == nil { endAwake() }
        }
    }

    /// Runs while asked; then, while the app is in front, follows the feed with one long poll after another, so a
    /// word landing on the server shows in seconds.
    private func loop() async {
        while !Task.isCancelled {
            if again {
                // Any other trigger cuts the wait (`polling`, audioOnly false). If iOS suspends the app first, the
                // background task expires, `current` is cancelled and `again` stays set: the next wake's trigger runs it.
                let due = lastRunStart.addingTimeInterval(Self.audioGap)
                if audioOnly, UIApplication.shared.applicationState == .background, due > .now {
                    let wait = Task { _ = try? await Task.sleep(for: .seconds(due.timeIntervalSinceNow)) }
                    polling = wait
                    await wait.value
                    polling = nil
                    continue
                }
                again = false
                audioOnly = false
                await runOnce()
                continue
            }
            guard UIApplication.shared.applicationState == .active, setUp() != nil, isPaired else { return }
            endAwake()
            let poll = Task {
                do {
                    try await pull(wait: 25)
                } catch {
                    noteFailure(error)
                    try? await Task.sleep(for: .seconds(15))
                }
            }
            polling = poll
            await poll.value
            polling = nil
        }
    }

    /// The server's silent push: words or a summary landed, or blocks are wanted. In the background it returns once
    /// the run it started (or joined) ends, so iOS keeps the app running for it.
    func pushed() async {
        appEvent("sync.pushed")
        await runAwake()
    }

    /// Starts a run (or joins the one going on); in the background, returns once it ends, so iOS keeps the app running.
    private func runAwake() async {
        run()
        if UIApplication.shared.applicationState != .active { await current?.value }
    }

    /// Shortcuts' "Sync Life", which may have just launched the app: the same run as a Bluetooth sync, waited for as
    /// a silent push's is. Says what happened, in a sentence.
    func syncForShortcut() async -> String {
        appEvent("intent.sync")
        let linked = await capture.waitForLink()
        if linked { await capture.syncNow() }
        await runAwake()
        if pullFailed { return "No network. The audio is safe on the phone." }
        return linked ? "Synced." : "Pendant out of reach. Uploaded and pulled the rest."
    }

    func becameActive() {
        Self.inBackground.withLock { $0 = false }
        backgroundRunRequested = false
        #if DEBUG
            DeviceToken.importFromEnvironment()
        #endif
        server = DeviceToken.paired
        generation += 1
        Task { await refreshSpending() }
        #if DEBUG
            if FixtureLibrary.isRequested {
                Task {
                    await FixtureLibrary.ready()
                    await readState()
                }
                return
            }
        #endif
        run()
    }

    func wentToBackground() {
        Self.inBackground.withLock { $0 = true }
        polling?.cancel()
        Task { await Self.scheduleBackgroundRun() }
    }

    /// The same run as any other, or the one going on, then the backup round it starts.
    func handle(_ task: BGTask) {
        backgroundRunRequested = false
        if current == nil { run() }
        let running = current
        task.expirationHandler = { @Sendable [weak self] in
            running?.cancel()
            Task { @MainActor in self?.backingUp?.cancel() }
        }
        Task {
            await running?.value
            await backingUp?.value
            task.setTaskCompleted(success: running?.isCancelled == false)
            await Self.scheduleBackgroundRun()
        }
    }

    static func scheduleBackgroundRun() async {
        try? await BGTaskScheduler.shared.submitTaskRequest(BGProcessingTaskRequest(identifier: backgroundTaskID))
    }

    private func requestBackgroundRun() {
        guard !backgroundRunRequested else { return }
        backgroundRunRequested = true
        Task { await Self.scheduleBackgroundRun() }
    }

    private func stayAwake() {
        guard awake == .invalid else { return }
        awake = UIApplication.shared.beginBackgroundTask(withName: "sync") { [weak self] in
            MainActor.assumeIsolated {
                self?.current?.cancel()
                self?.backingUp?.cancel()
                self?.endAwake()
            }
        }
    }

    private func endAwake() {
        guard awake != .invalid else { return }
        UIApplication.shared.endBackgroundTask(awake)
        awake = .invalid
    }

    // MARK: Intents

    /// The owner's edit: kept in the outbox at once (under `id`), shown as waiting, sent by the run it starts. Returns
    /// why it couldn't be kept, `nil` when it was.
    @discardableResult
    func perform(_ intent: OwnerIntent, id: UUID = UUID()) async -> String? {
        guard let library else { return LibraryStore.notOpen }
        do {
            try await library.enqueue(intent, id: id)
        } catch {
            return report(error)
        }
        await readState()
        run()
        return nil
    }

    /// The owner read a refused edit, or took back one still waiting: it goes. Returns whether it was still there.
    @discardableResult
    func dismiss(_ id: UUID) async -> Bool {
        let gone = (try? await library?.dismiss(id)) ?? false
        await readState()
        return gone
    }

    /// A pairing link opened from outside (`onOpenURL`), waiting for the owner to confirm it on screen: a link
    /// could come from anywhere, so it never repoints the app on its own.
    var offeredPairing: Pairing?

    /// Pairs the phone with a server (a link from its Mac, confirmed): the token into the Keychain, the server beside
    /// it. Returns whether both were kept.
    func pair(_ pairing: Pairing) -> Bool {
        offeredPairing = nil
        guard DeviceToken.pair(pairing) else { return false }
        server = DeviceToken.paired
        run()
        return true
    }

    nonisolated static let notPaired =
        "Not paired with a server yet. Scan the pairing code on your Mac with the Camera."

    // MARK: Running

    private func runOnce() async {
        lastRunStart = .now
        guard let driver = setUp() else { return await readState() }
        // A run that failed may have changed something before it stopped.
        var changed = true
        do {
            changed = try await driver.run(capture.status)
            pullFailed = false
            backUp()
        } catch {
            noteFailure(error)
        }
        await readState(changed: changed)
    }

    /// The raw backup, one round at a time in its own lane after a run that reached the server, on Wi-Fi or power: an
    /// item can take minutes, and the runs go on meanwhile. It keeps the app awake as a run does.
    private func backUp() {
        guard backingUp == nil, mayBackUp, let uploader = driver?.uploader, let library else { return }
        stayAwake()
        backingUp = Task {
            do {
                for item in try await uploader.backUp(library: library) { appEvent("backup.skipped", ["item": item]) }
            } catch {
                noteFailure(error)
            }
            backup = (try? await uploader.backupStatus()) ?? backup
            backingUp = nil
            if current == nil { endAwake() }
        }
    }

    /// The feed from the cursor. Screens read again only if it brought something.
    private func pull(wait: Int) async throws {
        guard let driver = setUp() else { return }
        let changed = try await driver.pull(wait: wait)
        pullFailed = false
        if changed {
            await readState()
        } else {
            feed = (try? await library?.feed()) ?? feed
        }
    }

    private func noteFailure(_ error: any Error) {
        if let error = error as? URLError, error.isTransient || error.code == .cancelled {
            pullFailed = error.isTransient
            return
        }
        // Not paired: recording and saving go on, and the status says so.
        if error is CancellationError || error as? ServerClient.ClientError == .notPaired { return }
        _ = report(error)
    }

    /// What screens read beside the cache: the outbox, the feed's single values, the uploads. Then screens read again,
    /// unless a run says it `changed` nothing they show or the app is in the background (`becameActive` catches up).
    private func readState(changed: Bool = true) async {
        guard let library else { return }
        pending = (try? await library.pendingEdits()) ?? pending
        feed = (try? await library.feed()) ?? feed
        // The Lock Screen dials read these from the app group.
        SubscriptionService.claude.save(feed.mac?.subscriptions?.claude)
        SubscriptionService.codex.save(feed.mac?.subscriptions?.codex)
        waiting = (try? await library.waiting()) ?? waiting
        if let uploader = driver?.uploader {
            uploads = (try? await uploader.status()) ?? uploads
            backup = (try? await uploader.backupStatus()) ?? backup
        }
        #if DEBUG
            if FixtureLibrary.isRequested { uploads = FixtureLibrary.uploads }
        #endif
        if changed, UIApplication.shared.applicationState != .background { generation += 1 }
    }

    /// The audio overlapping `range` the server doesn't have yet (`Uploader.unsent`).
    func unsent(overlapping range: Range<CaptureInstant>) async -> [Range<CaptureInstant>] {
        #if DEBUG
            if FixtureLibrary.isRequested { return FixtureLibrary.unsent.filter { $0.overlaps(range) } }
        #endif
        return (try? await driver?.uploader?.unsent(overlapping: range)) ?? []
    }

    /// Reads what was spent again; returns whether the server answered. The last answer stays meanwhile.
    @discardableResult
    func refreshSpending() async -> Bool {
        guard isPaired, let summary = try? await ServerClient.production.usageSummary()
        else { return false }
        spending = summary
        return true
    }

    /// The raw backup sends up to 64 MB at a time: only on Wi-Fi or a wire, or while charging.
    private var mayBackUp: Bool {
        UIDevice.current.isBatteryMonitoringEnabled = true
        return [.wifi, .wired].contains(network) || [.charging, .full].contains(UIDevice.current.batteryState)
    }

    /// The server's message for a failure, in words the owner reads.
    static func sentence(_ error: any Error) -> String {
        switch error {
        case ServerClient.ClientError.server(_, _, let message): message
        case ServerClient.ClientError.notPaired: notPaired
        case let error as URLError where error.isTransient: "No connection to the server. Try again once online."
        default: report(error)
        }
    }

    // MARK: Pieces

    /// The driver over the stores capture and the library opened at launch, built on first use once capture has
    /// opened the source store. In the simulator with a simulated Pendant it has no capture half: the edits and the
    /// feed go, and nothing is uploaded.
    private func setUp() -> Driver? {
        // Pairing another kind of pendant (an Omi) moves capture to its own slot: the driver follows it.
        let deviceID = CaptureStore.deviceID
        if let driver, driverDeviceID == deviceID { return driver }
        guard let library else { return nil }
        let client = ServerClient.production
        #if DEBUG
            if FixtureLibrary.isRequested { return nil }
            // A simulated Pendant writes a throwaway source store; keep it out of the real library.
            if FakeScenario.selected != nil {
                driver = Driver(library: library, client: client, capture: nil, event: appEvent)
                driverDeviceID = deviceID
                return driver
            }
        #endif
        guard let source = capture.sourceStore else { return nil }
        do {
            let support = URL.applicationSupportDirectory.appending(path: "lifelog", directoryHint: .isDirectory)
            let derived = try DerivedAudioDirectory.standard()
            let scanner = try TimelineScanner(
                source: source, derived: derived, library: library,
                database: support.appending(path: "timeline.sqlite"), deviceID: deviceID)
            let uploader = try Uploader(
                source: source, scanner: scanner, client: client,
                directory: support.appending(path: "upload", directoryHint: .isDirectory),
                inBackground: { Self.inBackground.withLock { $0 } }, event: appEvent)
            let worker = DerivedAudioWorker(
                store: source, output: derived,
                // Low Power Mode doesn't stop decoding the owner's audio; only real thermal pressure does.
                canRunHeavyWork: { ![.serious, .critical].contains(ProcessInfo.processInfo.thermalState) })
            self.worker = worker
            driver = Driver(
                library: library, client: client, capture: .init(worker: worker, uploader: uploader), event: appEvent)
            driverDeviceID = deviceID
            return driver
        } catch {
            _ = report(error)
            return nil
        }
    }

    // MARK: Derived audio

    /// Rebuilds the evicted playback files covering `range` from the source packs, so they can be played or exported.
    func restorePlayback(covering range: Range<CaptureInstant>) async throws {
        _ = setUp()
        guard let worker else { return }
        try await worker.rebuildPlayback(deviceID: CaptureStore.deviceID, covering: range)
    }
}

extension ServerClient {
    /// The paired server, authorized with this phone's device token, both read on every request so a new pairing
    /// takes effect at once.
    nonisolated static let production: ServerClient = {
        let server: @Sendable () -> URL? = { DeviceToken.paired }
        #if DEBUG
            if OfflineProtocol.isRequested {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [OfflineProtocol.self]
                return ServerClient(
                    server: server, session: URLSession(configuration: configuration), token: DeviceToken.read)
            }
        #endif
        return ServerClient(server: server, token: DeviceToken.read)
    }()
}

#if DEBUG
    /// `-offline`: every server request fails as it does with no network, so the simulator shows what the owner sees
    /// offline without cutting the Mac's network. Screens must still show the library (docs/voice/architecture.md).
    nonisolated final class OfflineProtocol: URLProtocol {
        static let isRequested = ProcessInfo.processInfo.arguments.contains("-offline")

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        }
        override func stopLoading() {}
    }
#endif

#if DEBUG
    import SwiftUI

    extension View {
        /// Previews: the driver over `library`, nothing live.
        func previewSync(capture: CaptureStore = .preview(), library: LibraryStore? = nil) -> some View {
            environment(SyncStore.preview(capture: capture, library: library))
        }
    }
#endif
