import AudioPipeline
import Foundation
import Library
import SourceStore
import Timeline

/// An upload part of the old phone pipeline, as its `parts` table kept it, read once more by the backup of its job's
/// audio (`Uploader.backUp`): the job it became, the kept capture
/// intervals its audio was rendered from, that audio's hash and the job's last known state.
public struct PartRecord: Sendable, Equatable, Codable {
    public var conversation: ConversationID
    public var segments: [Range<CaptureInstant>]
    public var jobID: UUID?
    /// The prepared Ogg Opus's SHA-256 (hex), the job's `audioSha256`.
    public var sha256: String?
    /// The old pipeline's `PartState` (`completed`, `failed`, …).
    public var state: String?

    public init(
        conversation: ConversationID, segments: [Range<CaptureInstant>], jobID: UUID?, sha256: String? = nil,
        state: String? = nil
    ) {
        self.conversation = conversation
        self.segments = segments
        self.jobID = jobID
        self.sha256 = sha256
        self.state = state
    }
}

/// `timeline.sqlite`: `TimelineScanner`'s scanned-pages cache (`pages`, `scans`), the spans, clock and sidecar index it
/// builds from it, and its state (`scan_state`). The old pipeline's `parts` are read once more by the backup of old
/// jobs' audio.
final class TimelineStore {
    private let db: SQLite
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// `derived` and `deviceID`: the sidecars the migration that stopped listing them indexes once.
    init(file: URL, derived: DerivedAudioDirectory, deviceID: String) throws {
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        db = try SQLite(path: file.path)
        try db.execute("PRAGMA busy_timeout = 5000;")
        try db.migrate(
            Self.migrations, tooNew: TimelineStoreError.unknownSchemaVersion,
            steps: [Self.listingDropped: { try self.indexUnlisted(derived, deviceID: deviceID) }])
    }

    /// Oct 15: the scanner stopped listing the derived directory; the worker hands it each sidecar instead. A sidecar an
    /// older build wrote but its scanner never listed (a run cut between the two) has a finished job, so nothing would
    /// hand it: the migration that drops the listing's date mark lists the directory once and indexes what is missing.
    /// An unreadable sidecar is left out, as its job left it.
    private func indexUnlisted(_ derived: DerivedAudioDirectory, deviceID: String) throws {
        let known = Set(
            try db.query("SELECT name FROM sidecars WHERE device_id = ?1", [.text(deviceID)]) { $0.text(0) })
        let missing = try derived.sidecarFiles(deviceID: deviceID).map(\.name).filter { !known.contains($0) }
        try indexRows(
            missing.compactMap { name in (try? derived.segment(deviceID: deviceID, named: name)).map { (name, $0) } },
            deviceID: deviceID)
    }

    // MARK: Scan

    /// Store order (`StoredPage.seq`) scanned through for the device, or `nil` before the first scan.
    func lastScannedSeq(deviceID: String) throws -> Int64? {
        try db.query("SELECT seq FROM scans WHERE device_id = ?1", [.text(deviceID)]) { $0.int(0) }.first
    }

    /// Saves a scan and how far it read, together, with the spans from its lowest page on owed a rebuild. A page read
    /// again (rewritten in the store) replaces its row.
    func save(_ scan: PageScan, deviceID: String) throws {
        try db.transaction {
            if let lowest = (scan.pages.map(\.index) + scan.gaps.map(\.page)).min() {
                var state = try scanState(deviceID: deviceID)
                state.dirtyPage = min(state.dirtyPage ?? lowest, lowest)
                if let page = scan.pages.map(\.index).min() { state.stored = min(state.stored ?? page, page) }
                try setScanState(state, deviceID: deviceID)
            }
            for page in scan.pages {
                try db.run(
                    "INSERT OR REPLACE INTO pages VALUES (?1, ?2, ?3)",
                    [.text(deviceID), .int(Int64(page.index)), .blob(try encoder.encode(page))])
            }
            for gap in scan.gaps {
                try db.run(
                    "INSERT OR REPLACE INTO pages VALUES (?1, ?2, NULL)", [.text(deviceID), .int(Int64(gap.page))])
            }
            if let seq = scan.seq {
                try db.run("INSERT OR REPLACE INTO scans VALUES (?1, ?2)", [.text(deviceID), .int(seq)])
            }
        }
    }

