import Capture
import CoreBluetooth
import Foundation
import Incidents
import Library
import MetricKit
import Observation
import PendantProtocol
import ServerAPI
import SourceStore
import Timeline
import UIKit

/// Capture feature store: owns the raw source store and the Pendant drain, and publishes what the UI needs as plain facts. Create it once, as early as possible at launch (see
/// `AppDelegate`).
@Observable
final class CaptureStore {
    enum Availability: Equatable {
        case starting
        case running
        /// The source store would not open (for example written by a newer app). Capture stays off rather than
        /// start an empty archive.
        case unavailable(String)
    }

    /// Everything the Pendant reports, changing on every notification of a sync. Diagnostics reads it; screens read
    /// `shown`.
    private(set) var status = CaptureStatus() {
        didSet { shown = status.forScreen(previous: shown) }
    }
    /// `status` as screens show it (`CaptureStatus.forScreen`): unchanged while a sync only adds pages, so the Pendant
    /// screen redraws when something it shows changes, not once per page.
    private(set) var shown = CaptureStatus()
    private(set) var availability = Availability.starting
    /// When `status.connection` last changed, so a long scan or reconnect can be told from a short one.
    private(set) var connectionSince = Date.now
    /// The last time a sync finished with nothing left on the Pendant to save.
    private(set) var lastCaughtUp: Date?
    /// Where a tapped notification leads: `RootView` opens it and clears this.
    var routeToOpen: NotificationRoute?
    /// Free space on the archive's volume, refreshed when a sync settles and when the app comes forward, at most once a
    /// minute (`refreshPhoneFreeSpace`).
    private(set) var phoneFreeBytes: Int64?
    @ObservationIgnored private var freeSpaceReadAt = Date.distantPast
    /// What the raw archive occupies and how far it reaches, refreshed with the free space.
    private(set) var archive: StorageStats?
    /// The newest saved audio, by the Pendant's clock.
    var lastSavedCapture: Date? {
        archive?.sessions.compactMap(\.newestDeviceTimeMillis).max().map {
            Date(timeIntervalSince1970: Double($0) / 1000)
        }
    }
    private(set) var hasKnownPendant = UserDefaults.standard.string(forKey: knownDeviceKey) != nil
    /// Source-store incidents still open (replay conflicts, rotted bytes, encrypted pages). Each holds the ACK at
    /// its index until resolved; refreshed when a sync settles.
    private(set) var openIncidents: [Incident] = []
    /// Roughly when each open incident's audio was recorded, by the Pendant's clock, so the owner reads a time
    /// rather than a page number.
    private(set) var incidentAudioTimes: [Int64: Date] = [:]
    /// Background wakes and what each saved, for the hardware test. Counts and times only, kept on the phone in
    /// `wakeLogURL` (Library/Application Support/lifelog/background-wakes.json in the app container).
    private(set) var wakeLog = WakeLog()
    /// Recording pauses and resumes the Pendant confirmed, as stored, for `CaptureStatus.recordingSince`.
    private(set) var recordingChanges: [RecordingChange] = []
    /// How fast the Pendant's battery drains recording and paused, learned from its readings.
    private(set) var batteryLife = BatteryLife()

    /// Last contact before this launch, so a Pendant out of range at launch can say when it was last seen.
    @ObservationIgnored private let previousContact = PendantSnapshot.load()?.lastContact
    @ObservationIgnored let notifier = IncidentNotifier()
    @ObservationIgnored private let health = HealthReporter()
    @ObservationIgnored private let snapshots: SnapshotPublisher
    /// The Watch's link, for what capture doesn't own (the split, which processing does).
    var watch: WatchRelay { snapshots.watch }
    @ObservationIgnored private let root: URL
    @ObservationIgnored private var transport: (any PendantTransport)?
    @ObservationIgnored private var coordinator: DrainCoordinator?
    @ObservationIgnored private(set) var sourceStore: SourceStore?
    @ObservationIgnored private var run: Task<Void, Never>?
    /// Crashes the app if the capture freezes (`FreezeWatch`); held for as long as the capture runs.
    @ObservationIgnored private var freezeWatch: (any DispatchSourceTimer)?
    /// The last battery reading stored this launch.
    @ObservationIgnored private var lastBatteryReading: BatteryReading?
    @ObservationIgnored let wakeLogURL: URL

