import CryptoKit
import Foundation
import Timeline

public enum SourceStoreError: Error, Equatable {
    /// The database was written by a newer app. Fail closed rather than open an empty library.
    case unknownSchemaVersion(Int)
    /// Pack files exist but the receipt database is missing or empty. Fail closed.
    case missingDatabase
    case indexOutOfRange(UInt64)
    case checksumMismatch(PageKey)
    case io(errno: Int32)
    case sqlite(code: Int32, message: String)
    /// A recording change written by a newer app. Fail closed.
    case unknownRecordingChange(String)
    case unknownIncident(Int64)
    /// That choice doesn't apply to that kind of incident.
    case resolutionNotAllowed
}

public struct StoredPage: Sendable, Equatable {
    public var key: PageKey
    /// Store order per device: every receipt write (store, repair, kept replay) takes the next number, so a reader
    /// can follow new and rewritten pages whatever their index.
    public var seq: Int64
    public var session: Int64
    public var deviceTimeMillis: Int64
    public var receivedAt: Date
    public var payload: Data
}

/// Every open incident but `unreadablePage` blocks ACK at its index. Only a matching replay (`repaired`) or the owner
/// closes one.
public enum IncidentKind: String, Sendable {
    /// The Pendant reported a page unreadable or corrupt. Its audio is lost; the page is already a recorded gap with
    /// the raw envelope as evidence, so it never blocks ACK. Open until the owner has seen it (`gap`), so a lost page
    /// is never silent. (Before held pages, pages we couldn't decode were recorded this way too.)
    case unreadablePage
    /// A replayed key arrived with a different device time or payload. The owner picks the copy to keep.
    case replayConflict
    /// Stored bytes no longer match their receipt, until a replay repairs them.
    case checksumMismatch
    /// Audio we can't decrypt. Kept on the Pendant until the owner accepts it as a gap.
    case encryptedAudio
    /// A page we can't decode. Kept on the Pendant until the owner accepts it as a gap, or the page arrives readable
    /// (`repaired`).
    case undecodablePage
}

public enum IncidentResolution: String, Sendable {
    /// A replay matching the receipt's hash replaced rotted stored bytes, or a page held as undecodable arrived
    /// readable and was stored. Automatic.
    case repaired
    /// Owner, replay conflict: the stored page stays; the replay's bytes stay as the incident's evidence.
    case storedCopy
    /// Owner, replay conflict: the replay becomes the stored page; the old bytes become the incident's evidence.
    case replayCopy
    /// Owner, held page (encrypted or undecodable): recorded as a gap with the page as evidence, so ACK may pass it.
    /// Owner, unreadable page: seen; it stays a gap.
    case gap
}

public struct Incident: Sendable, Equatable {
    public var id: Int64
    public var kind: IncidentKind
    public var key: PageKey
    public var detail: String
    /// The copy that isn't the stored page: a conflicting replay, the replaced original, or encrypted bytes.
    public var evidence: Data?
    public var recordedAt: Date
    public var resolution: IncidentResolution?
}

public struct SessionStats: Sendable, Equatable {
    public var deviceID: String
    public var session: Int64
    public var pageCount: Int
    public var payloadBytes: Int64
    /// Plausible device capture times only (after 2020-01-01); `nil` when the session has none.
    public var oldestDeviceTimeMillis: Int64?
    public var newestDeviceTimeMillis: Int64?
}

public struct StorageStats: Sendable, Equatable {
    /// Everything the store occupies on disk: packs plus the database and its WAL.
    public var totalBytes: Int64
    public var sessions: [SessionStats]
    public var gapCountByDevice: [String: Int]
}