    /// Scanned pages from index `from` on, in index order, and indices that could not be read (left out of the
    /// timeline as known losses).
    func pages(deviceID: String, from: UInt64 = 0) throws -> (pages: [AudioPage], unreadable: Set<UInt64>) {
        let rows = try db.query(
            "SELECT page_index, json FROM pages WHERE device_id = ?1 AND page_index >= ?2 ORDER BY page_index",
            [.text(deviceID), .int(Int64(from))]
        ) { row in
            (
                index: UInt64(row.int(0)),
                page: row.isNull(1) ? nil : try decoder.decode(AudioPage.self, from: row.blob(1))
            )
        }
        return (rows.compactMap(\.page), Set(rows.filter { $0.page == nil }.map(\.index)))
    }

    /// The page at `index` as scanned: `nil` before it is scanned, `.some(nil)` when it could not be read.
    func page(deviceID: String, index: UInt64) throws -> AudioPage?? {
        try db.query(
            "SELECT json FROM pages WHERE device_id = ?1 AND page_index = ?2",
            [.text(deviceID), .int(Int64(index))]
        ) { $0.isNull(0) ? nil : try decoder.decode(AudioPage.self, from: $0.blob(0)) }.first
    }

    func scanState(deviceID: String) throws -> ScanState {
        try decode("SELECT json FROM scan_state WHERE device_id = ?1", [.text(deviceID)]).first ?? ScanState()
    }

    func setScanState(_ state: ScanState, deviceID: String) throws {
        try db.run(
            "INSERT OR REPLACE INTO scan_state VALUES (?1, ?2)", [.text(deviceID), .blob(try encoder.encode(state))])
    }

    /// The clock syncs the scanner last read, each with its anchor once its page was scanned.
    func clock(deviceID: String) throws -> [ClockEntry] {
        try decode("SELECT json FROM clock WHERE device_id = ?1 ORDER BY first_page", [.text(deviceID)])
    }

    /// The last two spans starting below page `index`, latest first.
    func spans(deviceID: String, startingBelow index: UInt64) throws -> [CaptureSpan] {
        try decode(
            "SELECT json FROM spans WHERE device_id = ?1 AND first_page < ?2 ORDER BY first_page DESC LIMIT 2",
            [.text(deviceID), .int(Int64(index))])
    }

    /// Spans overlapping `range`, in order: the first `limit`.
    func spans(deviceID: String, overlapping range: Range<CaptureInstant>, limit: Int = .max) throws -> [CaptureSpan] {
        try decode(
            "SELECT json FROM spans WHERE device_id = ?1 AND end_ms > ?2 AND start_ms < ?3 ORDER BY first_page LIMIT ?4",
            [.text(deviceID), .int(range.lowerBound.millis), .int(range.upperBound.millis), .int(Int64(limit))])
    }

    /// The first span starting above page `index`.
    func spans(deviceID: String, startingAbove index: UInt64) throws -> [CaptureSpan] {
        try decode(
            "SELECT json FROM spans WHERE device_id = ?1 AND first_page > ?2 ORDER BY first_page LIMIT 1",
            [.text(deviceID), .int(Int64(index))])
    }

    /// The latest end of a span ending at or before `instant`.
    func spanEnd(deviceID: String, atOrBefore instant: CaptureInstant) throws -> CaptureInstant? {
        try db.query(
            "SELECT MAX(end_ms) FROM spans WHERE device_id = ?1 AND end_ms <= ?2",
            [.text(deviceID), .int(instant.millis)]
        ) { $0.isNull(0) ? nil : CaptureInstant(millis: $0.int(0)) }.first ?? nil
    }

