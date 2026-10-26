import Foundation
import PendantProtocol
import SourceStore
import Synchronization
import Timeline

public enum AckPolicy: Sendable, Equatable {
    /// Drain, persist and record gaps, but never send `DeleteFlashPage`. Re-delivered pages simply dedupe.
    case observe
    /// ACK the contiguous durable prefix the sink authorizes, capped by what this drain itself saw.
    case acknowledge
}

public struct CaptureConfiguration: Sendable {
    public var ackPolicy: AckPolicy
    /// Pages settled between ACKs. Omi uses 25.
    public var ackBatchSize: Int
    public var replyTimeout: Duration
    /// A new connection that answers nothing for this long is held by another app, which makes the Pendant drop our
    /// writes silently. ponytail: a healthy Pendant answers the clock set well within it; tune on hardware.
    public var handshakeTimeout: Duration
    /// How often a pause or resume is re-checked until the Pendant reports it or `replyTimeout` passes.
    public var confirmationPollInterval: Duration
    /// A download with no page for this long is over (pendant-cli uses 5 s).
    public var pageIdleTimeout: Duration
    /// Foreground only (`resyncWhileActive`): a fallback cycle in case a Pendant event was missed. Background sync is
    /// event-driven, since iOS suspends timers there. ponytail: fixed; tune from battery runs on hardware.
    public var resyncInterval: Duration
    /// A connection that handles no Pendant message for this long has stalled (`watchStall`); the same silence makes
    /// its telemetry stale (`EvidenceFreshness.freshFor`). The Pendant speaks at least every ~2.2 min, battery pushes
    /// included, paused or not (owner's unit, 20 Oct).
    public static let stallTimeout: Duration = .seconds(360)
    public var stallTimeout: Duration

    public init(
        ackPolicy: AckPolicy = .observe, ackBatchSize: Int = 25, replyTimeout: Duration = .seconds(10),
        handshakeTimeout: Duration = .seconds(4), confirmationPollInterval: Duration = .seconds(1),
        pageIdleTimeout: Duration = .seconds(5), resyncInterval: Duration = .seconds(300),
        stallTimeout: Duration = Self.stallTimeout
    ) {
        self.ackPolicy = ackPolicy
        self.ackBatchSize = ackBatchSize
        self.replyTimeout = replyTimeout
        self.handshakeTimeout = handshakeTimeout
        self.confirmationPollInterval = confirmationPollInterval
        self.pageIdleTimeout = pageIdleTimeout
        self.resyncInterval = resyncInterval
        self.stallTimeout = stallTimeout
    }
}