/// The raw source store: append-only pack files for page bytes, SQLite receipts for what is durable.
///
/// A page is durable once its bytes are `F_FULLFSYNC`ed in a pack and its receipt is committed (WAL,
/// `synchronous=FULL`, `fullfsync=ON`). Bytes past the last receipt in a pack are an orphan tail from a crash
/// and are truncated on open; the page was never ACKed, so the Pendant sends it again.
public actor SourceStore: PageSink {
    public nonisolated let directory: URL
    let db: SQLite
    private let packsURL: URL
    private var current: Pack?
    /// Test seam: `false` skips the disk flushes that make a write durable, for tests of logic rather than crashes.
    private let flushes: Bool
    /// Test seam: stands in for an error SQLite reports after the receipt's COMMIT is already durable.
    var afterReceiptCommit: () throws -> Void = {}

    private struct Pack {
        let id: Int64
        let handle: FileHandle
        var size: UInt64
    }

    // ponytail: one global append stream, rolled at 64 MB. Split per device/day if retention needs it.
    static let packLimit: UInt64 = 64 << 20

    /// - Parameter fileProtection: applied to the store directories so new files inherit it. On iOS pass
    ///   `.completeUntilFirstUserAuthentication` so background BLE sync can write while the phone is locked.
    public init(directory: URL, fileProtection: FileProtectionType? = nil) throws {
        try self.init(directory: directory, fileProtection: fileProtection, flushes: true)
    }

    init(directory: URL, fileProtection: FileProtectionType? = nil, flushes: Bool) throws {
        let packsURL = directory.appending(path: "packs", directoryHint: .isDirectory)
        let files = FileManager.default
        try files.createDirectory(at: packsURL, withIntermediateDirectories: true)
        if let fileProtection {
            for url in [directory, packsURL] {
                try files.setAttributes([.protectionKey: fileProtection], ofItemAtPath: url.path)
            }
        }
        try Self.syncDirectory(directory)
        let db = try SQLite(path: directory.appending(path: "source.sqlite").path)
        let packIDs = try files.contentsOfDirectory(atPath: packsURL.path).compactMap { name in
            name.hasSuffix(".pack") ? Int64(name.dropLast(5)) : nil
        }
        try Self.migrate(db, hasPacks: !packIDs.isEmpty)
        if !flushes { try db.execute("PRAGMA synchronous = OFF; PRAGMA fullfsync = OFF;") }
        try db.run("UPDATE jobs SET state = 'pending' WHERE state = 'running'")
        current = try Self.recoverPacks(packIDs.sorted(), in: packsURL, db: db)
        self.directory = directory
        self.packsURL = packsURL
        self.db = db
        self.flushes = flushes
    }

    // MARK: PageSink

    public func persist(_ page: RawPage) throws -> PersistOutcome {
        let key = try Self.values(page.key)
        let digest = Data(SHA256.hash(data: page.payload))
        guard let receipt = try receipt(key) else {
            try append(page.payload) { pack, offset in
                try db.run(
                    """
                    INSERT INTO receipts (device_id, page_index, session, device_time_ms, pack_id, pack_offset,
                        length, sha256, received_at, seq)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \(Self.nextSeq))
                    """,
                    key + [
                        .int(page.session), .int(page.deviceTimeMillis), .int(pack), .int(Int64(offset)),
                        .int(Int64(page.payload.count)), .blob(digest), .real(page.receivedAt.timeIntervalSince1970),
                    ]
                )
                // A page held as undecodable came back readable (a newer app, or a clean re-send): it's stored now.
                _ = try resolveIncidents(.undecodablePage, key, as: .repaired)
                try enqueueJob(key)
            }
            return .stored
        }
        guard receipt.time == page.deviceTimeMillis, receipt.sha256 == digest else {
            // A copy the owner already resolved is known evidence, not a new conflict.
            let resolved = try db.query(
                """
                SELECT resolved_at IS NOT NULL FROM incidents
                WHERE device_id = ?1 AND page_index = ?2 AND kind = 'replayConflict' AND evidence = ?3
                """, key + [.blob(page.payload)]
            ) { $0.int(0) != 0 }
            if resolved.isEmpty {
                let detail =
                    "stored device time \(receipt.time), replay device time \(page.deviceTimeMillis), session \(page.session)"
                try recordIncident(.replayConflict, key, detail: detail, evidence: page.payload, copyOf: page)
            }
            guard resolved.contains(true) else {
                return receipt.time == page.deviceTimeMillis ? .conflict : .indexReused
            }
            guard try verifies(receipt) else {
                try recordIncident(.checksumMismatch, key, detail: "pack \(receipt.pack) offset \(receipt.offset)")
                return .conflict
            }
            return .duplicate
        }
        if try verifies(receipt) { return .duplicate }
        // The stored copy rotted. The replay matches the receipt's hash, so it becomes the stored copy.
        try append(page.payload) { pack, offset in
            try db.run(
                """
                UPDATE receipts SET pack_id = ?3, pack_offset = ?4, seq = \(Self.nextSeq)
                WHERE device_id = ?1 AND page_index = ?2
                """,
                key + [.int(pack), .int(Int64(offset))])
            if try resolveIncidents(.checksumMismatch, key, as: .repaired) == 0 {
                let detail = "pack \(receipt.pack) offset \(receipt.offset), repaired from a replay"
                try recordIncident(.checksumMismatch, key, detail: detail, resolution: .repaired)
            }
            try enqueueJob(key)
        }
        return .stored
    }

    public func flashLife(deviceID: String, evidence: String?) throws -> FlashLife {
        let latest = try latestLife(deviceID)
        if let latest, evidence == nil || evidence == latest.evidence { return FlashLife(number: latest.number) }
        let reason = latest == nil ? "first use" : "the Pendant's identity or flash generation changed"
        return try startLife(deviceID, number: (latest?.number ?? 0) + 1, evidence: evidence, reason: reason)
    }

    public func startNewFlashLife(deviceID: String, reason: String) throws -> FlashLife {
        let latest = try latestLife(deviceID)
        return try startLife(deviceID, number: (latest?.number ?? 0) + 1, evidence: latest?.evidence, reason: reason)
    }

    /// A new gap also opens an `unreadablePage` incident, once: replays of the same page add nothing. A page already
    /// stored records nothing and returns `false`: the Pendant re-sent a page it can no longer read (one it already
    /// cleared after its ACK), and the saved copy is the audio.
    @discardableResult
    public func recordGap(_ key: PageKey, reason: GapReason, evidence: Data) throws -> Bool {
        let values = try Self.values(key)
        return try db.transaction {
            guard try receipt(values) == nil else { return false }
            let known = try db.query("SELECT 1 FROM gaps WHERE device_id = ?1 AND page_index = ?2", values) { _ in true
            }
            guard known.isEmpty else { return true }
            try insertGap(values, reason: reason, evidence: evidence)
            try recordIncident(.unreadablePage, values, detail: reason.detail, evidence: evidence)
            return true
        }
    }

    public func recordHeld(_ key: PageKey, reason: HeldReason, evidence: Data) throws -> Bool {
        let values = try Self.values(key)
        let match = values + [.blob(evidence)]
        let accepted = try db.query(
            "SELECT 1 FROM gaps WHERE device_id = ?1 AND page_index = ?2 AND evidence = ?3", match
        ) { _ in true }
        guard accepted.isEmpty else { return true }
        let (kind, detail): (IncidentKind, String) =
            switch reason {
            case .encrypted: (.encryptedAudio, "encrypted")
            case .undecodable(let detail): (.undecodablePage, detail)
            }
        let known = try db.query(
            "SELECT 1 FROM incidents WHERE device_id = ?1 AND page_index = ?2 AND kind = ?3 AND evidence = ?4",
            values + [.text(kind.rawValue), .blob(evidence)]
        ) { _ in true }
        if known.isEmpty { try recordIncident(kind, values, detail: detail, evidence: evidence) }
        return false
    }

    public func ackableIndex(deviceID: String, startingAt oldest: UInt64) throws -> UInt64? {
        try run(
            from: oldest, deviceID: deviceID,
            stop: """
                SELECT MIN(page_index) FROM incidents
                WHERE device_id = ?1 AND page_index >= ?2 AND resolved_at IS NULL AND kind != 'unreadablePage'
                """)
    }

    public func savedIndex(deviceID: String, startingAt oldest: UInt64) throws -> UInt64? {
        try run(
            from: oldest, deviceID: deviceID,
            held: """
                UNION SELECT page_index FROM incidents WHERE device_id = ?1 AND page_index >= ?2
                AND resolved_at IS NULL AND kind IN ('encryptedAudio', 'undecodablePage')
                """)
    }

    public func newestIndex(deviceID: String, in life: FlashLife) throws -> UInt64? {
        let band: [SQLValue] = [.text(deviceID), .int(Int64(life.base)), .int(Int64(life.base + (1 << 40)))]
        let newest = try db.query(
            """
            SELECT MAX(i) FROM (
                SELECT page_index AS i FROM receipts WHERE device_id = ?1 AND page_index >= ?2 AND page_index < ?3
                UNION ALL SELECT page_index FROM gaps WHERE device_id = ?1 AND page_index >= ?2 AND page_index < ?3
            )
            """, band
        ) { $0.isNull(0) ? nil : UInt64($0.int(0)) }
        return newest.first ?? nil
    }

    /// The end of the contiguous run of stored or gapped indices (`held`: and the rows it adds) from `oldest`,
    /// below the index `stop` selects.
    private func run(from oldest: UInt64, deviceID: String, held: String = "", stop: String = "SELECT NULL") throws
        -> UInt64?
    {
        // Indices in a contiguous run starting at `oldest` satisfy index - rank == oldest.
        let end = try db.query(
            """
            WITH known AS (
                SELECT page_index AS i FROM receipts WHERE device_id = ?1 AND page_index >= ?2
                UNION SELECT page_index FROM gaps WHERE device_id = ?1 AND page_index >= ?2
                \(held)
            ), ranked AS (
                SELECT i, i - ROW_NUMBER() OVER (ORDER BY i) + 1 AS start FROM known
            )
            SELECT MAX(i) FROM ranked
            WHERE start = ?2 AND i < COALESCE((\(stop)), 9223372036854775807)
            """,
            try Self.values(PageKey(deviceID: deviceID, index: oldest))
        ) { $0.isNull(0) ? nil : UInt64($0.int(0)) }
        return end.first ?? nil
    }

    /// A later sync recorded at the same first page replaces the earlier one: it governs the pages that follow.
    public func recordClockSync(_ sync: ClockSync, deviceID: String) throws {
        guard let first = Int64(exactly: sync.firstPageIndex) else {
            throw SourceStoreError.indexOutOfRange(sync.firstPageIndex)
        }
        try db.run(
            """
            INSERT OR REPLACE INTO clock_syncs (device_id, first_page_index, phone_ms, device_ms_before_set)
            VALUES (?1, ?2, ?3, ?4)
            """,
            [
                .text(deviceID), .int(first), .int(sync.phoneMillis),
                sync.deviceMillisBeforeSet.map(SQLValue.int) ?? .null,
            ]
        )
    }

    public func recordRecordingChange(_ change: RecordingChange, deviceID: String) throws {
        try db.run(
            "INSERT OR IGNORE INTO recording_changes (device_id, at_ms, kind) VALUES (?1, ?2, ?3)",
            [.text(deviceID), .int(change.at.millis), .text(change.kind.rawValue)])
    }

    public func recordBatteryReading(_ reading: BatteryReading, deviceID: String) throws {
        try db.run(
            "INSERT OR REPLACE INTO battery_readings (device_id, at_ms, percent, state) VALUES (?1, ?2, ?3, ?4)",
            [
                .text(deviceID), .int(Int64((reading.at.timeIntervalSince1970 * 1000).rounded())),
                .int(Int64(reading.percent)), .text(reading.state.rawValue),
            ])
    }

    // MARK: Reading

    /// Oldest first. A state written by a newer app reads as unobserved, which learns nothing.
    public func batteryReadings(deviceID: String, since: Date) throws -> [BatteryReading] {
        try db.query(
            "SELECT at_ms, percent, state FROM battery_readings WHERE device_id = ?1 AND at_ms >= ?2 ORDER BY at_ms",
            [.text(deviceID), .int(Int64(since.timeIntervalSince1970 * 1000))]
        ) {
            BatteryReading(
                at: Date(timeIntervalSince1970: Double($0.int(0)) / 1000), percent: Int($0.int(1)),
                state: BatteryReading.State(rawValue: $0.text(2)) ?? .unobserved)
        }
    }

    public func recordingChanges(deviceID: String) throws -> [RecordingChange] {
        try db.query(
            "SELECT kind, at_ms FROM recording_changes WHERE device_id = ?1 ORDER BY at_ms", [.text(deviceID)]
        ) { row in
            guard let kind = RecordingChange.Kind(rawValue: row.text(0)) else {
                throw SourceStoreError.unknownRecordingChange(row.text(0))
            }
            return RecordingChange(kind, at: CaptureInstant(millis: row.int(1)))
        }
    }

    public func clockSyncs(deviceID: String) throws -> [ClockSync] {
        try db.query(
            """
            SELECT first_page_index, phone_ms, device_ms_before_set FROM clock_syncs
            WHERE device_id = ?1 ORDER BY first_page_index
            """,
            [.text(deviceID)]
        ) {
            ClockSync(
                firstPageIndex: UInt64($0.int(0)), phoneMillis: $0.int(1),
                deviceMillisBeforeSet: $0.isNull(2) ? nil : $0.int(2))
        }
    }

    /// Indices the device reported unreadable, recorded so ACK could pass them. Their audio is lost for good,
    /// unlike indices simply not received yet.
    public func gaps(deviceID: String) throws -> [UInt64: GapReason] {
        let rows = try db.query("SELECT page_index, reason FROM gaps WHERE device_id = ?1", [.text(deviceID)]) {
            (UInt64($0.int(0)), try JSONDecoder().decode(GapReason.self, from: Data($0.text(1).utf8)))
        }
        return Dictionary(rows, uniquingKeysWith: { first, _ in first })
    }

    /// The stored page for `key`, checksum-verified. Throws `checksumMismatch` (and records an incident) on rot.
    public func page(_ key: PageKey) throws -> StoredPage? {
        try readPages("WHERE device_id = ?1 AND page_index = ?2", try Self.values(key)).first
    }

    /// Stored pages of one device in index order, starting at `index`. Gaps are simply absent.
    public func pages(deviceID: String, from index: UInt64, limit: Int) throws -> [StoredPage] {
        try readPages(
            "WHERE device_id = ?1 AND page_index >= ?2 ORDER BY page_index LIMIT ?3",
            try Self.values(PageKey(deviceID: deviceID, index: index)) + [.int(Int64(limit))]
        )
    }

    /// The newest `limit` stored pages of one device, in index order.
    public func newestPages(deviceID: String, limit: Int) throws -> [StoredPage] {
        try readPages(
            "WHERE device_id = ?1 ORDER BY page_index DESC LIMIT ?2", [.text(deviceID), .int(Int64(limit))]
        ).reversed()
    }

    /// Stored pages of one device in store order (`StoredPage.seq`), after `seq`.
    public func pages(deviceID: String, afterSeq seq: Int64, limit: Int) throws -> [StoredPage] {
        try readPages(
            "WHERE device_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3", [.text(deviceID), .int(seq), .int(Int64(limit))])
    }

    public func incidents() throws -> [Incident] {
        try db.query(
            "SELECT id, kind, device_id, page_index, detail, evidence, recorded_at, resolution FROM incidents ORDER BY id"
        ) {
            Incident(
                id: $0.int(0),
                kind: IncidentKind(rawValue: $0.text(1)) ?? .checksumMismatch,
                key: PageKey(deviceID: $0.text(2), index: UInt64($0.int(3))),
                detail: $0.text(4),
                evidence: $0.isNull(5) ? nil : $0.blob(5),
                recordedAt: Date(timeIntervalSince1970: $0.real(6)),
                resolution: $0.isNull(7) ? nil : IncidentResolution(rawValue: $0.text(7))
            )
        }
    }

    /// The owner's decision on an open incident; never called automatically. Both copies stay on disk: the one
    /// not kept becomes the incident's evidence. Once resolved, the incident no longer blocks ACK.
    public func resolveIncident(_ id: Int64, keeping resolution: IncidentResolution) throws {
        guard
            let incident = try db.query(
                """
                SELECT kind, device_id, page_index, evidence, session, device_time_ms, resolved_at IS NOT NULL, detail
                FROM incidents WHERE id = ?1
                """, [.int(id)],
                row: {
                    (
                        kind: IncidentKind(rawValue: $0.text(0)), key: [SQLValue.text($0.text(1)), .int($0.int(2))],
                        evidence: $0.blob(3), session: $0.int(4), time: $0.int(5), resolved: $0.int(6) != 0,
                        detail: $0.text(7)
                    )
                }
            ).first
        else { throw SourceStoreError.unknownIncident(id) }
        guard !incident.resolved else { return }
        switch (incident.kind, resolution) {
        case (.replayConflict, .storedCopy):
            try closeIncident(id, as: resolution)
        case (.replayConflict, .replayCopy):
            guard let stored = try receipt(incident.key) else { throw SourceStoreError.unknownIncident(id) }
            let original = try read(pack: stored.pack, offset: stored.offset, length: stored.length)
            try append(incident.evidence) { pack, offset in
                try db.run(
                    """
                    UPDATE receipts SET session = ?3, device_time_ms = ?4, pack_id = ?5, pack_offset = ?6, length = ?7,
                        sha256 = ?8, seq = \(Self.nextSeq)
                    WHERE device_id = ?1 AND page_index = ?2
                    """,
                    incident.key + [
                        .int(incident.session), .int(incident.time), .int(pack), .int(Int64(offset)),
                        .int(Int64(incident.evidence.count)), .blob(Data(SHA256.hash(data: incident.evidence))),
                    ])
                try db.run(
                    "UPDATE incidents SET evidence = ?2, session = ?3, device_time_ms = ?4 WHERE id = ?1",
                    [.int(id), .blob(original), .int(stored.session), .int(stored.time)])
                try closeIncident(id, as: resolution)
                try enqueueJob(incident.key)
            }
        case (.unreadablePage, .gap):
            try closeIncident(id, as: resolution)
        case (.encryptedAudio, .gap), (.undecodablePage, .gap):
            let held: HeldReason = incident.kind == .encryptedAudio ? .encrypted : .undecodable(detail: incident.detail)
            try db.transaction {
                try insertGap(incident.key, reason: held.gap, evidence: incident.evidence)
                try closeIncident(id, as: resolution)
            }
        default:
            throw SourceStoreError.resolutionNotAllowed
        }
    }

    // MARK: Storage accounting

    public func storageStats() throws -> StorageStats {
        let sessions = try db.query(
            """
            SELECT device_id, session, COUNT(*), SUM(length),
                MIN(CASE WHEN device_time_ms > 1577836800000 THEN device_time_ms END),
                MAX(CASE WHEN device_time_ms > 1577836800000 THEN device_time_ms END)
            FROM receipts GROUP BY device_id, session ORDER BY device_id, session
            """
        ) {
            SessionStats(
                deviceID: $0.text(0), session: $0.int(1), pageCount: Int($0.int(2)), payloadBytes: $0.int(3),
                oldestDeviceTimeMillis: $0.isNull(4) ? nil : $0.int(4),
                newestDeviceTimeMillis: $0.isNull(5) ? nil : $0.int(5)
            )
        }
        let gaps = try db.query("SELECT device_id, COUNT(*) FROM gaps GROUP BY device_id") {
            ($0.text(0), Int($0.int(1)))
        }
        var total: Int64 = 0
        for case let url as URL in FileManager.default.enumerator(
            at: directory, includingPropertiesForKeys: [.fileSizeKey])
            ?? FileManager.DirectoryEnumerator()
        {
            total += Int64(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
        }
        return StorageStats(
            totalBytes: total, sessions: sessions, gapCountByDevice: Dictionary(uniqueKeysWithValues: gaps))
    }

    /// Free space the system would make available for important data on the store's volume.
    public nonisolated func availableCapacity() throws -> Int64? {
        try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage
    }

    // MARK: Internals

    private func readPages(_ clause: String, _ values: [SQLValue]) throws -> [StoredPage] {
        let receipts = try db.query(
            "SELECT device_id, page_index, session, device_time_ms, received_at, pack_id, pack_offset, length, sha256, seq "
                + "FROM receipts " + clause,
            values
        ) { row in
            (
                page: StoredPage(
                    key: PageKey(deviceID: row.text(0), index: UInt64(row.int(1))), seq: row.int(9),
                    session: row.int(2),
                    deviceTimeMillis: row.int(3), receivedAt: Date(timeIntervalSince1970: row.real(4)),
                    payload: Data()),
                pack: row.int(5), offset: UInt64(row.int(6)), length: Int(row.int(7)), sha256: row.blob(8)
            )
        }
        return try receipts.map { receipt in
            var page = receipt.page
            page.payload = try read(pack: receipt.pack, offset: receipt.offset, length: receipt.length)
            guard Data(SHA256.hash(data: page.payload)) == receipt.sha256 else {
                try recordIncident(.checksumMismatch, try Self.values(page.key), detail: "pack \(receipt.pack)")
                throw SourceStoreError.checksumMismatch(page.key)
            }
            return page
        }
    }

    private func latestLife(_ deviceID: String) throws -> (number: Int64, evidence: String?)? {
        try db.query(
            "SELECT life, evidence FROM flash_lives WHERE device_id = ?1 ORDER BY life DESC LIMIT 1", [.text(deviceID)]
        ) { ($0.int(0), $0.isNull(1) ? nil : $0.text(1)) }.first
    }

    private func startLife(_ deviceID: String, number: Int64, evidence: String?, reason: String) throws -> FlashLife {
        try db.run(
            "INSERT INTO flash_lives (device_id, life, evidence, reason, started_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            [
                .text(deviceID), .int(number), evidence.map(SQLValue.text) ?? .null, .text(reason),
                .real(Date.now.timeIntervalSince1970),
            ])
        return FlashLife(number: number)
    }

    private struct Receipt {
        var session: Int64
        var time: Int64
        var sha256: Data
        var pack: Int64
        var offset: UInt64
        var length: Int
    }

    private func receipt(_ key: [SQLValue]) throws -> Receipt? {
        try db.query(
            """
            SELECT session, device_time_ms, sha256, pack_id, pack_offset, length FROM receipts
            WHERE device_id = ?1 AND page_index = ?2
            """, key
        ) {
            Receipt(
                session: $0.int(0), time: $0.int(1), sha256: $0.blob(2), pack: $0.int(3), offset: UInt64($0.int(4)),
                length: Int($0.int(5)))
        }.first
    }

    /// Whether the stored bytes still match the receipt's hash.
    private func verifies(_ receipt: Receipt) throws -> Bool {
        let bytes = try read(pack: receipt.pack, offset: receipt.offset, length: receipt.length)
        return Data(SHA256.hash(data: bytes)) == receipt.sha256
    }

    private func insertGap(_ key: [SQLValue], reason: GapReason, evidence: Data) throws {
        let reasonJSON = String(decoding: try JSONEncoder().encode(reason), as: UTF8.self)
        // ponytail: first evidence wins; a later gap report for the same index is dropped.
        try db.run(
            """
            INSERT OR IGNORE INTO gaps (device_id, page_index, reason, evidence, recorded_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            """,
            key + [.text(reasonJSON), .blob(evidence), .real(Date.now.timeIntervalSince1970)]
        )
    }

    /// `copyOf` keeps the device time and session of the copy in `evidence`, so the owner can make it the stored page.
    private func recordIncident(
        _ kind: IncidentKind, _ key: [SQLValue], detail: String, evidence: Data? = nil, copyOf page: RawPage? = nil,
        resolution: IncidentResolution? = nil
    ) throws {
        let now = Date.now.timeIntervalSince1970
        try db.run(
            """
            INSERT INTO incidents (kind, device_id, page_index, detail, evidence, recorded_at, resolution, resolved_at,
                session, device_time_ms)
            VALUES (?3, ?1, ?2, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            """,
            key + [
                .text(kind.rawValue), .text(detail), evidence.map(SQLValue.blob) ?? .null, .real(now),
                resolution.map { .text($0.rawValue) } ?? .null, resolution == nil ? .null : .real(now),
                page.map { .int($0.session) } ?? .null, page.map { .int($0.deviceTimeMillis) } ?? .null,
            ]
        )
    }

    private func closeIncident(_ id: Int64, as resolution: IncidentResolution) throws {
        try db.run(
            "UPDATE incidents SET resolution = ?2, resolved_at = ?3 WHERE id = ?1",
            [.int(id), .text(resolution.rawValue), .real(Date.now.timeIntervalSince1970)])
    }

    /// Marks every open incident of `kind` at `key` resolved. Returns how many there were.
    private func resolveIncidents(_ kind: IncidentKind, _ key: [SQLValue], as resolution: IncidentResolution) throws
        -> Int
    {
        try db.run(
            """
            UPDATE incidents SET resolution = ?4, resolved_at = ?5
            WHERE device_id = ?1 AND page_index = ?2 AND kind = ?3 AND resolved_at IS NULL
            """,
            key + [.text(kind.rawValue), .text(resolution.rawValue), .real(Date.now.timeIntervalSince1970)])
    }

    /// Appends `payload` to a pack, fsyncs it, then runs `commit` with its pack id and offset in one transaction.
    private func append(_ payload: Data, commit: (_ pack: Int64, _ offset: UInt64) throws -> Void) throws {
        let pack = try writablePack(for: payload.count)
        try pack.handle.seek(toOffset: pack.size)
        try pack.handle.write(contentsOf: payload)
        if flushes { try Self.fullSync(pack.handle.fileDescriptor) }
        // From here the bytes are never overwritten or cut: a COMMIT can report an error after its WAL frame is
        // durable, so a committed receipt may point at them. If none does, reopening trims them when they are the
        // pack's tail; otherwise they stay as a few dead bytes.
        current?.size += UInt64(payload.count)
        try db.transaction { try commit(pack.id, pack.size) }
        try afterReceiptCommit()
    }

    private func read(pack: Int64, offset: UInt64, length: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: packURL(pack))
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        return try handle.read(upToCount: length) ?? Data()
    }

    private func writablePack(for count: Int) throws -> Pack {
        if let current, current.size == 0 || current.size + UInt64(count) <= Self.packLimit { return current }
        let id = (current?.id ?? 0) + 1
        let fd = open(packURL(id).path, O_RDWR | O_CREAT | O_EXCL, 0o644)
        guard fd >= 0 else { throw SourceStoreError.io(errno: errno) }
        let pack = Pack(id: id, handle: FileHandle(fileDescriptor: fd, closeOnDealloc: true), size: 0)
        try Self.fullSync(fd)
        try Self.syncDirectory(packsURL)
        current = pack
        return pack
    }

    private func packURL(_ id: Int64) -> URL { packsURL.appending(path: "\(id).pack") }

    /// The device's next store order (`StoredPage.seq`), for a receipt write whose `?1` is the device id.
    private static let nextSeq = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM receipts WHERE device_id = ?1)"

    static func values(_ key: PageKey) throws -> [SQLValue] {
        guard let index = Int64(exactly: key.index) else { throw SourceStoreError.indexOutOfRange(key.index) }
        return [.text(key.deviceID), .int(index)]
    }

    private static func fullSync(_ fd: Int32) throws {
        guard fcntl(fd, F_FULLFSYNC) == 0 else { throw SourceStoreError.io(errno: errno) }
    }

    private static func syncDirectory(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else { throw SourceStoreError.io(errno: errno) }
        defer { close(fd) }
        try fullSync(fd)
    }

    /// Truncates every pack to its last receipted byte and returns the newest one for appending.
    private static func recoverPacks(_ ids: [Int64], in packsURL: URL, db: SQLite) throws -> Pack? {
        var newest: Pack?
        for id in ids {
            let end =
                try db.query(
                    "SELECT COALESCE(MAX(pack_offset + length), 0) FROM receipts WHERE pack_id = ?1", [.int(id)]
                ) { UInt64($0.int(0)) }.first ?? 0
            let handle = try FileHandle(forUpdating: packsURL.appending(path: "\(id).pack"))
            if try handle.seekToEnd() > end {
                try handle.truncate(atOffset: end)
                try fullSync(handle.fileDescriptor)
            }
            newest = Pack(id: id, handle: handle, size: end)
        }
        return newest
    }

    private static func migrate(_ db: SQLite, hasPacks: Bool) throws {
        guard try db.userVersion() > 0 || !hasPacks else { throw SourceStoreError.missingDatabase }
        try db.migrate(migrations, tooNew: SourceStoreError.unknownSchemaVersion)
    }

    /// Forward-only. Append a new entry for every schema change; never edit a shipped one.
    static let migrations = [
        """
        CREATE TABLE receipts (
            device_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            session INTEGER NOT NULL,
            device_time_ms INTEGER NOT NULL,
            pack_id INTEGER NOT NULL,
            pack_offset INTEGER NOT NULL,
            length INTEGER NOT NULL,
            sha256 BLOB NOT NULL,
            received_at REAL NOT NULL,
            PRIMARY KEY (device_id, page_index)
        ) WITHOUT ROWID;
        CREATE INDEX receipts_by_pack ON receipts (pack_id);
        CREATE TABLE gaps (
            device_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            reason TEXT NOT NULL,
            evidence BLOB NOT NULL,
            recorded_at REAL NOT NULL,
            PRIMARY KEY (device_id, page_index)
        ) WITHOUT ROWID;
        CREATE TABLE incidents (
            id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            device_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            detail TEXT NOT NULL,
            evidence BLOB,
            recorded_at REAL NOT NULL
        );
        CREATE INDEX incidents_by_page ON incidents (device_id, page_index);
        CREATE TABLE jobs (
            id INTEGER PRIMARY KEY,
            device_id TEXT NOT NULL,
            first_index INTEGER NOT NULL,
            last_index INTEGER NOT NULL,
            state TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            not_before REAL NOT NULL,
            last_error TEXT
        );
        CREATE INDEX jobs_by_state ON jobs (state, not_before);
        """,
        """
        CREATE TABLE clock_syncs (
            device_id TEXT NOT NULL,
            first_page_index INTEGER NOT NULL,
            phone_ms INTEGER NOT NULL,
            device_ms_before_set INTEGER,
            PRIMARY KEY (device_id, first_page_index)
        ) WITHOUT ROWID;
        """,
        """
        CREATE TABLE recording_changes (
            device_id TEXT NOT NULL,
            at_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            PRIMARY KEY (device_id, at_ms, kind)
        ) WITHOUT ROWID;
        """,
        """
        ALTER TABLE incidents ADD COLUMN resolution TEXT;
        ALTER TABLE incidents ADD COLUMN resolved_at REAL;
        ALTER TABLE incidents ADD COLUMN session INTEGER;
        ALTER TABLE incidents ADD COLUMN device_time_ms INTEGER;
        """,
        """
        CREATE TABLE flash_lives (
            device_id TEXT NOT NULL,
            life INTEGER NOT NULL,
            evidence TEXT,
            reason TEXT NOT NULL,
            started_at REAL NOT NULL,
            PRIMARY KEY (device_id, life)
        ) WITHOUT ROWID;
        """,
        """
        CREATE TABLE battery_readings (
            device_id TEXT NOT NULL,
            at_ms INTEGER NOT NULL,
            percent INTEGER NOT NULL,
            state TEXT NOT NULL,
            PRIMARY KEY (device_id, at_ms)
        ) WITHOUT ROWID;
        """,
        // Store order, so processing reads a page stored below a higher index. Existing receipts in index order.
        """
        ALTER TABLE receipts ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
        UPDATE receipts SET seq = ordered.n
        FROM (
            SELECT device_id, page_index, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY page_index) AS n
            FROM receipts
        ) AS ordered
        WHERE receipts.device_id = ordered.device_id AND receipts.page_index = ordered.page_index;
        CREATE UNIQUE INDEX receipts_by_seq ON receipts (device_id, seq);
        """,
    ]
}