    /// The start of the last span starting before `instant`.
    func spanStart(deviceID: String, before instant: CaptureInstant) throws -> CaptureInstant? {
        try db.query(
            "SELECT start_ms FROM spans WHERE device_id = ?1 AND start_ms < ?2 ORDER BY start_ms DESC LIMIT 1",
            [.text(deviceID), .int(instant.millis)]
        ) { CaptureInstant(millis: $0.int(0)) }.first
    }

    /// Where stored audio continues past `instant` (or starts, when `nil`): the first span ending after it.
    func firstSpan(deviceID: String, endingAfter instant: CaptureInstant?) throws -> Range<CaptureInstant>? {
        try db.query(
            "SELECT start_ms, end_ms FROM spans WHERE device_id = ?1 AND end_ms > ?2 ORDER BY end_ms LIMIT 1",
            [.text(deviceID), .int(instant?.millis ?? .min)]
        ) { CaptureInstant(millis: $0.int(0))..<CaptureInstant(millis: $0.int(1)) }.first
    }

    /// Replaces the spans from page `from` on with `spans` (built from that page on), and keeps the clock entries
    /// that changed (`nil`: the sync is gone) and `state`, together.
    func replaceSpans(
        from: UInt64, with spans: [CaptureSpan], clock: [UInt64: ClockEntry?], state: ScanState, deviceID: String
    ) throws {
        try db.transaction {
            try db.run(
                "DELETE FROM spans WHERE device_id = ?1 AND first_page >= ?2", [.text(deviceID), .int(Int64(from))])
            for span in spans {
                try db.run(
                    "INSERT INTO spans VALUES (?1, ?2, ?3, ?4, ?5)",
                    [
                        .text(deviceID), .int(Int64(span.pages.lowerBound)), .int(span.interval.lowerBound.millis),
                        .int(span.interval.upperBound.millis), .blob(try encoder.encode(span)),
                    ])
            }
            for (first, entry) in clock {
                if let entry {
                    try db.run(
                        "INSERT OR REPLACE INTO clock VALUES (?1, ?2, ?3)",
                        [.text(deviceID), .int(Int64(first)), .blob(try encoder.encode(entry))])
                } else {
                    try db.run(
                        "DELETE FROM clock WHERE device_id = ?1 AND first_page = ?2",
                        [.text(deviceID), .int(Int64(first))])
                }
            }
            try setScanState(state, deviceID: deviceID)
        }
    }

    /// The indexed sidecar named `name`: its audio and labels together, and where its audio ends.
    private func sidecar(deviceID: String, named name: String) throws -> (
        extent: Range<CaptureInstant>, audioEnd: CaptureInstant
    )? {
        try db.query(
            "SELECT start_ms, end_ms, audio_end_ms FROM sidecars WHERE device_id = ?1 AND name = ?2",
            [.text(deviceID), .text(name)]
        ) {
            (CaptureInstant(millis: $0.int(0))..<CaptureInstant(millis: $0.int(1)), CaptureInstant(millis: $0.int(2)))
        }.first
    }

    /// Names of the sidecars whose audio or labels overlap `range`.
    func sidecars(deviceID: String, overlapping range: Range<CaptureInstant>) throws -> [String] {
        try db.query(
            "SELECT name FROM sidecars WHERE device_id = ?1 AND end_ms > ?2 AND start_ms < ?3 ORDER BY start_ms",
            [.text(deviceID), .int(range.lowerBound.millis), .int(range.upperBound.millis)]
        ) { $0.text(0) }
    }

