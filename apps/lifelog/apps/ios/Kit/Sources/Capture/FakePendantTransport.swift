// Debug only: compiled out of Release builds by `#if DEBUG`, so it can never ship. SwiftPM and Xcode both define
// DEBUG for the Debug configuration of package targets. One file and no extra target keeps the app wiring trivial.
#if DEBUG
    import Foundation
    import PendantProtocol

    /// A scriptable simulated Pendant that speaks the real wire protocol, so every device state is reproducible in
    /// the simulator and in tests: flash pages, sessions, buttons, the firmware long-press toggle, pause/resume,
    /// another app holding the bond, links dropping mid-drain, corrupt pages and clock skew.
    public actor FakePendantTransport: PendantTransport {
        public struct Page: Sendable, Equatable {
            public var index: UInt64
            public var session: Int64
            public var timestampMillis: UInt64
            public var opusPackets: [Data]
            public var error: FlashPageError?
            public var encrypted = false
            /// Flash bytes the app can't decode, like a new firmware format.
            public var garbled = false
            /// Storage-session markers, as the firmware's sound detector writes them around stored audio.
            public var startsSession = false
            public var stopsSession = false
            /// A firmware log line, as `Chunk.log_output`.
            public var log: String?
        }

        public nonisolated let events: AsyncStream<TransportEvent>
        public nonisolated let id = UUID()
        private let continuation: AsyncStream<TransportEvent>.Continuation

        // Device state.
        public private(set) var flash: [Page] = []
        public private(set) var isRecording = true
        public private(set) var ledBrightness: UInt32?
        private var nextIndex: UInt64
        private var session: Int64 = 1
        /// Pendant RTC minus real time. Pages recorded before a time sync carry it.
        private var clockSkewMillis: Int64 = 0
        private let totalPages: UInt64 = 120_000
        private var storageInstance: UInt64 = 1
        private var batteryPercent = 82
        private var charging = false
        /// Whether the standard battery service (0x180F) is there. Without it only status messages carry the level.
        private let hasBatteryService: Bool
        /// Battery levels read from 0x2A19, the connect read included.
        public private(set) var batteryReads = 0

        // Link and radio.
        private var availability: BluetoothAvailability = .poweredOn
        private var inRange = true
        private var connected = false
        private var pendingConnect = false
        /// Like CoreBluetooth, a scan runs until stopped and reports the Pendant whenever it is in range.
        public private(set) var isScanning = false
        private var messageIndex: UInt64 = 0
        /// Quick presses since boot, as the firmware counts them.
        private var shortPresses: UInt64 = 0
        private var streaming: Task<Void, Never>?
        /// Download mode is on: after the replay each new page is sent as it seals.
        private var downloading = false
        private var replaying = false
        private var voice: Task<Void, Never>?

        // Behaviours.
        private var busyWithOtherClient = false
        private var needsPairing = false
        private var withholdsReady = false
        private var ignoresRecordingCommands = false
        private var answersDeviceInfo = true
        private var hangsWrites = false
        private var hungWrites: [CheckedContinuation<Void, Never>] = []
        private var neverSends: Set<UInt64> = []
        private var dropLinkAfterPages: Int?
        private let maxFragmentSize: Int
        /// How long the firmware takes to apply a start or stop command before its status reflects it.
        private let recordingChangeDelay: Duration
        /// Time between two pages of a download, to model a long backlog over a real link. Commands interleave.
        private let pageInterval: Duration
        /// Whether download mode keeps sending each page as it seals once the backlog is out. UNVERIFIED on hardware,
        /// so tests run both ways.
        private let pushesSealedPages: Bool

        /// Every command the phone wrote, decoded, including ones a busy Pendant dropped.
        public private(set) var commands: [PendantCommand] = []
        public private(set) var connectionCount = 0

        public init(
            firstIndex: UInt64 = 100, maxFragmentSize: Int = 185, recordingChangeDelay: Duration = .zero,
            pageInterval: Duration = .zero, hasBatteryService: Bool = true, pushesSealedPages: Bool = true
        ) {
            nextIndex = firstIndex
            self.maxFragmentSize = maxFragmentSize
            self.recordingChangeDelay = recordingChangeDelay
            self.pageInterval = pageInterval
            self.hasBatteryService = hasBatteryService
            self.pushesSealedPages = pushesSealedPages
            (events, continuation) = AsyncStream.makeStream()
        }

        // MARK: Scenario controls

        /// Records `count` pages of 20 ms Opus packets (some 1-byte DTX packets included).
        public func record(pages count: Int, packetsPerPage: Int = 50) {
            // Like the firmware, each page is stamped when it opens, so the pages end now and follow each other.
            let pageMillis = Int64(packetsPerPage) * 20
            let start = Int64(Date().timeIntervalSince1970 * 1000) + clockSkewMillis - Int64(count) * pageMillis
            for page in 0..<count {
                append(packets: packetsPerPage, openedAt: start + Int64(page) * pageMillis)
            }
        }

        /// One detection, like the firmware's sound detector (docs/research/pendant-vad.md): a storage session of
        /// audio pages, opened by a start marker and closed by a stop marker, ending now. Like the firmware, a status
        /// is pushed at each state change.
        public func recordVoice(pages count: Int, packetsPerPage: Int = 75) {
            let pageMillis = Int64(packetsPerPage) * 20
            let start = Int64(Date().timeIntervalSince1970 * 1000) + clockSkewMillis - Int64(count) * pageMillis
            session += 1
            sendUnsolicitedStatus()
            for page in 0..<count {
                append(
                    packets: packetsPerPage, openedAt: start + Int64(page) * pageMillis, startsSession: page == 0,
                    stopsSession: page == count - 1)
            }
            session += 1
            sendUnsolicitedStatus()
        }

        /// Talks in real time while recording: `quiet` of silence (nothing stored), then a detection that seals a
        /// page every 1.5 s, over and over until the fake goes away.
        public func simulateVoiceActivity(quiet: Duration = .seconds(6), pages: Int = 5) {
            voice?.cancel()
            voice = Task { [weak self] in
                while (try? await Task.sleep(for: quiet)) != nil {
                    for page in 0..<pages {
                        guard (try? await Task.sleep(for: .milliseconds(1500))) != nil, let self else { return }
                        await self.speak(page: page, of: pages)
                    }
                }
            }
        }

        private func speak(page: Int, of count: Int) {
            // A real pause turns the microphones off: nothing to detect.
            guard isRecording else { return }
            if page == 0 {
                session += 1
                sendUnsolicitedStatus()
            }
            let now = Int64(Date().timeIntervalSince1970 * 1000) + clockSkewMillis
            append(packets: 75, openedAt: now - 1500, startsSession: page == 0, stopsSession: page == count - 1)
            if page == count - 1 {
                session += 1
                sendUnsolicitedStatus()
            }
        }

        private func append(
            packets count: Int, openedAt millis: Int64, startsSession: Bool = false, stopsSession: Bool = false,
            log: String? = nil
        ) {
            let packets = (0..<count).map {
                $0 % 10 == 9 ? Data([0xb8]) : Data([0xb8] + [UInt8](repeating: 0x5a, count: 39))
            }
            let page = Page(
                index: nextIndex, session: session, timestampMillis: UInt64(max(0, millis)), opusPackets: packets,
                startsSession: startsSession, stopsSession: stopsSession, log: log)
            flash.append(page)
            nextIndex += 1
            // Sealed: in download mode it goes out now, after any replay still running.
            if downloading, !replaying, pushesSealedPages, !neverSends.contains(page.index) {
                emit { $0.bytes(2, Self.storageBuffer(page)) }
            }
        }

        public func setClockSkew(millis: Int64) { clockSkewMillis = millis }
        public func corrupt(index: UInt64, as error: FlashPageError) { mutate(index) { $0.error = error } }
        public func encrypt(index: UInt64) { mutate(index) { $0.encrypted = true } }
        public func garble(index: UInt64, _ garbled: Bool = true) { mutate(index) { $0.garbled = garbled } }
        /// The Pendant holds these pages but never sends them.
        public func withhold(index: UInt64) { neverSends.insert(index) }
        /// A withheld page is sent again from the next download.
        public func release(index: UInt64) { neverSends.remove(index) }
        public func dropLink(afterSendingPages count: Int?) { dropLinkAfterPages = count }
        public func setBusyWithOtherClient(_ busy: Bool) { busyWithOtherClient = busy }
        public func setNeedsPairing(_ needs: Bool) { needsPairing = needs }
        /// The link comes up but never reports ready, as on 25 Oct.
        public func setWithholdsReady(_ withholds: Bool) { withholdsReady = withholds }
        public func setIgnoresRecordingCommands(_ ignores: Bool) { ignoresRecordingCommands = ignores }
        public func setAnswersDeviceInfo(_ answers: Bool) { answersDeviceInfo = answers }
        /// Writes never complete until the link drops, like a write-with-response whose callback never comes.
        public func setHangsWrites(_ hangs: Bool) { hangsWrites = hangs }
        public var hungWriteCount: Int { hungWrites.count }

        public var info: DeviceInfo {
            DeviceInfo(deviceID: 7, serial: "FAKE-0001", storageInstance: storageInstance, factoryResetID: 0)
        }

        /// Storage cleared by another host: flash is emptied and page indices restart at `index`. Whether
        /// `storage_instance` changes on real firmware is UNVERIFIED, so a test picks.
        public func clearStorage(restartingAt index: UInt64, newStorageInstance: Bool) {
            flash = []
            nextIndex = index
            session += 1
            if newStorageInstance { storageInstance += 1 }
        }

        public func setBluetooth(_ new: BluetoothAvailability) {
            availability = new
            if new != .poweredOn, connected { linkLost("Bluetooth turned off") }
            continuation.yield(.availability(new))
            reachIfPossible()
        }

        public func setInRange(_ near: Bool) {
            inRange = near
            if !near, connected { linkLost("out of range") }
            reachIfPossible()
        }

        /// The standard battery level characteristic notifies only when the level changes; status messages carry
        /// the charge state and the level.
        public func setBattery(percent: Int, charging: Bool) {
            let changed = percent != batteryPercent
            batteryPercent = percent
            self.charging = charging
            if connected, hasBatteryService, changed { continuation.yield(.batteryLevel(percent)) }
        }

        /// A quick press.
        public func pressButton() { emitButton(.short) }

        /// A ~2 s hold: the firmware toggles recording by itself.
        public func longPress() {
            setRecording(!isRecording)
            emitButton(.long)
        }

        /// Like the firmware: a stop switches to idle mode (microphones off), a start wakes it, and the log line lands
        /// on flash. It runs an app's command the same way, as a long press.
        private func setRecording(_ on: Bool) {
            guard on != isRecording else { return }
            isRecording = on
            let event = "event BUTTON_LONG_PRESS (data=0)"
            let now = Int64(Date().timeIntervalSince1970 * 1000) + clockSkewMillis
            append(
                packets: 0, openedAt: now,
                log: on ? "Waking up from idle mode after \(event)" : "Switching to idle mode after \(event)")
        }

        /// An unsolicited status, like the one the Pendant pushes after each state change.
        /// Sends what the app must drop: a malformed fragment, then a whole message that doesn't decode.
        public func sendGarbage() {
            guard connected else { return }
            continuation.yield(.notification(Data([0xFF])))
            continuation.yield(.notification(Fragment(index: messageIndex, payload: Data([0xFF, 0xFF])).encoded))
            messageIndex += 1
        }

        public func sendUnsolicitedStatus() { emit(content: { $0.message(5, deviceStatus) }) }

        // MARK: PendantTransport

        public func start() { continuation.yield(.availability(availability)) }

        public func scan() {
            isScanning = true
            reachIfPossible()
        }

        public func stopScan() { isScanning = false }

        public func connect(_ peripheral: UUID) {
            guard peripheral == id, !connected else { return }
            pendingConnect = true
            reachIfPossible()
        }

        public func disconnect() {
            pendingConnect = false
            guard connected else { return }
            connected = false
            downloading = false
            streaming?.cancel()
            for write in hungWrites { write.resume() }
            hungWrites = []
            continuation.yield(.disconnected(id, .cancelled))
        }

        public func readBattery() {
            guard connected, hasBatteryService else { return }
            batteryReads += 1
            continuation.yield(.batteryLevel(batteryPercent))
        }

        public func write(_ fragment: Data, to target: WriteTarget) async throws(TransportError) {
            guard connected, target == .control else { throw .notReady }
            if hangsWrites {
                await withCheckedContinuation { hungWrites.append($0) }
                throw .notReady
            }
            guard !needsPairing else { throw .insufficientAuthentication }
            guard let payload = try? Fragment(decoding: fragment).payload,
                let (command, requestID) = try? PendantCommand.decode(payload)
            else { throw .writeFailed("undecodable command") }
            commands.append(command)
            // Bonded to another host: writes are accepted at the link layer and silently dropped.
            guard !busyWithOtherClient else { return }
            execute(command, requestID: requestID ?? 0)
        }

        // MARK: Firmware

        private func execute(_ command: PendantCommand, requestID: Int64) {
            switch command {
            case .setCurrentTime:
                clockSkewMillis = 0
                emit(requestID: requestID) { $0.message(3) { $0.varint(2, 0) } }
            case .getDeviceStatus:
                emit(requestID: requestID) { $0.message(5, deviceStatus) }
            case .getDeviceInfo:
                guard answersDeviceInfo else { return }
                let info = info
                // Real firmware often omits the request id here.
                emit { message in
                    message.message(1) {
                        $0.varint(1, info.deviceID ?? 0)
                        $0.bytes(2, Data((info.serial ?? "").utf8))
                        $0.varint(5, info.storageInstance ?? 0)
                        $0.varint(16, info.factoryResetID ?? 0)
                    }
                }
            case .setDownloadMode(.download):
                streaming?.cancel()
                downloading = true
                streaming = Task { await streamFlash() }
            case .setDownloadMode:
                streaming?.cancel()
                downloading = false
            case .acknowledge(let index):
                flash.removeAll { $0.index <= index }
            case .startRecording, .stopRecording:
                emit(requestID: requestID) { _ in }
                guard !ignoresRecordingCommands else { return }
                let recording = command == .startRecording
                if recordingChangeDelay == .zero {
                    setRecording(recording)
                    return
                }
                Task {
                    try? await Task.sleep(for: recordingChangeDelay)
                    setRecording(recording)
                }
            case .setLEDBrightness(let level):
                ledBrightness = level
            }
        }

        private func streamFlash() async {
            var sent = 0
            var cursor: UInt64 = 0
            replaying = true
            // Unacked pages are re-delivered from the oldest on every download, then the ones sealed meanwhile.
            repeat {
                for page in flash where page.index >= cursor {
                    cursor = page.index + 1
                    guard !neverSends.contains(page.index) else { continue }
                    guard !Task.isCancelled, connected else { return }
                    emit { $0.bytes(2, Self.storageBuffer(page)) }
                    sent += 1
                    if let limit = dropLinkAfterPages, sent >= limit {
                        dropLinkAfterPages = nil
                        linkLost("dropped mid-drain")
                        return
                    }
                    if pageInterval > .zero { try? await Task.sleep(for: pageInterval) } else { await Task.yield() }
                }
            } while flash.last.map { $0.index >= cursor } ?? false
            guard !Task.isCancelled else { return }
            replaying = false
        }

        private func deviceStatus(_ status: inout ProtoWriter) {
            let oldest = flash.first?.index ?? nextIndex
            status.message(5) { storage in
                storage.varint(1, oldest)
                storage.varint(2, UInt64(bitPattern: Int64(nextIndex) - 1))
                storage.varint(3, UInt64(session))
                storage.varint(4, totalPages - UInt64(flash.count))
                storage.varint(5, totalPages)
            }
            status.message(7) { $0.varint(1, isRecording ? 1 : 0) }
            // proto3: state 0 is omitted, which is why a discharging reading has no field 1.
            status.message(9) { battery in
                if charging { battery.varint(1, 1) }
                battery.varint(5, UInt64(batteryPercent))
            }
        }

        static func storageBuffer(_ page: Page) -> Data {
            var buffer = ProtoWriter()
            buffer.varint(1, 2)
            buffer.varint(2, UInt64(page.session))
            buffer.varint(5, page.index)
            if let error = page.error {
                buffer.varint(7, error.rawValue)
                return buffer.data
            }
            if page.garbled {
                // A length that runs past the end of the page.
                buffer.bytes(6, Data([0x0A, 0x7F]))
                return buffer.data
            }
            buffer.message(6) { flash in
                flash.varint(1, page.timestampMillis)
                if page.startsSession {
                    flash.message(3) { $0.message(12) { $0.bool(1, true) } }
                }
                for (offset, packet) in page.opusPackets.enumerated() {
                    flash.message(3) { chunk in
                        chunk.varint(1, UInt64(offset * 20))
                        chunk.message(2) { audio in
                            if page.encrypted {
                                audio.message(13) { $0.bytes(2, packet) }
                            } else {
                                audio.bytes(4, packet)
                            }
                        }
                    }
                }
                if let log = page.log {
                    flash.message(3) { $0.message(10) { $0.bytes(1, Data(log.utf8)) } }
                }
                if page.stopsSession {
                    flash.message(3) { chunk in
                        chunk.varint(1, UInt64(page.opusPackets.count * 20))
                        chunk.message(12) { $0.bool(2, true) }
                    }
                }
            }
            return buffer.data
        }

        private func emitButton(_ event: ButtonEvent) {
            let time = UInt64(Date().timeIntervalSince1970 * 1000)
            if event == .short { shortPresses += 1 }
            let presses = shortPresses
            emit { message in
                message.message(8) {
                    $0.varint(1, event.rawValue)
                    $0.varint(3, presses)
                    $0.varint(6, time)
                }
            }
        }

        /// Encodes a `PendantAllMsg` and sends it as notifications, fragmented at the simulated MTU.
        private func emit(requestID: Int64? = nil, content: (inout ProtoWriter) -> Void) {
            guard connected else { return }
            var message = ProtoWriter()
            content(&message)
            if let requestID { message.message(6) { $0.varint(1, UInt64(bitPattern: requestID)) } }
            for fragment in Fragment.split(message.data, index: messageIndex, maxFragmentSize: maxFragmentSize) {
                continuation.yield(.notification(fragment.encoded))
            }
            messageIndex += 1
        }

        /// What CoreBluetooth would do now: a running scan reports the Pendant in range, and a pending connect to it
        /// completes.
        private func reachIfPossible() {
            guard availability == .poweredOn, inRange, !connected else { return }
            if isScanning { continuation.yield(.discovered(DiscoveredPendant(id: id, name: "Pendant"))) }
            if pendingConnect { linkUp() }
        }

        private func linkUp() {
            connected = true
            pendingConnect = false
            connectionCount += 1
            continuation.yield(.linkUp(id))
            // Service discovery reads the standard battery level (0x2A19), as `CoreBluetoothTransport` does.
            readBattery()
            guard !withholdsReady else { return }
            continuation.yield(needsPairing ? .pairingRequired(id) : .ready(id, .limitless))
        }

        private func linkLost(_ reason: String) {
            connected = false
            downloading = false
            streaming?.cancel()
            continuation.yield(.disconnected(id, .linkLost(reason)))
        }

        private func mutate(_ index: UInt64, _ change: (inout Page) -> Void) {
            guard let position = flash.firstIndex(where: { $0.index == index }) else { return }
            change(&flash[position])
        }
    }
#endif