    private static let knownDeviceKey = "pendantPeripheral"
    private static let knownKindKey = "pendantKind"
    /// The paired pendant's kind, kept with it: known before it connects.
    static var pairedKind: DeviceKind {
        UserDefaults.standard.string(forKey: knownKindKey).flatMap(DeviceKind.init(rawValue:)) ?? .limitless
    }
    /// The paired pendant's slot in the source store, by its kind: a Limitless Pendant or an Omi. Receipts inside it
    /// are scoped to a flash life keyed by the Pendant's serial and flash generation (`SourceStore.flashLife`), so
    /// processing keeps reading one slot.
    static var deviceID: String { pairedKind.deviceID }
    /// Raw audio is never excluded from backups.
    private static let protection = FileProtectionType.completeUntilFirstUserAuthentication

    /// Previews pass `live: false`: no Bluetooth, and the wake log isn't read.
    init(live: Bool = true) {
        snapshots = SnapshotPublisher()
        let support = URL.applicationSupportDirectory.appending(path: "lifelog", directoryHint: .isDirectory)
        root = support
        wakeLogURL = support.appending(path: "background-wakes.json")
        guard live else { return }
        if let data = try? Data(contentsOf: wakeLogURL), let log = try? JSONDecoder().decode(WakeLog.self, from: data) {
            wakeLog = log
        }
        #if DEBUG
            if FakeScenario.selected != nil { return }
        #endif
        // The real radio builds its Bluetooth central in its init, here in `AppDelegate.init`, so a background relaunch
        // finds the central with its restore identifier during launch. The store and the drain start in `start()`.
        transport = CoreBluetoothTransport(restoreIdentifier: "pendant")
    }

    /// Starts capture. Call once at launch, in the foreground or a background relaunch.
    func start() {
        notifier.open = { [weak self] in self?.routeToOpen = $0 }
        // Pause or Resume on the Watch, through the same request as Shortcuts: pending until the Pendant confirms.
        snapshots.watch.setRecording = { [weak self] recording in
            let intent: RecordingIntent = recording ? .resume : .pause
            guard let self else { return "Life isn't ready yet." }
            let outcome = await request(intent)
            switch outcome {
            case .confirmed, .pending: return nil
            case .failed, .notConnected: return outcome.sentence(for: intent)
            }
        }
        // Notification permission is asked on the Pendant screen, after it says what alerts are for.
        #if DEBUG
            if let scenario = FakeScenario.selected {
                use(scenario)
                return
            }
        #endif
        guard let transport else { return }
        health.start()
        let known = UserDefaults.standard.string(forKey: Self.knownDeviceKey).flatMap(UUID.init)
        boot(transport, directory: root.appending(path: "source", directoryHint: .isDirectory), knownDevice: known)
    }

    // MARK: Intents

    /// Asks the Pendant to pause. The outcome shows in `status.recording`: pending, then confirmed or failed.
    func pause() async { await send(.pause) }
    func resume() async { await send(.resume) }

    enum RequestOutcome {
        /// The Pendant reported the asked-for state.
        case confirmed
        /// Sent; no confirmation yet.
        case pending
        case failed(RecordingFailure)
        /// No link to the Pendant, so nothing was sent.
        case notConnected
    }

    /// For Shortcuts and the control, which may have just launched the app: waits a little for the link, asks, and
    /// waits a little for the Pendant to confirm. Never reports more than the Pendant confirmed.
    func request(_ intent: RecordingIntent) async -> RequestOutcome {
        guard await waitForLink() else { return .notConnected }
        let asked = Date.now
        await send(intent)
        // The status arrives a moment after the request, so a failure counts only if it came after this one.
        func outcome() -> RequestOutcome {
            switch (status.recording, intent) {
            case (.paused, .pause), (.recording, .resume): .confirmed
            case (.failed(let failure, let at), _) where at >= asked: .failed(failure)
            default: .pending
            }
        }
        _ = await wait(upTo: .seconds(6)) {
            if case .pending = outcome() { false } else { true }
        }
        return outcome()
    }