    /// Indexes sidecars by file name, in one transaction, and pulls the facts owed back to where each changes them: the
    /// earliest moment of its audio and labels, old or new, and the span a move of the analyzers' frontier cut (spans
    /// are read only up to it). One indexed as it is changes nothing.
    func index(_ sidecars: [(name: String, segment: PlaybackSegment)], deviceID: String) throws {
        try db.transaction { try indexRows(sidecars, deviceID: deviceID) }
    }

    private func indexRows(_ sidecars: [(name: String, segment: PlaybackSegment)], deviceID: String) throws {
        var state = try scanState(deviceID: deviceID)
        let before = try frontier(deviceID: deviceID)
        var changed = false
        for (name, segment) in sidecars {
            let extent = segment.activity.map(\.interval).reduce(segment.interval) {
                min($0.lowerBound, $1.lowerBound)..<max($0.upperBound, $1.upperBound)
            }
            let audioEnd = segment.interval.upperBound
            let old = try sidecar(deviceID: deviceID, named: name)
            if let old, old.extent == extent, old.audioEnd == audioEnd { continue }
            state.pull(old?.extent.lowerBound)
            state.pull(extent.lowerBound)
            try db.run(
                "INSERT OR REPLACE INTO sidecars VALUES (?1, ?2, ?3, ?4, ?5)",
                [
                    .text(deviceID), .text(name), .int(extent.lowerBound.millis), .int(extent.upperBound.millis),
                    .int(audioEnd.millis),
                ])
            changed = true
        }
        guard changed else { return }
        if let after = try frontier(deviceID: deviceID), before != after {
            let moved = min(before ?? after, after)
            state.pull(
                before == nil ? CaptureInstant(millis: .min) : try spanStart(deviceID: deviceID, before: moved) ?? moved
            )
        }
        try setScanState(state, deviceID: deviceID)
    }

    /// Where the analyzers reached: the end of the latest sidecar's audio.
    func frontier(deviceID: String) throws -> CaptureInstant? {
        try db.query(
            "SELECT MAX(audio_end_ms) FROM sidecars WHERE device_id = ?1", [.text(deviceID)]
        ) { $0.isNull(0) ? nil : CaptureInstant(millis: $0.int(0)) }.first ?? nil
    }

    // MARK: Old jobs' audio

    /// Every part the old pipeline planned, read-only.
    func parts() throws -> [PartRecord] {
        try decode("SELECT json FROM parts ORDER BY conversation_ms, part_index")
    }

    // MARK: Private

    private func decode<T: Decodable>(_ sql: String, _ values: [SQLValue] = []) throws -> [T] {
        try db.query(sql, values) { try decoder.decode(T.self, from: $0.blob(0)) }
    }