/// Owns one Pendant: connection, drain and recording control, and publishes `CaptureStatus`.
///
/// Every connection gets a generation number and every drain an id. Anything that awaits (the sink, a write,
/// a timer) re-checks both afterwards, so work from an old connection can never ACK on a newer one.
///
/// Background: download mode stays on after the first drain of a connection, so pages the Pendant seals may arrive
/// by themselves, each notification waking the app (UNVERIFIED on hardware that the firmware keeps pushing them).
/// Every Pendant event (a status push, a recording change, a live storage-session marker, a reconnect) also checks
/// for pages the stream did not bring (`catchUp`). No timer drives background work.
public actor DrainCoordinator {
    private enum StatusPurpose {
        case drain
        case confirmRecording
        case refresh
    }

    private enum Settled {
        /// `stored` is set when the page was new (not a verified re-send).
        case kept(UInt64, stored: (audioSeconds: Double, bytes: Int)?)
        case gap(UInt64, GapReason)
        case conflict(UInt64)
        /// Kept on the Pendant until the owner accepts it as a gap (`HeldReason`).
        case held(UInt64, HeldReason)
        /// The Pendant re-used this index with another device time: its flash restarted.
        case otherFlashLife(UInt64)
    }

    private struct Drain {
        let id: UInt64
        /// The pendant's kind, which reads its pages and names its slot.
        let kind: DeviceKind
        /// Store index base of the flash life. Every other index here is the Pendant's own.
        var base: UInt64
        var oldest: UInt64
        let newest: UInt64
        var progress: DrainProgress
        var queue: [StorageBuffer] = []
        var isPersisting = false
        var downloadFinished = false
        var finishing = false
        /// End of the unbroken run from `oldest` that this drain itself got back as stored, verified duplicate, or a
        /// gap recorded from the device's own error envelope. Receipts from an earlier flash life can never
        /// authorize more than this, and a conflict or held page ends the run.
        var settledThrough: UInt64?
        /// Settled indices above the run, waiting for the ones below them.
        var settledAhead: Set<UInt64> = []
        var acked: UInt64?
        /// Pages the Pendant pushed on its own after a drain, with the stream left open (`startTail`).
        var pushed = false
        /// The newest sign of the firmware's mode on the pages so far, applied once the drain has seen them all.
        var flashMode: Observed<Bool>?
        var settledSinceAck = 0
        /// Pages below this were durable when the drain began: they come again, but aren't progress.
        var firstUnsaved: UInt64 = 0

        mutating func markSettled(_ index: UInt64) {
            guard index >= oldest else { return }
            settledAhead.insert(index)
            var next = settledThrough.map { $0 + 1 } ?? oldest
            while settledAhead.remove(next) != nil {
                settledThrough = next
                next += 1
            }
        }
    }

    private struct Session {
        let generation: UInt64
        let peripheral: UUID
        let kind: DeviceKind
        var codec: any DeviceCodec
        var queries: [(id: Int64, purpose: StatusPurpose)] = []
        var controlRequest: Int64?
        var hasReplied = false
        /// Download mode left on after a drain, so new pages arrive as they seal. Turning it off and on again would
        /// restart the stream from the oldest unacked page: in observe mode, everything again.
        var tailing = false
        /// The highest page this connection's stream delivered. A trigger only fetches what lies past it.
        var streamedThrough: UInt64?
        /// A trigger came while a drain or its status query was under way: look again once that is done.
        var catchUpPending = false
        /// Pushed pages settled since the last ACK, carried from one pushed drain to the next so ACKs stay batched.
        var unackedTail = 0
        /// The last `SetCurrentTime` (phone time, and the RTC just before it when a press measured it), until the
        /// drain status after it says where its pages begin.
        var clockSet: (phoneMillis: Int64, deviceMillisBeforeSet: Int64?)?
        /// Short presses since boot in the last button status: a press is fresh only when this rises.
        var shortPresses: UInt64?
        /// RTC minus phone time from a trusted press since the last set (`PressClock`).
        var clockOffsetMillis: Int64?
        /// Pages a drain on this connection settled itself. The flash can't restart its indices while we hold the
        /// bond, so only this, never the store's receipts, lets observe mode skip a download.
        var verified: ClosedRange<UInt64>?
        /// The flash life this connection stores into, chosen from `DeviceInfo` before the first drain.
        var life: FlashLife?
        var awaitingInfo = false
        /// The standard battery level (0x2A19) answered on this connection, so it wins over status messages.
        var hasBatteryLevel = false
        var drain: Drain?
    }

    private let transport: any PendantTransport
    private let sink: any PageSink
    private let deviceIDs: @Sendable (DeviceKind) -> String
    /// The connected pendant's slot in the store. Settling a page uses its drain's kind instead.
    private var deviceID: String { deviceIDs(session?.kind ?? status.deviceKind ?? .limitless) }
    private let configuration: CaptureConfiguration
    private let now: @Sendable () -> Date
    /// Every timer's clock, so tests can move time on instead of waiting for it.
    private let clock: any Clock<Duration>
    private let statusContinuation: AsyncStream<CaptureStatus>.Continuation
    private let pressContinuation: AsyncStream<QuickPress>.Continuation
    private var connection = ConnectionMachine()
    private var recording = RecordingControl()
    private var presses = PressReader()
    private var session: Session?
    private var drainCounter: UInt64 = 0
    private var measuredAudio: (seconds: Double, pages: Int) = (0, 0)
    private var sound = SoundEvidence()
    private var persistTasks: [Task<Void, Never>] = []
    /// Stamped from this actor every `beatInterval` while `run` runs (`stampBeat`); `FreezeWatch` reads it off the
    /// actor (`lastBeat`) to notice when no task runs here at all.
    private nonisolated let beat = Mutex(Date.distantPast)
    static let beatInterval: Duration = .seconds(30)
    public nonisolated var lastBeat: Date { beat.withLock { $0 } }
    private func stampBeat() { beat.withLock { $0 = now() } }
    /// The transport event the run loop is handling (`nil` between events) and the writes not yet answered by the
    /// transport: what a stall was parked in.
    private var handling: TransportEvent?
    private var writesInFlight = 0

    /// Latest snapshot first, then every change. Single consumer.
    public nonisolated let statusUpdates: AsyncStream<CaptureStatus>
    /// Every live press, in order, never coalesced: two presses inside one status update are two.
    /// A press replayed at connect, or made while paused (it only resumes), never comes. Single consumer.
    public nonisolated let quickPresses: AsyncStream<QuickPress>
    public private(set) var status = CaptureStatus() {
        didSet { if status != oldValue { statusContinuation.yield(status) } }
    }

    /// `deviceID` is each kind of pendant's slot in the source store. Within it, receipts belong to a flash life chosen
    /// from the Pendant's serial and flash generation (`DeviceInfo`), so one life's receipts never vouch for another's.
    public init(
        transport: any PendantTransport, sink: any PageSink,
        deviceID: @escaping @Sendable (DeviceKind) -> String = { $0.deviceID },
        configuration: CaptureConfiguration = CaptureConfiguration(), now: @escaping @Sendable () -> Date = Date.init,
        clock: any Clock<Duration> = ContinuousClock()
    ) {
        self.transport = transport
        self.sink = sink
        deviceIDs = deviceID
        self.configuration = configuration
        self.now = now
        self.clock = clock
        (statusUpdates, statusContinuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
        (quickPresses, pressContinuation) = AsyncStream.makeStream()
        statusContinuation.yield(CaptureStatus())
    }

    /// Runs until the calling task is cancelled.
    public func run(knownDevice: UUID? = nil) async {
        let beating = Task {
            repeat { stampBeat() } while (try? await clock.sleep(for: Self.beatInterval)) != nil
        }
        defer { beating.cancel() }
        await transport.start()
        await apply(connection.handle(.start(knownDevice: knownDevice)))
        for await event in transport.events {
            handling = event
            await handle(event)
            handling = nil
        }
    }

    /// Asks the Pendant to pause recording. Confirmed only by later telemetry. No-op while disconnected.
    public func requestPause() async { await requestRecording(.pause) }

    public func requestResume() async { await requestRecording(.resume) }

    /// Sets the recording light's brightness. UNVERIFIED on hardware, and nothing in a reply confirms it: returns only
    /// whether the command was written. `false` while disconnected.
    public func setLightBrightness(_ brightness: LightBrightness) async -> Bool {
        guard let generation = session?.generation else { return false }
        return await send(.setLEDBrightness(brightness.level), generation) != nil
    }

    /// Starts a drain cycle now if connected, or once the drain under way is done.
    public func syncNow() async {
        guard let generation = session?.generation else {
            // An Omi rests between drains: a sync connects to it again.
            if case .resting = connection.state { await apply(connection.handle(.start(knownDevice: nil))) }
            return
        }
        await startCycle(generation)
    }

    /// Asks the Pendant for its status and nothing else: no clock set, no download, no control command (`watchLive`).
    /// No-op while disconnected, before the Pendant first answered, or while another query is still open.
    func refreshStatus() async {
        guard let current = session, current.hasReplied, current.queries.isEmpty else { return }
        await query(.refresh, current.generation)
        await transport.readBattery()
    }

    /// While the Pendant screen is shown: a cycle now, then a status every `liveRefresh`, never faster. Pages arrive as
    /// the Pendant seals them (about every 1.5 s while it stores audio) on the stream every drain leaves open; each
    /// status reply also fetches what the stream did not bring (`catchUp`). Returns when the calling task is cancelled.
    public func watchLive() async {
        await syncNow()
        while (try? await clock.sleep(for: Self.liveRefresh)) != nil {
            await refreshStatus()
        }
    }

    /// While the app is in the foreground: a cycle every `resyncInterval`, in case a Pendant event was missed. Never
    /// relied on in the background, where iOS suspends timers. Returns when the calling task is cancelled.
    public func resyncWhileActive() async {
        while (try? await clock.sleep(for: configuration.resyncInterval)) != nil {
            await syncNow()
        }
    }

    /// The fastest status cadence the app ever asks for, only while a screen watches.
    public static let liveRefresh: Duration = .seconds(5)

    /// Owner-initiated retry after `busyElsewhere` or a pairing problem, or a pending connect to a newly paired
    /// Pendant (`device`).
    public func reconnect(to device: UUID? = nil) async {
        await apply(connection.handle(device.map { .start(knownDevice: $0) } ?? .discover))
    }

    /// Waits for in-flight page persistence, including work from ended connections.
    func waitForPersistence() async {
        while let task = persistTasks.popLast() { await task.value }
    }

    // MARK: Transport events

    private func handle(_ event: TransportEvent) async {
        switch event {
        case .availability(let availability): await apply(connection.handle(.availability(availability)))
        case .discovered(let pendant): await apply(connection.handle(.discovered(pendant)))
        case .restored(let id): await apply(connection.handle(.restored(id)))
        case .linkUp(let id):
            status.lastContact = now()
            await apply(connection.handle(.linkUp(id)))
            watchDiscovery(id, connection.generation)
        case .ready(let id, let kind):
            status.deviceKind = kind
            await apply(connection.handle(.ready(id)))
        case .firmwareRevision(let revision): status.firmwareRevision = revision
        case .pairingRequired(let id): await apply(connection.handle(.pairingRequired(id)))
        case .disconnected(let id, let reason): await apply(connection.handle(.disconnected(id, reason)))
        case .batteryLevel(let level):
            status.lastContact = now()
            session?.hasBatteryLevel = true
            status.batteryPercent = Observed(level, at: now())
        case .notification(let data): await receive(data)
        }
    }

    private func apply(_ effects: [ConnectionEffect]) async {
        status.connection = connection.state
        for effect in effects {
            switch effect {
            case .scan: await transport.scan()
            case .stopScan: await transport.stopScan()
            case .connect(let id): await transport.connect(id)
            case .disconnect: await transport.disconnect()
            case .sessionStarted(let id, let generation):
                let kind = status.deviceKind ?? .limitless
                session = Session(generation: generation, peripheral: id, kind: kind, codec: kind.makeCodec())
                watchHandshake(generation)
                watchStall(generation)
                await startCycle(generation)
            case .sessionEnded: endSession()
            }
        }
    }

    private func endSession() {
        // Pages that arrived are still stored: an Omi on 3.0.21 freed them on delivery. Nothing here ACKs; the drain
        // and partial fragments belong to the connection and go.
        if let drain = session?.drain, !drain.queue.isEmpty {
            let rescue = Task {
                for page in drain.queue { _ = try? await settle(page, base: drain.base, kind: drain.kind) }
            }
            persistTasks = persistTasks.suffix(15) + [rescue]
        }
        session = nil
        applyRecordingState(recording.handle(.connectionLost))
        switch status.sync {
        case .caughtUp, .failed, .idle: break
        default: status.sync = .idle
        }
    }

    private func receive(_ data: Data) async {
        guard var current = session else { return }
        status.lastContact = now()
        let messages: [PendantMessage]
        do {
            messages = try current.codec.decode(data)
        } catch {
            // A malformed message is dropped; an unacked page is re-delivered next drain.
            session?.codec = current.codec
            status.droppedMessages += 1
            return
        }
        current.hasReplied = true
        session = current
        status.lastReply = now()
        for message in messages { await handle(message, generation: current.generation) }
    }

    private func handle(_ message: PendantMessage, generation: UInt64) async {
        if let response = message.response, let failure = response.failure, let id = response.requestID,
            id == session?.controlRequest
        {
            await applyRecording(.commandRejected(String(describing: failure), at: now()), generation)
        }
        switch message.content {
        case .storageBuffer(let page):
            await observe(page, generation)
            enqueue(page, generation)
        case .deviceStatus(let deviceStatus):
            await statusReceived(deviceStatus, requestID: message.response?.requestID, generation)
        case .battery(let battery): updateBattery(battery)
        case .button(let button):
            status.lastButton = Observed(button.event, at: now())
            let received = Int64(now().timeIntervalSince1970 * 1000)
            if let offset = PressClock.offset(
                button, previousPresses: session?.shortPresses, receivedAtMillis: received)
            {
                session?.clockOffsetMillis = offset
            }
            let live = PressClock.isLive(button, previousPresses: session?.shortPresses, receivedAtMillis: received)
            session?.shortPresses = button.shortPressesSinceBoot
            if live, button.event == .short {
                // While paused a press only turns recording back on (the Pendant reports presses in idle mode).
                if case .paused = recording.state {
                    await applyRecording(.quickPress(at: now()), generation)
                } else if let press = presses.press(
                    button, deviceID: deviceID,
                    at: Date(
                        timeIntervalSince1970: Double(PressClock.pressedAt(button, receivedAtMillis: received)) / 1000))
                {
                    pressContinuation.yield(press)
                }
            }
            if button.event == .long { await applyRecording(.firmwareToggle(at: now()), generation) }
        case .deviceInfo(let info): await identified(info, generation)
        case .setCurrentTimeResponse, .other: break
        }
    }

    // MARK: Commands and status

    /// Encodes before the first await so request ids are registered before any reply can arrive.
    @discardableResult
    private func send(_ command: PendantCommand, _ generation: UInt64, purpose: StatusPurpose? = nil) async
        -> Int64?
    {
        guard var current = session, current.generation == generation,
            let (writes, requestID) = current.codec.encode(command)
        else { return nil }
        if let purpose { current.queries.append((requestID, purpose)) }
        session = current
        writesInFlight += 1
        defer { writesInFlight -= 1 }
        do {
            for (target, bytes) in writes { try await transport.write(bytes, to: target) }
            return requestID
        } catch .insufficientAuthentication {
            await apply(connection.handle(.pairingRequired(current.peripheral)))
        } catch {
            // Delivery failed; the disconnect event that follows ends the session.
        }
        return nil
    }

    /// Silence is the only sign of another host's bond, so a connection must answer within the handshake timeout.
    private func watchHandshake(_ generation: UInt64) {
        let timeout = configuration.handshakeTimeout
        Task {
            try? await clock.sleep(for: timeout)
            await self.handshakeTimedOut(generation)
        }
    }

    /// On 20 Oct the link stayed up for 10 h while the app handled none of the Pendant's messages and sent it nothing:
    /// the run loop was parked on an await that never returned, which one is unknown. Dropping the link frees a parked
    /// write (the transport resets on disconnect) and stops the transport buffering notifications; a loop parked
    /// elsewhere reconnects when it returns. Either way the reconnect drains from the oldest unacked page. Timers run whenever iOS resumes the app, which the Pendant's messages do every few minutes.
    private func watchStall(_ generation: UInt64) {
        Task {
            while let wait = await self.untilStall(generation) { try? await clock.sleep(for: wait) }
        }
    }

    /// How long until this connection would stall, or `nil` once it is gone or has stalled.
    private func untilStall(_ generation: UInt64) async -> Duration? {
        guard let current = session, current.generation == generation else { return nil }
        let silent = now().timeIntervalSince(status.lastContact ?? .distantPast)
        let timeout = TimeInterval(configuration.stallTimeout.components.seconds)
        guard silent >= timeout else { return .seconds(timeout - silent) }
        let parkedIn = handling.map { String(String(describing: $0).prefix(40)) }
        status.lastStall = Observed(
            Stall(silentSeconds: Int(silent), parkedIn: parkedIn, writesInFlight: writesInFlight), at: now())
        await apply(connection.handle(.stalled(current.peripheral)))
        return nil
    }

    /// On 25 Oct a link sat "connected, not ready yet" for 17 h: nothing leaves that state but the transport's ready.
    /// A link not ready within the stall timeout is dropped like a stalled one, and the reconnect discovers it afresh.
    private func watchDiscovery(_ id: UUID, _ generation: UInt64) {
        let timeout = configuration.stallTimeout
        Task {
            try? await clock.sleep(for: timeout)
            await self.discoveryTimedOut(id, generation)
        }
    }

    private func discoveryTimedOut(_ id: UUID, _ generation: UInt64) async {
        guard connection.state == .discovering(id), connection.generation == generation else { return }
        await apply(connection.handle(.stalled(id)))
    }

    private func handshakeTimedOut(_ generation: UInt64) async {
        guard let current = session, current.generation == generation, !current.hasReplied else { return }
        await apply(connection.handle(.unresponsive(current.peripheral)))
    }

    private func query(_ purpose: StatusPurpose, _ generation: UInt64) async {
        guard let requestID = await send(.getDeviceStatus, generation, purpose: purpose) else { return }
        let timeout = configuration.replyTimeout
        Task {
            try? await clock.sleep(for: timeout)
            await self.queryTimedOut(requestID, generation)
        }
    }

    private func queryTimedOut(_ requestID: Int64, _ generation: UInt64) async {
        guard let current = session, current.generation == generation,
            let index = current.queries.firstIndex(where: { $0.id == requestID })
        else { return }
        let purpose = current.queries[index].purpose
        session?.queries.remove(at: index)
        switch purpose {
        case .drain where !current.hasReplied:
            // Writes are silently dropped when another host holds the bond.
            await apply(connection.handle(.unresponsive(current.peripheral)))
        case .drain:
            // The next Pendant event or foreground cycle tries again.
            status.sync = .failed(.noReply)
            await letGo(generation)
        case .confirmRecording, .refresh:
            break
        }
    }

    private func statusReceived(_ deviceStatus: DeviceStatus, requestID: Int64?, _ generation: UInt64) async {
        let at = now()
        if let battery = deviceStatus.battery { updateBattery(battery) }
        // Match our query by request id; a reply without one answers the oldest open query (UNVERIFIED fallback).
        var purpose: StatusPurpose?
        if let queries = session?.queries,
            let index = requestID.map({ id in queries.firstIndex { $0.id == id } }) ?? (queries.isEmpty ? nil : 0)
        {
            purpose = queries[index].purpose
            session?.queries.remove(at: index)
        }
        if let observed = deviceStatus.recording {
            let event = RecordingEvent.telemetry(observed.state, at: at, answersControl: purpose == .confirmRecording)
            await applyRecording(event, generation)
        }
        // The Pendant may take a moment to apply a pause or resume: ask again until it reports it or the deadline.
        if purpose == .confirmRecording, recording.pendingIntent != nil { pollConfirmation(generation) }
        guard let storage = deviceStatus.storage else {
            if purpose == .drain { status.sync = .failed(.noReply) } else { await catchUp(generation) }
            return
        }
        status.storage = Observed(storage, at: at)
        sound.observe(storage, now: at)
        status.soundActivity = sound.activity
        guard let life = session?.life, let kind = session?.kind else { return }
        let base = life.base
        // A ring's numbers never fall: a write number at or below the newest this life holds is a new ring, so its
        // records get a flash life of their own before any is read.
        if purpose == .drain, kind.restartsNumbersWhenCleared,
            let newest = (try? await sink.newestIndex(deviceID: deviceID, in: life)) ?? nil,
            storage.newestPage + 1 <= Int64(newest - base)
        {
            let write = storage.newestPage + 1
            return await startNewFlashLife("the ring's write number \(write) is below what the phone holds", generation)
        }
        if purpose == .drain, let set = session?.clockSet {
            session?.clockSet = nil
            await recordClockSync(set, after: storage, base: base)
        }
        let savedThrough = try? await sink.savedIndex(deviceID: deviceID, startingAt: base + storage.oldestPage)
        let unsaved = updateBacklog(storage, savedThrough: (savedThrough ?? nil).map { $0 - base }, at: at)
        // Any other status (a push after a state change, a refresh, a confirmation) is a Pendant event.
        if purpose == .drain {
            await beginDrain(storage, unsaved: unsaved, generation)
        } else {
            await catchUp(generation)
        }
    }

    /// A page is stamped when it opens and `newestPage` is the one being written at the set, so `newestPage + 1` is the
    /// first page the new clock stamped: the sync's anchor (verified on the owner's Pendant). The epoch it closes is corrected only when a trusted press
    /// measured the RTC before the set; otherwise it stays uncorrected. A failed write only costs drift correction.
    private func recordClockSync(
        _ set: (phoneMillis: Int64, deviceMillisBeforeSet: Int64?), after storage: StorageState, base: UInt64
    )
        async
    {
        let first = base + max(storage.oldestPage, UInt64(max(storage.newestPage + 1, 0)))
        try? await sink.recordClockSync(
            ClockSync(
                firstPageIndex: first, phoneMillis: set.phoneMillis, deviceMillisBeforeSet: set.deviceMillisBeforeSet),
            deviceID: deviceID)
    }

    /// Every page counts, in a drain or not: a replayed one is too old to change the sound line. Its sign of the
    /// firmware's mode waits for the end of the drain, so a replay's history never flips recording on and off; a live
    /// page outside a drain applies at once.
    private func observe(_ page: StorageBuffer, _ generation: UInt64) async {
        // ponytail: a second decode of each page; fold into `settle` if replays show up in profiles.
        guard page.error == nil, let data = page.flashPage, let flash = try? FlashPage(decoding: data) else { return }
        let at = now()
        sound.observe(flash, index: page.index, now: at)
        status.soundActivity = sound.activity
        if flash.hasLiveSessionMarker(now: at) { await catchUp(generation) }
        guard let mode = flash.recordingMode else { return }
        let inDrain: Void? = updateDrain(generation, nil) { drain in
            if drain.flashMode.map({ mode.at >= $0.at }) ?? true { drain.flashMode = mode }
        }
        if inDrain == nil, abs(at.timeIntervalSince(mode.at)) <= SoundEvidence.liveWindow {
            await applyRecording(.flash(mode), generation)
        }
    }

    /// The level comes from the standard 0x2A19 characteristic when it answered on this connection (the research
    /// prefers it); otherwise from `soc` here. ponytail: `soc` as a 0–100 percentage is UNVERIFIED on hardware, so
    /// anything outside that range is ignored.
    private func updateBattery(_ battery: BatteryStatus) {
        if session?.hasBatteryLevel == false, let soc = battery.stateOfCharge, (0...100).contains(soc) {
            status.batteryPercent = Observed(Int(soc), at: now())
        }
        guard let state = battery.chargeState else { return }
        status.charging = Observed(battery.isCharging == true ? .charging : .unverified(state), at: now())
    }

    /// Returns the unsaved pages: the newest ones, past the run the phone has (`PageSink.savedIndex`: held pages
    /// count as saved).
    @discardableResult
    private func updateBacklog(_ storage: StorageState, savedThrough saved: UInt64?, at: Date) -> UInt64 {
        let beforeOldest = Int64(storage.oldestPage) - 1
        let savedThrough = max(saved.map { Int64(clamping: $0) } ?? beforeOldest, beforeOldest)
        let unsaved = UInt64(max(0, storage.newestPage - savedThrough))
        let perPage = measuredAudio.pages > 0 ? measuredAudio.seconds / Double(measuredAudio.pages) : nil
        status.backlog = Observed(
            Backlog(pages: unsaved, estimatedDuration: perPage.map { .seconds($0 * Double(unsaved)) }), at: at)
        return unsaved
    }

    // MARK: Drain

    /// A status can arrive before the page the Pendant just sealed, so one more page behind is still in flight.
    private static let sealedPageInFlight: Int64 = 1

    /// Something happened on the Pendant (a status push, a recording change, a live storage-session marker): fetch what
    /// the open stream has not brought. The page being written arrives by itself once sealed, so it doesn't count.
    /// Event-driven, so it works in background wakes where no timer runs, and cheap: no write when the stream is
    /// current.
    private func catchUp(_ generation: UInt64) async {
        guard let current = session, current.generation == generation else { return }
        if current.tailing, let through = current.streamedThrough, streamIsCurrent(through: through) { return }
        await startCycle(generation)
    }

    /// Whether pages through `index` are all the Pendant's last status says it sealed, short of the one in flight.
    private func streamIsCurrent(through index: UInt64) -> Bool {
        guard let newest = status.storage?.value.newestPage else { return false }
        return Int64(clamping: index) >= newest - 1 - Self.sealedPageInFlight
    }

    private func startCycle(_ generation: UInt64) async {
        guard let current = session, current.generation == generation else { return }
        guard current.drain == nil, !current.awaitingInfo, !current.queries.contains(where: { $0.purpose == .drain })
        else {
            // Coalesced: the drain or query under way answers it, then one more look (`finish`).
            session?.catchUpPending = true
            return
        }
        // The clock must be synced on every (re)connect and cycle, or recording can't restart after a reset.
        let millis = Int64(max(0, now().timeIntervalSince1970 * 1000))
        // A trusted press since the last set says how far off the RTC is now, just before this set.
        let reading = current.clockOffsetMillis.map { millis + $0 }
        if await send(.setCurrentTime(unixMillis: UInt64(millis)), generation) != nil, current.kind.anchorsClock {
            session?.clockSet = (millis, reading)
            session?.clockOffsetMillis = nil
        }
        status.sync = .requestingStatus
        if current.life == nil { await identify(generation) } else { await query(.drain, generation) }
        // After the drain query is registered, so this await can't let a second cycle start.
        await transport.readBattery()
    }

    /// Asks which Pendant this is and which flash life it's in, once per connection, before its first drain.
    private func identify(_ generation: UInt64) async {
        session?.awaitingInfo = true
        guard await send(.getDeviceInfo, generation) != nil else { return }
        let timeout = configuration.replyTimeout
        Task {
            try? await clock.sleep(for: timeout)
            await self.identityTimedOut(generation)
        }
    }

    private func identityTimedOut(_ generation: UInt64) async {
        guard let current = session, current.generation == generation, current.awaitingInfo else { return }
        // Writes are silently dropped when another host holds the bond.
        guard current.hasReplied else { return await apply(connection.handle(.unresponsive(current.peripheral))) }
        await identified(nil, generation)
    }

    /// Without `DeviceInfo` the current life is kept; a re-used index still starts a new one.
    private func identified(_ info: DeviceInfo?, _ generation: UInt64) async {
        guard session?.generation == generation, session?.awaitingInfo == true else { return }
        let life: FlashLife
        do {
            life = try await sink.flashLife(deviceID: deviceID, evidence: info?.flashLifeEvidence)
        } catch {
            guard session?.generation == generation else { return }
            session?.awaitingInfo = false
            status.sync = .failed(.storage(String(describing: error)))
            return
        }
        guard session?.generation == generation else { return }
        session?.awaitingInfo = false
        session?.life = life
        await query(.drain, generation)
    }

    private func beginDrain(_ storage: StorageState, unsaved: UInt64, _ generation: UInt64) async {
        guard let current = session, current.generation == generation, let base = current.life?.base else { return }
        // This reply is newer than any trigger before it.
        session?.catchUpPending = false
        guard current.drain == nil else {
            // A pushed page is being saved: look again once it is.
            session?.catchUpPending = true
            return
        }
        // With the stream open, the page being written arrives by itself once sealed.
        let pending: Int64 = current.tailing ? 1 : 0
        let saved =
            current.verified.map {
                $0.lowerBound <= storage.oldestPage && Int64($0.upperBound) >= storage.newestPage - pending
            } ?? false
        // A download that brings nothing new is skipped: always while the stream is open (pushed pages ACK as they
        // settle), and in observe mode, where nothing is ACKed, also when it is closed.
        if storage.backlogPages == 0 || (saved && (current.tailing || configuration.ackPolicy == .observe)) {
            if !current.kind.holdsLink {
                status.sync = .caughtUp(at: now())
                return await letGo(generation)
            }
            if !current.tailing {
                // Open the stream for the pages the Pendant seals from now on.
                session?.tailing = true
                await send(.setDownloadMode(.download), generation)
            }
            // Nothing to read on flash: a NOT_RECORDING report waiting on its evidence is a plain pause.
            await applyRecording(.flash(nil), generation)
            status.sync = .caughtUp(at: now())
            return
        }
        drainCounter += 1
        var drain = Drain(
            id: drainCounter, kind: current.kind, base: base, oldest: storage.oldestPage,
            newest: UInt64(storage.newestPage),
            progress: DrainProgress(expected: unsaved, received: 0, settled: 0))
        drain.firstUnsaved = UInt64(storage.newestPage) + 1 - unsaved
        session?.drain = drain
        session?.tailing = false
        status.sync = .downloading(drain.progress)
        await send(.setDownloadMode(.download), generation)
        watchForIdleDownload(generation, drain.id)
    }

    private func enqueue(_ page: StorageBuffer, _ generation: UInt64) {
        if session?.generation == generation, session?.drain == nil { startTail(at: page) }
        // Pages with neither a drain nor an open stream are ignored; nothing was ACKed, so they come back next drain.
        guard
            let start = updateDrain(
                generation, nil,
                { drain -> Bool in
                    drain.queue.append(page)
                    drain.progress.received += 1
                    if page.index >= drain.newest { drain.downloadFinished = true }
                    if !drain.pushed { status.sync = .downloading(drain.progress) }
                    let start = !drain.isPersisting
                    drain.isPersisting = true
                    return start
                })
        else { return }
        let through = max(session?.streamedThrough ?? page.index, page.index)
        session?.streamedThrough = through
        guard start, let id = session?.drain?.id else { return }
        // ponytail: handles are kept only for `waitForPersistence`; the last few are enough.
        persistTasks = persistTasks.suffix(15) + [Task { await self.persistLoop(generation, id) }]
    }

    /// A page the Pendant pushed by itself on the open stream gets a small drain of its own. It continues this
    /// connection's verified run (or starts at the Pendant's oldest page), so the usual fencing, gap and ACK rules
    /// hold: a run that doesn't reach it never ACKs it.
    private func startTail(at page: StorageBuffer) {
        guard let current = session, current.tailing, let base = current.life?.base,
            let oldest = current.verified?.lowerBound ?? status.storage?.value.oldestPage
        else { return }
        drainCounter += 1
        var drain = Drain(
            id: drainCounter, kind: current.kind, base: base, oldest: oldest, newest: page.index,
            progress: DrainProgress(expected: 1, received: 0, settled: 0))
        drain.pushed = true
        drain.settledThrough = current.verified?.upperBound
        drain.settledSinceAck = current.unackedTail
        session?.drain = drain
    }

    private func persistLoop(_ generation: UInt64, _ id: UInt64) async {
        while case let (page, base, kind)? = updateDrain(
            generation, id, { $0.queue.isEmpty ? nil : ($0.queue.removeFirst(), $0.base, $0.kind) }) ?? nil
        {
            let settled: Settled
            var carriedInto: FlashLife?
            do {
                settled = try await settle(page, base: base, kind: kind)
                // A ring that freed what it sent can't send it again: the drain carries on into a new life.
                if case .otherFlashLife(let index) = settled, carriesDrainIntoNewLife(kind) {
                    carriedInto = try await sink.startNewFlashLife(
                        deviceID: deviceIDs(kind), reason: Self.reused(index))
                }
            } catch {
                guard updateDrain(generation, id, { _ in () }) != nil else { return }
                session?.drain = nil
                let detail = String(describing: error)
                status.incidents.insert(.storageWriteFailed(detail))
                status.sync = .failed(.storage(detail))
                // Stop the stream while nothing can be saved; the next cycle opens it again.
                session?.tailing = false
                await send(.setDownloadMode(.recordOnly), generation)
                return await letGo(generation)
            }
            // Fence: if the connection or drain changed while we awaited, this work may never ACK.
            guard let ackDue = updateDrain(generation, id, { record(settled, in: &$0) }) else { return }
            if case .otherFlashLife(let index) = settled {
                guard let carriedInto else { return await startNewFlashLife(Self.reused(index), generation) }
                carry(page, into: carriedInto, generation, id)
                continue
            }
            if ackDue { await acknowledge(generation, id) }
        }
        let finished = updateDrain(generation, id) { drain -> Bool in
            drain.isPersisting = false
            return drain.downloadFinished
        }
        if finished == true { await finish(generation, id) }
    }

    /// Makes one page durable, records it as an explicit gap with the device's evidence, or holds it on the Pendant.
    private func settle(_ page: StorageBuffer, base: UInt64, kind: DeviceKind) async throws -> Settled {
        let key = PageKey(deviceID: deviceIDs(kind), index: base + page.index)
        // The Pendant says the audio is gone. A page already stored stays kept: the Pendant re-sent one it had cleared
        // and can no longer read.
        if let error = page.error {
            let reason: GapReason = error == .readFailed ? .deviceReadFailed : .deviceCorrupt
            return try await sink.recordGap(key, reason: reason, evidence: page.raw)
                ? .gap(page.index, reason) : .kept(page.index, stored: nil)
        }
        // Audio we can't use yet stays on the Pendant until the owner accepts it as a gap.
        func hold(_ reason: HeldReason) async throws -> Settled {
            try await sink.recordHeld(key, reason: reason, evidence: page.raw)
                ? .gap(page.index, reason.gap) : .held(page.index, reason)
        }
        let content: DecodedPage
        do {
            content = try kind.decodePage(page.raw)
        } catch {
            return try await hold(.undecodable(detail: String(describing: error)))
        }
        guard let timestamp = content.timestampMillis, let millis = Int64(exactly: timestamp) else {
            return try await hold(.undecodable(detail: "flash page has no timestamp"))
        }
        if content.encrypted { return try await hold(.encrypted) }
        let raw = RawPage(
            key: key, session: page.session, deviceTimeMillis: millis, payload: page.raw, receivedAt: now())
        switch try await sink.persist(raw) {
        case .stored:
            return .kept(page.index, stored: (Double(content.packets.count) * 0.02, page.raw.count))
        case .duplicate: return .kept(page.index, stored: nil)
        case .conflict: return .conflict(page.index)
        case .indexReused: return .otherFlashLife(page.index)
        }
    }

    /// The Pendant's flash restarted (cleared or reset) without its identity saying so: it re-used an index with
    /// another device time, or an Omi's ring numbers fell below what the phone holds. Stop, then drain again into a new
    /// flash life, where no old receipt can match.
    private func startNewFlashLife(_ reason: String, _ generation: UInt64) async {
        guard session?.generation == generation else { return }
        session?.drain = nil
        session?.verified = nil
        session?.streamedThrough = nil
        session?.tailing = false
        await send(.setDownloadMode(.recordOnly), generation)
        guard let life = try? await sink.startNewFlashLife(deviceID: deviceID, reason: reason) else {
            status.sync = .failed(.storage("could not start a new flash life"))
            return await letGo(generation)
        }
        guard session?.generation == generation else { return }
        session?.life = life
        await startCycle(generation)
    }

    private static func reused(_ index: UInt64) -> String { "page \(index) came back with another device time" }

    /// Only an Omi whose firmware frees records on delivery (`OmiFirmware`): there the ring can't send a clashing
    /// record again. On custody firmware the ring keeps every record not ADVANCEd, so a clash starts a fresh drain into
    /// the new life, and a held or conflicting page earlier in the drain still stops the ACK.
    private func carriesDrainIntoNewLife(_ kind: DeviceKind) -> Bool {
        kind.carriesDrainIntoNewLife && OmiFirmware.freesOnDelivery(status.firmwareRevision)
    }

    /// The clashing page and the rest of the queue go into `life` and the drain goes on. Its run starts again at that
    /// page, so no receipt of the old life vouches for the new one.
    private func carry(_ page: StorageBuffer, into life: FlashLife, _ generation: UInt64, _ id: UInt64) {
        let carried: Void? = updateDrain(generation, id) { drain in
            drain.base = life.base
            drain.oldest = page.index
            drain.settledThrough = nil
            drain.settledAhead = []
            drain.settledSinceAck = 0
            drain.queue.insert(page, at: 0)
        }
        guard carried != nil else { return }
        session?.life = life
        session?.verified = nil
    }

    /// Returns whether a batched ACK is due.
    private func record(_ settled: Settled, in drain: inout Drain) -> Bool {
        let index: UInt64
        var phase: DrainPhase?
        switch settled {
        case .kept(let kept, let stored):
            index = kept
            if let stored {
                measuredAudio = (measuredAudio.seconds + stored.audioSeconds, measuredAudio.pages + 1)
                status.saved.bytes += stored.bytes
                if drain.pushed { status.saved.pushed += 1 } else { status.saved.pulled += 1 }
            } else {
                status.saved.duplicates += 1
            }
            clearIncidents { if case .storageWriteFailed = $0 { true } else { false } }
        case .gap(let gap, let reason):
            index = gap
            phase = .gapRecorded(index: gap, reason: reason)
        case .conflict(let conflict):
            status.incidents.insert(.integrityConflict(index: conflict))
            return false
        case .held(let held, .encrypted):
            status.incidents.insert(.encryptedAudio(index: held))
            return false
        case .held(let held, .undecodable):
            status.incidents.insert(.undecodablePage(index: held))
            return false
        case .otherFlashLife:
            return false
        }
        drain.markSettled(index)
        if index >= drain.firstUnsaved { drain.progress.settled += 1 }
        drain.settledSinceAck += 1
        if let phase {
            status.sync = phase
        } else if !drain.pushed {
            status.sync = drain.downloadFinished ? .persisting(drain.progress) : .downloading(drain.progress)
        }
        return drain.settledSinceAck >= configuration.ackBatchSize
    }

    /// Sends `DeleteFlashPage` for the most the sink authorizes, capped by this drain's own evidence.
    private func acknowledge(_ generation: UInt64, _ id: UInt64) async {
        guard
            let drain = updateDrain(
                generation, id,
                { drain -> Drain in
                    drain.settledSinceAck = 0
                    return drain
                })
        else { return }
        // Observe mode never sends DeleteFlashPage.
        guard configuration.ackPolicy == .acknowledge, drain.settledThrough != nil else { return }
        let authorized = try? await sink.ackableIndex(deviceID: deviceID, startingAt: drain.base + drain.oldest)
        // Fence: the answer belongs to this drain only if it is still the live one.
        guard let current = updateDrain(generation, id, { $0 }), let authorized = authorized ?? nil,
            let settled = current.settledThrough
        else { return }
        // Back to the Pendant's own index: the sink answers in store indices, at least `base + oldest`.
        let target = min(authorized - current.base, settled)
        guard target >= current.oldest, current.acked.map({ target > $0 }) ?? true else { return }
        status.sync = .acking(throughIndex: target)
        guard await send(.acknowledge(throughIndex: target), generation) != nil else { return }
        if updateDrain(generation, id, { $0.acked = target }) != nil { status.lastAcknowledgedIndex = target }
    }

    private func finish(_ generation: UInt64, _ id: UInt64) async {
        guard
            let drain = updateDrain(
                generation, id,
                { drain -> Drain? in
                    guard !drain.finishing else { return nil }
                    drain.finishing = true
                    return drain
                }) ?? nil
        else { return }
        // Download mode stays on (`Session.tailing`): pages sealed from now on arrive by themselves, if the firmware
        // pushes them. A pushed drain ACKs in batches as it settles.
        session?.tailing = true
        if !drain.pushed { await acknowledge(generation, id) }
        let start = drain.base + drain.oldest
        let savedThrough = (try? await sink.savedIndex(deviceID: deviceID, startingAt: start)) ?? nil
        guard
            let (settled, flashMode, sinceAck) = updateDrain(
                generation, id,
                { drain -> (UInt64?, Observed<Bool>?, Int)? in
                    // A page arrived while this awaited: its persist loop finishes the drain again.
                    guard !drain.isPersisting else {
                        drain.finishing = false
                        return nil
                    }
                    return (drain.settledThrough, drain.flashMode, drain.settledSinceAck)
                }) ?? nil
        else { return }
        session?.drain = nil
        session?.unackedTail = sinceAck
        // One pushed page saying nothing about the mode is not the whole flash saying nothing.
        if flashMode != nil || !drain.pushed { await applyRecording(.flash(flashMode), generation) }
        session?.verified = settled.map { drain.oldest...$0 }
        // The last status, recounted at its own instant: one the Pendant pushes as a page seals comes before that
        // page, so only now does its backlog shrink to the page being written (`FactsBuilder.savedThrough`). A status
        // newer than `savedThrough` only counts more pages unsaved.
        if let storage = status.storage {
            updateBacklog(storage.value, savedThrough: savedThrough.map { $0 - drain.base }, at: storage.at)
        }
        if let settled, settled >= drain.newest {
            // A pushed page is caught up only with the Pendant's newest: after a download that ended early, the
            // older pages still streaming arrive this way too.
            if !drain.pushed || streamIsCurrent(through: settled) { status.sync = .caughtUp(at: now()) }
        } else {
            // A page never delivered stalls the ACK; it is never skipped.
            status.sync = .failed(.incomplete(missingFrom: settled.map { $0 + 1 } ?? drain.oldest))
        }
        if !drain.pushed, session?.kind.holdsLink == false { return await letGo(generation) }
        if session?.catchUpPending == true {
            session?.catchUpPending = false
            await catchUp(generation)
        }
    }

    /// An Omi drops its audio while a phone is connected (`DeviceKind.holdsLink`): once a drain settles, let go until
    /// the next sync connects again.
    private func letGo(_ generation: UInt64) async {
        guard let current = session, current.generation == generation, !current.kind.holdsLink else { return }
        await apply(connection.handle(.release(current.peripheral)))
    }

    private func watchForIdleDownload(_ generation: UInt64, _ id: UInt64) {
        let idle = configuration.pageIdleTimeout
        Task {
            var received: UInt64 = 0
            while true {
                try? await clock.sleep(for: idle)
                guard let drain = updateDrain(generation, id, { $0 }), !drain.downloadFinished else { return }
                // A page came since the last look: the download is still going.
                guard drain.progress.received == received else {
                    received = drain.progress.received
                    continue
                }
                _ = updateDrain(generation, id) { $0.downloadFinished = true }
                if !drain.isPersisting { await finish(generation, id) }
                return
            }
        }
    }

    /// Mutates the live drain only if `generation` (and `id`, when given) still match. `nil` means fenced off.
    private func updateDrain<T>(_ generation: UInt64, _ id: UInt64?, _ body: (inout Drain) -> T) -> T? {
        guard session?.generation == generation, var drain = session?.drain, id == nil || drain.id == id else {
            return nil
        }
        let result = body(&drain)
        session?.drain = drain
        return result
    }

    // MARK: Recording control

    private func requestRecording(_ intent: RecordingIntent) async {
        guard let generation = session?.generation else { return }
        await applyRecording(.requested(intent, at: now()), generation)
    }

    private func applyRecording(_ event: RecordingEvent, _ generation: UInt64) async {
        let effects = recording.handle(event)
        applyRecordingState(effects)
        for effect in effects {
            switch effect {
            case .send(let command):
                let requestID = await send(command, generation)
                session?.controlRequest = requestID
            case .confirmByStatusQuery:
                let request = recording.state
                await query(.confirmRecording, generation)
                let timeout = configuration.replyTimeout
                Task {
                    try? await clock.sleep(for: timeout)
                    await self.confirmationDeadline(for: request, generation)
                }
            case .refreshStatus:
                await query(.refresh, generation)
            case .confirmed(let kind, let at):
                // A failed write only costs a split; capture goes on.
                let change = RecordingChange(kind, at: CaptureInstant(millis: Int64(at.timeIntervalSince1970 * 1000)))
                try? await sink.recordRecordingChange(change, deviceID: deviceID)
            case .alertUnexpectedStop:
                break
            }
        }
    }

    /// Fails only the request it was set for; a newer request has its own deadline.
    private func confirmationDeadline(for request: RecordingState, _ generation: UInt64) async {
        guard session?.generation == generation, recording.state == request else { return }
        applyRecordingState(recording.handle(.confirmationTimedOut(at: now())))
    }

    private func pollConfirmation(_ generation: UInt64) {
        let interval = configuration.confirmationPollInterval
        Task {
            try? await clock.sleep(for: interval)
            await self.confirmationPollDue(generation)
        }
    }

    private func confirmationPollDue(_ generation: UInt64) async {
        guard session?.generation == generation, recording.pendingIntent != nil else { return }
        await query(.confirmRecording, generation)
    }

    private func applyRecordingState(_ effects: [RecordingEffect]) {
        status.recording = recording.state
        status.lastKnownRecording = recording.lastObserved
        if effects.contains(.alertUnexpectedStop) { status.incidents.insert(.recordingStoppedUnexpectedly) }
        // The alert is the failed request itself (`RecordingControl` keeps it until the owner is served or acts again).
        if case .failed(let failure, _) = recording.state {
            status.incidents.insert(.recordingControlFailed(failure))
        } else {
            clearIncidents { if case .recordingControlFailed = $0 { true } else { false } }
        }
        if case .recording = recording.state {
            clearIncidents { if case .recordingStoppedUnexpectedly = $0 { true } else { false } }
        }
    }

    private func clearIncidents(where matches: (CaptureIncident) -> Bool) {
        status.incidents = status.incidents.filter { !matches($0) }
    }
}

extension FlashPage {
    /// A storage-session marker the sound detector wrote within `SoundEvidence.liveWindow` of now: a live state
    /// change, not history from a replay.
    fileprivate func hasLiveSessionMarker(now: Date) -> Bool {
        guard let opened = timestampMillis, opened > Self.earliestPlausibleMillis else { return false }
        return chunks.contains { chunk in
            guard let storage = chunk.storage, storage.didStartSession || storage.didStopSession else { return false }
            let at = Date(timeIntervalSince1970: (Double(opened) + Double(max(chunk.timeOffsetMillis ?? 0, 0))) / 1000)
            return abs(now.timeIntervalSince(at)) <= SoundEvidence.liveWindow
        }
    }
}