    /// A launch already reconnects to the known Pendant, and a sync to an Omi resting between drains; this waits a
    /// little for the link to be ready.
    func waitForLink(upTo limit: Duration = .seconds(10)) async -> Bool {
        if case .resting = status.connection { await syncNow() }
        return await wait(upTo: limit) {
            if case .ready = self.status.connection { true } else { false }
        }
    }

    private func send(_ intent: RecordingIntent) async {
        notifier.appRequested(intent)
        switch intent {
        case .pause: await coordinator?.requestPause()
        case .resume: await coordinator?.requestResume()
        }
    }

    /// ponytail: polls; fine for a few seconds inside an intent.
    private func wait(upTo limit: Duration, until done: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: limit)
        while !done() {
            guard ContinuousClock.now < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return true
    }
    func syncNow() async { await coordinator?.syncNow() }
    /// While the app is in the foreground: a fallback cycle every few minutes. Returns when the calling task is
    /// cancelled. Background sync never relies on it: it follows the Pendant's own events.
    func resyncWhileActive() async { await coordinator?.resyncWhileActive() }
    /// While the Pendant screen is open: new pages as they seal and a status every 5 s, so what it shows (recording,
    /// sound) stays current. Returns when the calling task is cancelled.
    func watchLive() async { await coordinator?.watchLive() }
    /// Owner retry after "busy elsewhere" or a pairing problem.
    func reconnect() async { await coordinator?.reconnect() }
    /// Returns whether the command reached the Pendant; nothing confirms the light changed.
    func setLightBrightness(_ brightness: LightBrightness) async -> Bool {
        await coordinator?.setLightBrightness(brightness) ?? false
    }

    /// The owner's decision on the incidents one card shows, applied to each. Never called automatically.
    func resolve(_ incidents: [Incident], keeping resolution: IncidentResolution) async throws {
        for incident in incidents { try await sourceStore?.resolveIncident(incident.id, keeping: resolution) }
        await refreshIncidents()
        await syncNow()
    }

    /// The app came forward: catch up now instead of waiting for the next cycle.
    func becameActive() async {
        refreshPhoneFreeSpace()
        await refreshArchive()
        await refreshIncidents()
        notifier.update(status, phoneFreeBytes: phoneFreeBytes)
        reportHealth()
        health.flush()
        // The Watch drops a glance sent before its session was up: send the current one again.
        snapshots.publish(status)
        await syncNow()
    }

    func freshness(of observedAt: Date?, now: Date = .now) -> EvidenceFreshness {
        EvidenceFreshness(observedAt: observedAt, now: now)
    }

    /// The facts beside the Pendant's status that decide what the owner is told (`CaptureCondition`).
    var context: CaptureContext {
        let archiveError: String? =
            if case .unavailable(let error) = availability { error } else { nil }
        let permission: CaptureContext.BluetoothPermission =
            switch CBManager.authorization {
            case .notDetermined: .notDetermined
            case .denied: .denied
            case .restricted: .restricted
            default: .allowed
            }
        return CaptureContext(
            archiveError: archiveError, protectedDataAvailable: UIApplication.shared.isProtectedDataAvailable,
            hasKnownPendant: hasKnownPendant, bluetoothPermission: permission, connectionSince: connectionSince,
            phoneFreeBytes: phoneFreeBytes, lastContact: previousContact)
    }

    // MARK: Wiring