    /// Forward-only. Append a new entry for every schema change; never edit a shipped one. Each runs in one transaction
    /// with its version, so an interrupted one runs again whole.
    static let migrations = [
        """
        CREATE TABLE pages (
            device_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            session INTEGER NOT NULL,
            device_ms INTEGER NOT NULL,
            packets INTEGER NOT NULL,
            PRIMARY KEY (device_id, page_index)
        ) WITHOUT ROWID;
        CREATE TABLE parts (
            conversation_ms INTEGER NOT NULL,
            part_index INTEGER NOT NULL,
            json BLOB NOT NULL,
            PRIMARY KEY (conversation_ms, part_index)
        );
        CREATE TABLE state (key TEXT PRIMARY KEY, json BLOB NOT NULL);
        CREATE TABLE recognition (conversation_ms INTEGER PRIMARY KEY, json BLOB NOT NULL);
        """,
        // Pages now keep where each packet sits, their boot and uptime. The table is a cache: rescanned from 0.
        """
        DROP TABLE pages;
        CREATE TABLE pages (
            device_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            json BLOB,
            PRIMARY KEY (device_id, page_index)
        ) WITHOUT ROWID;
        """,
        // Pages are now scanned in store order (`scannedSeq:`), not above the highest index. Rescan from 0 once, so
        // pages stored below that mark reach conversations.
        "DELETE FROM pages;",
        // The key-value `state` becomes one table per owner, values as they were (JSON where a value is
        // a structure). `changesCursor` wins over the older `speakerCursor`, as it did when read.
        """
        CREATE TABLE scans (device_id TEXT PRIMARY KEY, seq INTEGER NOT NULL) WITHOUT ROWID;
        INSERT INTO scans SELECT substr(key, 12), CAST(CAST(json AS TEXT) AS INTEGER) FROM state
            WHERE key GLOB 'scannedSeq:*';
        CREATE TABLE edits_to_move (id INTEGER PRIMARY KEY CHECK (id = 0), json BLOB NOT NULL);
        INSERT INTO edits_to_move SELECT 0, json FROM state WHERE key = 'edits';
        CREATE TABLE approval (id INTEGER PRIMARY KEY CHECK (id = 0), json BLOB NOT NULL);
        INSERT INTO approval SELECT 0, json FROM state WHERE key = 'approval';
        CREATE TABLE stored_transcripts (conversation_ms INTEGER PRIMARY KEY, json BLOB NOT NULL);
        INSERT INTO stored_transcripts SELECT CAST(substr(key, 8) AS INTEGER), json FROM state WHERE key GLOB 'stored:*';
        CREATE TABLE superseded (conversation_ms INTEGER PRIMARY KEY, json BLOB NOT NULL);
        INSERT INTO superseded SELECT CAST(substr(key, 12) AS INTEGER), json FROM state WHERE key GLOB 'superseded:*';
        CREATE TABLE server_sync (conversation_ms INTEGER PRIMARY KEY, json BLOB NOT NULL);
        INSERT INTO server_sync SELECT CAST(substr(key, 8) AS INTEGER), json FROM state WHERE key GLOB 'server:*';
        CREATE TABLE place_names (cell TEXT PRIMARY KEY, name TEXT NOT NULL) WITHOUT ROWID;
        INSERT INTO place_names SELECT substr(key, 7), json_extract(CAST(json AS TEXT), '$') FROM state
            WHERE key GLOB 'place:*';
        CREATE TABLE cloud (
            id INTEGER PRIMARY KEY CHECK (id = 0),
            changes_cursor TEXT,
            mac_watch BLOB,
            saved_places_version TEXT,
            reported_retirements TEXT
        );
        INSERT INTO cloud VALUES (
            0,
            COALESCE(
                (SELECT json_extract(CAST(json AS TEXT), '$') FROM state WHERE key = 'changesCursor'),
                (SELECT json_extract(CAST(json AS TEXT), '$') FROM state WHERE key = 'speakerCursor')),
            (SELECT json FROM state WHERE key = 'macWatch'),
            (SELECT json_extract(CAST(json AS TEXT), '$') FROM state WHERE key = 'savedPlacesVersion'),
            (SELECT json_extract(CAST(json AS TEXT), '$') FROM state WHERE key = 'reportedRetirements'));
        DROP TABLE state;
        """,
        // Incremental grouping: what the last pass saw (`ScanState`), the clock with its anchors, the spans built
        // from the scanned pages, and an index of the derived sidecars by time.
        """
        CREATE TABLE grouping (device_id TEXT PRIMARY KEY, json BLOB NOT NULL) WITHOUT ROWID;
        CREATE TABLE clock (
            device_id TEXT NOT NULL,
            first_page INTEGER NOT NULL,
            json BLOB NOT NULL,
            PRIMARY KEY (device_id, first_page)
        ) WITHOUT ROWID;
        CREATE TABLE spans (
            device_id TEXT NOT NULL,
            first_page INTEGER NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            json BLOB NOT NULL,
            PRIMARY KEY (device_id, first_page)
        ) WITHOUT ROWID;
        CREATE INDEX spans_start ON spans (device_id, start_ms);
        CREATE INDEX spans_end ON spans (device_id, end_ms);
        CREATE TABLE sidecars (
            device_id TEXT NOT NULL,
            name TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            audio_end_ms INTEGER NOT NULL,
            PRIMARY KEY (device_id, name)
        ) WITHOUT ROWID;
        CREATE INDEX sidecars_end ON sidecars (device_id, end_ms);
        CREATE INDEX sidecars_audio_end ON sidecars (device_id, audio_end_ms);
        """,
        // Stored transcripts guessed each word's spacing from the turn text, and put spaces between Thai letters. Each
        // is owed the server's own spacing once.
        """
        CREATE TABLE respace (conversation_ms INTEGER PRIMARY KEY);
        INSERT INTO respace SELECT conversation_ms FROM stored_transcripts;
        """,
        // 11 October 2026: the server hid the conversations of 8–11 October overnight, and its upkeep dropped their
        // voice samples. Recognition runs again once for those, so the samples are uploaded again (idempotent per turn).
        """
        UPDATE recognition SET json = CAST('{"pending":{}}' AS BLOB)
            WHERE conversation_ms BETWEEN 1791417600000 AND 1791734460000;
        """,
        // Speakers whose turns went to the server's turn check, once each.
        "CREATE TABLE turn_checks (job TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (job, label)) WITHOUT ROWID;",
        // Saved places are gone: no version to compare.
        "ALTER TABLE cloud DROP COLUMN saved_places_version;",
        // The Thai spacing backfill ran everywhere.
        "DROP TABLE respace;",
        // The rebuild: the file holds the scanner's timeline. Of the old pipeline only `parts` is read (then the handover,
        // the backup of old jobs' audio); the rest goes. `grouping` held the scanner's state.
        """
        DROP TABLE recognition;
        DROP TABLE edits_to_move;
        DROP TABLE approval;
        DROP TABLE stored_transcripts;
        DROP TABLE superseded;
        DROP TABLE server_sync;
        DROP TABLE place_names;
        DROP TABLE cloud;
        DROP TABLE turn_checks;
        ALTER TABLE grouping RENAME TO scan_state;
        """,
        // The scanner no longer lists the derived directory, so its date mark goes; `indexUnlisted` runs with this one.
        "UPDATE scan_state SET json = CAST(json_remove(CAST(json AS TEXT), '$.derived') AS BLOB);",
    ]

