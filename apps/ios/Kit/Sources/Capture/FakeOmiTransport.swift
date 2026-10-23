// Debug only, like `FakePendantTransport`: compiled out of Release builds.
#if DEBUG
    import Foundation
    import PendantProtocol

    /// A simulated Omi that speaks the ring protocol of firmware 3.0.21 (`storage.c`): records split across
    /// notifications, a ring that overwrites its oldest records when full, links that drop mid-read, a clear that
    /// restarts the numbers, and either custody rule: free on delivery (3.0.21) or only on ADVANCE (the fix).
    public actor FakeOmiTransport: PendantTransport {
        public nonisolated let events: AsyncStream<TransportEvent>
        public nonisolated let id = UUID()
        private let continuation: AsyncStream<TransportEvent>.Continuation

        /// Records `read..<write`, by ring number.
        public private(set) var ring: [UInt64: Data] = [:]
        public private(set) var read: UInt64 = 0
        public private(set) var write: UInt64 = 0
        public private(set) var dropped: UInt64 = 0
        private let capacity: UInt64
        /// 3.0.21: a record the phone received is freed at once, stored or not.
        private let freesOnDelivery: Bool
        /// Notification payload size, below a record's: records arrive split across notifications anywhere.
        private let chunk = 180

        private var connected = false
        /// When the last recorded record was written, seconds since 1970.
        private var recordedUntil: Double = 0
        private var streaming: Task<Void, Never>?
        private var dropLinkAfterRecords: Int?

        /// Every ring command the phone wrote.
        public private(set) var commands: [OmiCommand] = []
        public private(set) var clockSets = 0
        public private(set) var connectionCount = 0

        public init(capacity: UInt64 = 10_000, freesOnDelivery: Bool = true) {
            self.capacity = capacity
            self.freesOnDelivery = freesOnDelivery
            (events, continuation) = AsyncStream.makeStream()
        }

        // MARK: Scenario controls

        /// Records `count` records of five 20 ms frames each, 100 ms apart, stamped like the firmware: the second each
        /// was written. They end now, or follow the last ones if those would end later, so a record never shares its
        /// time with an older one. A full ring overwrites its oldest records and counts them dropped.
        public func record(_ count: Int) {
            let start = max(recordedUntil, Date().timeIntervalSince1970 - Double(count) * 0.1)
            recordedUntil = start + Double(count) * 0.1
            for offset in 0..<count {
                let stamp = UInt32(start + Double(offset + 1) * 0.1)
                let frames = (0..<5).map { _ in
                    Data([0xB8] + [UInt8](repeating: UInt8(truncatingIfNeeded: write &+ dropped), count: 79))
                }
                ring[write] = OmiRecord.encode(timestampSeconds: stamp, frames: frames)
                write += 1
                if write - read > capacity {
                    ring[read] = nil
                    read += 1
                    dropped += 1
                }
            }
        }

        /// Another app (the Omi app) read everything so far: on 3.0.21 that frees it.
        public func drainedByAnotherApp() { free(below: write) }

        /// Another app cleared the ring: its numbers restart at 0.
        public func clear() {
            ring = [:]
            (read, write, dropped) = (0, 0, 0)
        }

        public func dropLink(afterSendingRecords count: Int?) { dropLinkAfterRecords = count }

        // MARK: PendantTransport

        public func start() { continuation.yield(.availability(.poweredOn)) }

        public func scan() {
            if !connected { continuation.yield(.discovered(DiscoveredPendant(id: id, name: "Omi"))) }
        }

        public func stopScan() {}

        public func connect(_ peripheral: UUID) {
            guard peripheral == id, !connected else { return }
            linkUp()
        }

        public func disconnect() {
            guard connected else { return }
            endRead()
            connected = false
            continuation.yield(.disconnected(id, .cancelled))
        }

        public func readBattery() {
            if connected { continuation.yield(.batteryLevel(64)) }
        }

        public func write(_ bytes: Data, to target: WriteTarget) async throws(TransportError) {
            guard connected else { throw .notReady }
            if target == .clock {
                guard bytes.count == 4 else { throw .writeFailed("clock") }
                clockSets += 1
                return
            }
            guard let command = try? OmiCommand(decoding: bytes) else { throw .writeFailed("undecodable command") }
            commands.append(command)
            switch command {
            case .info:
                notify(.info(OmiRingInfo(read: read, write: write, capacity: UInt32(capacity), dropped: dropped)))
            case .read(let start):
                guard start >= read, start <= write else { return notify(.ack(status: 10)) }
                streaming?.cancel()
                streaming = Task { await stream(from: start) }
            case .advance(let to):
                guard to >= read, to <= write else { return notify(.ack(status: 10)) }
                free(below: to)
                notify(.ack(status: 0))
            case .stop:
                endRead()
            }
        }

        // MARK: Firmware

        private func stream(from start: UInt64) async {
            let end = write
            notify(.readBegin(start: start, count: UInt32(end - start)))
            var bytes = Data()
            for seq in start..<end { bytes.append(ring[seq] ?? Data(count: OmiRecord.size)) }
            var sent = 0
            while sent < bytes.count {
                guard !Task.isCancelled, connected else { return }
                let next = min(sent + chunk, bytes.count)
                notify(.data(Data(bytes[sent..<next])))
                sent = next
                let delivered = start + UInt64(sent / OmiRecord.size)
                if freesOnDelivery { free(below: delivered) }
                if let limit = dropLinkAfterRecords, delivered - start >= limit {
                    dropLinkAfterRecords = nil
                    return linkLost("dropped mid-read")
                }
                await Task.yield()
            }
            notify(.done(status: 0, next: end))
        }

        private func free(below seq: UInt64) {
            guard seq > read else { return }
            for freed in read..<seq { ring[freed] = nil }
            read = seq
        }

        private func endRead() {
            streaming?.cancel()
            streaming = nil
        }

        private func notify(_ notification: OmiNotification) {
            if connected { continuation.yield(.notification(notification.encoded)) }
        }

        private func linkUp() {
            connected = true
            connectionCount += 1
            continuation.yield(.linkUp(id))
            continuation.yield(.firmwareRevision("3.0.21"))
            continuation.yield(.ready(id, .omi))
        }

        private func linkLost(_ reason: String) {
            endRead()
            connected = false
            continuation.yield(.disconnected(id, .linkLost(reason)))
        }
    }
#endif