    private func boot(_ transport: any PendantTransport, directory: URL, knownDevice: UUID?) {
        let store: SourceStore
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.protectionKey: Self.protection], ofItemAtPath: root.path)
            store = try SourceStore(directory: directory, fileProtection: Self.protection)
        } catch {
            availability = .unavailable(report(error))
            return
        }
        // Cut over: the old app is retired, so ACK the durable prefix and the Pendant stops re-sending it.
        let coordinator = DrainCoordinator(
            transport: transport, sink: store, configuration: CaptureConfiguration(ackPolicy: .acknowledge))
        self.transport = transport
        self.sourceStore = store
        self.coordinator = coordinator
        freezeWatch = FreezeWatch.start { coordinator.lastBeat }
        availability = .running
        refreshPhoneFreeSpace()
        Task { await refreshArchive() }
        Task { await relearnBattery() }
        let persistKnownDevice = transport is CoreBluetoothTransport
        run = Task {
            await withDiscardingTaskGroup { group in
                group.addTask { await coordinator.run(knownDevice: knownDevice) }
                group.addTask {
                    for await press in coordinator.quickPresses { await self.pressed(press) }
                }
                for await status in coordinator.statusUpdates {
                    self.receive(status, persistKnownDevice: persistKnownDevice)
                }
            }
        }
    }

    /// Called whenever a sync settles, so new audio is processed while the app is open, not only at the next launch.
    @ObservationIgnored var onAudioSaved: (() -> Void)?

    private func receive(_ new: CaptureStatus, persistKnownDevice: Bool) {
        // Runs for every page the Pendant seals while it hears sound. MetricKit measures the process over the
        // interval, so its CPU is an upper bound.
        mxSignpost(.begin, log: .work, name: "receive")
        defer { mxSignpost(.end, log: .work, name: "receive") }
        let old = status
        status = new
        if new.connection != old.connection { connectionSince = .now }
        // ponytail: the change is stored just after the status that confirms it, so this read can miss it; the next
        // report (every few seconds on screen) reads it again.
        if new.recording != old.recording, let sourceStore {
            Task { recordingChanges = (try? await sourceStore.recordingChanges(deviceID: Self.deviceID)) ?? [] }
        }
        if persistKnownDevice, case .ready(let id) = new.connection {
            UserDefaults.standard.set(id.uuidString, forKey: Self.knownDeviceKey)
            UserDefaults.standard.set(new.deviceKind?.rawValue, forKey: Self.knownKindKey)
            hasKnownPendant = true
        }
        // In steps, like the status screens read: a Pendant recording catches up every page or two.
        if case .caughtUp(let at) = new.sync,
            at.timeIntervalSince(lastCaughtUp ?? .distantPast) >= CaptureStatus.screenStep
        {
            lastCaughtUp = at
        }
        let settled = new.sync != old.sync && isSettled(new.sync)
        let background = UIApplication.shared.applicationState == .background
        if settled {
            refreshPhoneFreeSpace()
            onAudioSaved?()
            // Reports waiting for the server get another try once per sync, in the background too.
            health.flush()
            // In a background wake nothing shows them: keep the wake short; `becameActive` refreshes both.
            if !background {
                Task {
                    await refreshIncidents()
                    await refreshArchive()
                }
            }
        }
        if background { logWake(new.saved, previous: old.saved, settled: settled) }
        if let stall = new.lastStall, stall != old.lastStall {
            appEvent(
                "capture.stalled",
                [
                    "silentS": "\(stall.value.silentSeconds)", "parkedIn": stall.value.parkedIn ?? "idle",
                    "writesInFlight": "\(stall.value.writesInFlight)",
                ])
        }
        recordBattery(new)
        notifier.update(new, phoneFreeBytes: phoneFreeBytes)
        reportHealth()
        snapshots.publish(new)
    }

    /// Stores the battery level when it or what the Pendant was doing changed, then learns the drain again.
    private func recordBattery(_ status: CaptureStatus) {
        guard let sourceStore, let reading = status.batteryReading(at: .now)?.toStore(after: lastBatteryReading)
        else { return }
        lastBatteryReading = reading
        Task {
            try? await sourceStore.recordBatteryReading(reading, deviceID: Self.deviceID)
            await relearnBattery()
        }
    }

    /// ponytail: re-reads up to eight weeks of readings on every change of level (a few hundred a day); keep running
    /// sums if it ever shows up.
    private func relearnBattery() async {
        guard let sourceStore else { return }
        let now = Date.now
        let readings = try? await sourceStore.batteryReadings(
            deviceID: Self.deviceID, since: now.addingTimeInterval(-BatteryLife.window))
        batteryLife = BatteryLife(readings: readings ?? [], now: now)
    }

    /// A heartbeat to the server when one is due: every 6 h at most, or a notable event (`HeartbeatSchedule`).
    private func reportHealth() {
        health.update(
            status, connectionSince: connectionSince, lastContact: status.lastContact ?? previousContact,
            phoneFreeBytes: phoneFreeBytes, wakeLog: wakeLog)
    }

    /// Written when a wake opens and whenever a sync settles in it, so a wake cut short by suspension still shows.
    private func logWake(_ saved: SavedPages, previous: SavedPages, settled: Bool) {
        let opened = wakeLog.record(saved: saved, previous: previous, at: .now)
        guard opened || settled, let data = try? JSONEncoder().encode(wakeLog) else { return }
        try? data.write(to: wakeLogURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func isSettled(_ sync: DrainPhase) -> Bool {
        switch sync {
        case .caughtUp, .failed: true
        default: false
        }
    }

    private func refreshIncidents() async {
        guard let sourceStore else { return }
        let open = ((try? await sourceStore.incidents()) ?? []).filter { $0.resolution == nil }
        var times: [Int64: Date] = [:]
        for incident in open { times[incident.id] = await audioTime(near: incident.key, in: sourceStore) }
        incidentAudioTimes = times
        openIncidents = open
    }

    /// The Pendant's timestamp of the page itself or a neighbour: a lost page carries none of its own.
    private func audioTime(near key: PageKey, in store: SourceStore) async -> Date? {
        let plausible: Int64 = 1_577_836_800_000  // 2020-01-01, as `SessionStats`
        for index in [key.index, key.index + 1] + (key.index > 0 ? [key.index - 1] : []) {
            guard let page = (try? await store.page(PageKey(deviceID: key.deviceID, index: index))) ?? nil,
                page.deviceTimeMillis > plausible
            else { continue }
            return Date(timeIntervalSince1970: Double(page.deviceTimeMillis) / 1000)
        }
        return nil
    }

    /// At most once a minute: the query is about 56 ms of the phone's CPU, and syncs settle every 1.5 s in talk. Only
    /// the low-space alert (under 1 GB) reads it, and in a minute the app writes well under 100 MB. A full disk never
    /// loses audio either way: a page that can't be written isn't durable, so it isn't ACKed and stays on the Pendant.
    private func refreshPhoneFreeSpace() {
        guard Date.now.timeIntervalSince(freeSpaceReadAt) >= 60 else { return }
        freeSpaceReadAt = .now
        phoneFreeBytes = (try? sourceStore?.availableCapacity()) ?? nil
    }

    /// ponytail: walks the archive directory and groups receipts; fine at sync cadence, cache it if it shows up.
    private func refreshArchive() async {
        guard let sourceStore else { return }
        archive = try? await sourceStore.storageStats()
    }

    // MARK: Presses

    /// A live press on the Pendant. Logged as an event (no text): `bun run events press`.
    private func pressed(_ press: QuickPress) {
        appEvent("press", ["id": press.id])
        onPress?(press)
    }

    /// What a press does (`ButtonActions`); set at launch.
    @ObservationIgnored var onPress: ((QuickPress) -> Void)?

    #if DEBUG
        private(set) var scenario: FakeScenario?
        @ObservationIgnored private(set) var fake: FakePendantTransport?

        /// Previews: nothing live. `scenario` boots a simulated Pendant with a throwaway source store.
        static func preview(_ scenario: FakeScenario? = nil) -> CaptureStore {
            let store = CaptureStore(live: false)
            if let scenario { store.use(scenario) }
            return store
        }

        /// Swaps in a fresh simulated Pendant with its own throwaway source store.
        func use(_ scenario: FakeScenario) {
            run?.cancel()
            self.scenario = scenario
            status = CaptureStatus()
            hasKnownPendant = scenario.isSetUp
            Task {
                let (transport, id) = await scenario.makeTransport()
                fake = transport as? FakePendantTransport
                let directory = URL.temporaryDirectory.appending(path: "fake-\(UUID())", directoryHint: .isDirectory)
                // Like a relaunch with a paired Pendant: a pending connect to it, not a scan.
                boot(transport, directory: directory, knownDevice: scenario.isSetUp ? id : nil)
            }
        }
    #endif
}