    /// The migration that drops the listing's date mark (`indexUnlisted`).
    static let listingDropped = 11
}

/// What the scanner last saw of its inputs, and the work it still owes, so a scan reads only what changed.
struct ScanState: Codable, Equatable {
    /// Spans from this page index on are owed a rebuild: pages, gaps or the clock changed there.
    var dirtyPage: UInt64? = 0
    /// Timeline facts from here on are owed a send (`TimelineScanner.factsSent`).
    var facts: CaptureInstant?
    /// The lowest page stored since the uploader last looked (`TimelineScanner.storedSeen`): one stored late, below its
    /// cursor, moves the cursor back to it.
    var stored: UInt64?
    /// Indices the device reported unreadable (`SourceStore.gaps`).
    var gaps: [UInt64] = []
    var pauses = Mark()

    /// How many rows an append-mostly input held, and its latest key.
    struct Mark: Codable, Equatable {
        var count = 0
        var last: Int64?
    }

    /// Moves the facts owed back to `instant`, if that is earlier.
    mutating func pull(_ instant: CaptureInstant?) {
        guard let instant else { return }
        facts = min(facts ?? instant, instant)
    }
}

/// One clock sync as the scanner read it, with its anchor: the first page it stamped, once scanned (`checked`).
struct ClockEntry: Codable, Equatable {
    var sync: ClockSync
    var anchor: ClockAnchor?
    var checked = false
}

public enum TimelineStoreError: Error, Equatable {
    /// `timeline.sqlite` was written by a newer app. Fail closed.
    case unknownSchemaVersion(Int)
}
