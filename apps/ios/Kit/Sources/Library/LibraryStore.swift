import Foundation
import SourceStore
import Timeline

public enum LibraryStoreError: Error, Equatable {
    /// Written by a newer app. Fail closed rather than show an empty or half-read library.
    case unknownSchemaVersion(Int)
}

/// `library.sqlite`: the server's feed as the screens read it (`LibraryCache.swift`), the owner's edits waiting for
/// the server (the outbox, `ServerAPI/Outbox.swift`), and what only this phone knows: its location history until the server has it, the
/// stretches it played a recording out loud (left out of uploads), and where each recording imported from the old app
/// has its audio.
public actor LibraryStore {
    /// `package`: the outbox (`ServerAPI/Outbox.swift`) keeps its table here.
    package let db: SQLite
    /// A cached row a read had to leave out (`UndecodableRow`).
    package let report: @Sendable (any Error) -> Void
    /// Audio files of conversations imported from the old app (`ImportedAudio.file`). Nothing rebuilds them, so they
    /// live beside the library and go into backups.
    public nonisolated let importedAudio: URL
    // Sorted keys: stored JSON is compared byte for byte (visits, markSent), and key order is otherwise unstable.
    private let encoder = {
        let e = JSONEncoder(); e.outputFormatting = .sortedKeys; return e
    }()
    private let decoder = JSONDecoder()

    public init(directory: URL, report: @escaping @Sendable (any Error) -> Void = { _ in }) throws {
        self.report = report
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        db = try SQLite(path: directory.appending(path: "library.sqlite").path)
        importedAudio = directory.appending(path: "imported", directoryHint: .isDirectory)
        try db.migrate(Self.migrations, tooNew: LibraryStoreError.unknownSchemaVersion)
        // Statistics for the planner, refreshed where they are stale; cheap, and SQLite's advice for a long-lived
        // connection. Only a speed-up: a full disk must not close the library.
        try? db.execute("PRAGMA optimize = 0x10002")
    }

    // MARK: Imported recordings

    /// The audio file of a conversation imported from the old app, by its server id; `nil` for any other.
    public func importedAudio(of conversation: UUID) throws -> ImportedAudio? {
        guard let id = ConversationID(serverID: conversation) else { return nil }
        return try decode("SELECT json FROM imported_audio WHERE id = ?1", [.int(id.anchor.millis)]).first
    }

    // MARK: Quiet ranges

    /// Stores a stretch this app played a recording out loud. A span still playing grows: it replaces the one stored
    /// with the same start, so the latest end wins.
    public func setPlaybackQuiet(_ range: Range<CaptureInstant>) throws {
        guard !range.isEmpty else { return }
        try db.transaction {
            try db.run(
                "DELETE FROM quiet_ranges WHERE start_ms = ?1 AND source = 'playback'", [.int(range.lowerBound.millis)])
            try db.run(
                "INSERT OR IGNORE INTO quiet_ranges (start_ms, end_ms, source) VALUES (?1, ?2, 'playback')",
                [.int(range.lowerBound.millis), .int(range.upperBound.millis)])
        }
    }

    /// Stretches uploads leave out overlapping `range`, sorted by start: the feed's quiet ranges (the Mac's dictation,
    /// and the playback ranges the server has) and this phone's playback ones.
    public func quietRanges(in range: Range<CaptureInstant>) throws -> [Range<CaptureInstant>] {
        try db.query(
            """
            SELECT start_ms, end_ms FROM quiet_ranges WHERE source = 'playback' AND start_ms < ?2 AND end_ms > ?1
            UNION SELECT start_ms, end_ms FROM feed_rows WHERE kind = 'quietRanges' AND start_ms < ?2 AND end_ms > ?1
            ORDER BY start_ms
            """, [.int(range.lowerBound.millis), .int(range.upperBound.millis)]
        ) { CaptureInstant(millis: $0.int(0))..<CaptureInstant(millis: $0.int(1)) }
    }

    // MARK: Location history

    /// One fix per capture millisecond; a replayed fix is ignored.
    public func record(_ observation: PlaceObservation) throws {
        try db.run(
            "INSERT OR IGNORE INTO observations (at_ms, json) VALUES (?1, ?2)",
            [.int(observation.at.millis), .blob(try encoder.encode(observation))])
    }

    /// One visit per arrival: its departure, reported later, replaces it and makes it unsent again.
    public func record(_ visit: LocationVisit) throws {
        try db.run(
            """
            INSERT INTO visits (at_ms, json) VALUES (?1, ?2)
            ON CONFLICT (at_ms) DO UPDATE SET json = excluded.json, sent = 0 WHERE visits.json <> excluded.json
            """, [.int(visit.key), .blob(try encoder.encode(visit))])
    }

    /// Fixes in `range`, for exports.
    public func observations(in range: Range<CaptureInstant>) throws -> [PlaceObservation] {
        try decode(
            "SELECT json FROM observations WHERE at_ms >= ?1 AND at_ms < ?2 ORDER BY at_ms",
            [.int(range.lowerBound.millis), .int(range.upperBound.millis)])
    }

    /// Fixes and visits the server's location history doesn't have yet, oldest first, at most `limit` of each.
    public func unsentLocations(limit: Int) throws -> (fixes: [PlaceObservation], visits: [LocationVisit]) {
        (
            try decode("SELECT json FROM observations WHERE sent = 0 ORDER BY at_ms LIMIT ?1", [.int(Int64(limit))]),
            try decode("SELECT json FROM visits WHERE sent = 0 ORDER BY at_ms LIMIT ?1", [.int(Int64(limit))])
        )
    }

    /// The server stored these. A visit that changed meanwhile (its departure came) stays unsent.
    public func markSent(fixes: [PlaceObservation], visits: [LocationVisit]) throws {
        try db.transaction {
            for fix in fixes {
                try db.run("UPDATE observations SET sent = 1 WHERE at_ms = ?1", [.int(fix.at.millis)])
            }
            for visit in visits {
                try db.run(
                    "UPDATE visits SET sent = 1 WHERE at_ms = ?1 AND json = ?2",
                    [.int(visit.key), .blob(try encoder.encode(visit))])
            }
        }
    }

    // MARK: Private

    func decode<T: Decodable>(_ sql: String, _ values: [SQLValue] = []) throws -> [T] {
        try db.query(sql, values) { try decoder.decode(T.self, from: $0.blob(0)) }
    }

    /// Forward-only. Append a new entry for every schema change; never edit a shipped one.
    static let migrations = [
        """
        CREATE TABLE conversations (
            id INTEGER PRIMARY KEY,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            json BLOB NOT NULL
        );
        CREATE INDEX conversations_start ON conversations (start_ms);
        CREATE TABLE transcripts (
            conversation_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            json BLOB NOT NULL,
            PRIMARY KEY (conversation_id, version)
        );
        CREATE TABLE edits (start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, json BLOB NOT NULL);
        CREATE INDEX edits_start ON edits (start_ms);
        CREATE TABLE people (id TEXT PRIMARY KEY, json BLOB NOT NULL);
        CREATE TABLE speakers (
            conversation_id INTEGER NOT NULL,
            label TEXT NOT NULL,
            person_id TEXT,
            json BLOB NOT NULL,
            PRIMARY KEY (conversation_id, label)
        );
        CREATE INDEX speakers_person ON speakers (person_id);
        CREATE TABLE bookmarks (id TEXT PRIMARY KEY, anchor_ms INTEGER, json BLOB NOT NULL);
        CREATE INDEX bookmarks_anchor ON bookmarks (anchor_ms);
        CREATE TABLE saved_places (id TEXT PRIMARY KEY, json BLOB NOT NULL);
        CREATE TABLE observations (at_ms INTEGER PRIMARY KEY, json BLOB NOT NULL);
        CREATE VIRTUAL TABLE search USING fts5 (
            title, transcript, people, places, bookmarks, tokenize = 'trigram remove_diacritics 1'
        );
        """,
        // Retired conversations, and each transcript's word span so regrouped words can be found by time.
        """
        CREATE TABLE retired (id INTEGER PRIMARY KEY, successor INTEGER, json BLOB NOT NULL);
        ALTER TABLE transcripts ADD COLUMN start_ms INTEGER;
        ALTER TABLE transcripts ADD COLUMN end_ms INTEGER;
        UPDATE transcripts SET
            start_ms = json_extract(CAST(json AS TEXT), '$.words[0].range[0].millis'),
            end_ms = (
                SELECT MAX(json_extract(value, '$.range[1].millis'))
                FROM json_each(CAST(transcripts.json AS TEXT), '$.words')
            );
        CREATE INDEX transcripts_span ON transcripts (start_ms);
        """,
        "CREATE TABLE turn_speakers (start_ms INTEGER PRIMARY KEY, end_ms INTEGER NOT NULL, json BLOB NOT NULL);",
        "CREATE TABLE vocabulary (id TEXT PRIMARY KEY, json BLOB NOT NULL);",
        // Stretches the owner spent dictating to the Mac: hidden from transcripts and search.
        """
        CREATE TABLE quiet_ranges (
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            PRIMARY KEY (start_ms, end_ms)
        );
        """,
        // Which quiet ranges are this app playing a recording out loud rather than the Mac.
        "ALTER TABLE quiet_ranges ADD COLUMN source TEXT NOT NULL DEFAULT 'mac';",
        // The server keeps the whole location history: each fix and visit is sent once, the ones already here too.
        """
        ALTER TABLE observations ADD COLUMN sent INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE visits (at_ms INTEGER PRIMARY KEY, json BLOB NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX observations_unsent ON observations (at_ms) WHERE sent = 0;
        """,
        // The owner's splits and merges, moved here from the processing ledger.
        "CREATE TABLE owner_edits (seq INTEGER PRIMARY KEY, json BLOB NOT NULL);",
        // Beside each search row: where each indexed line starts, so a hit opens at its passage, and whether the
        // transcript has words at all (media ones too), so a row knows a silent clip. Neither reads a transcript.
        "CREATE TABLE search_facts (id INTEGER PRIMARY KEY, line_starts BLOB NOT NULL, has_words INTEGER NOT NULL);",
        // The rebuild. The server's feed as it sent it (`LibraryCache`), with a trigram index over its words, titles,
        // summaries and bookmark names; owner edits waiting for the server (`Outbox`), each kept as the owner's
        // intent; each imported recording's audio in its own table. The Mac's quiet ranges come from the feed. The old
        // pipeline's tables nothing reads go; the handover reads `conversations`, `retired`, `owner_edits`,
        // `vocabulary` and `bookmarks`.
        """
        DROP TABLE saved_places;
        CREATE TABLE feed_rows (
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            conversation TEXT,
            start_ms INTEGER,
            end_ms INTEGER,
            json BLOB NOT NULL,
            PRIMARY KEY (kind, key)
        ) WITHOUT ROWID;
        CREATE INDEX feed_rows_conversation ON feed_rows (kind, conversation);
        CREATE INDEX feed_rows_start ON feed_rows (kind, start_ms);
        CREATE TABLE feed_state (id INTEGER PRIMARY KEY CHECK (id = 0), cursor TEXT NOT NULL, json BLOB NOT NULL);
        CREATE VIRTUAL TABLE feed_text USING fts5 (
            text, kind UNINDEXED, start_ms UNINDEXED, conversation UNINDEXED,
            tokenize = 'trigram remove_diacritics 1'
        );
        CREATE TABLE outbox (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            intent BLOB NOT NULL,
            created_ms INTEGER NOT NULL,
            refused TEXT
        );
        DELETE FROM quiet_ranges WHERE source <> 'playback';
        CREATE TABLE imported_audio (id INTEGER PRIMARY KEY, json BLOB NOT NULL);
        INSERT OR IGNORE INTO imported_audio
            SELECT id, CAST(json_extract(CAST(json AS TEXT), '$.imported') AS BLOB) FROM conversations
            WHERE json_extract(CAST(json AS TEXT), '$.imported') IS NOT NULL
            UNION ALL SELECT id, CAST(json_extract(CAST(json AS TEXT), '$.imported') AS BLOB) FROM retired
            WHERE json_extract(CAST(json AS TEXT), '$.imported') IS NOT NULL;
        DROP TABLE transcripts;
        DROP TABLE edits;
        DROP TABLE people;
        DROP TABLE speakers;
        DROP TABLE search;
        DROP TABLE turn_speakers;
        DROP TABLE search_facts;
        """,
        // Bookmarks removed (Oct 15; the server's were exported first): the old pipeline's table, the feed's rows and
        // the waiting edits go.
        """
        DROP TABLE bookmarks;
        DELETE FROM feed_rows WHERE kind = 'bookmarks';
        DELETE FROM feed_text WHERE kind = 'bookmarks';
        DELETE FROM outbox WHERE json_type(CAST(intent AS TEXT), '$.bookmark') IS NOT NULL
            OR json_type(CAST(intent AS TEXT), '$.deleteBookmark') IS NOT NULL;
        """,
        // Transcription limits removed (Oct 15): a waiting Release goes.
        "DELETE FROM outbox WHERE json_type(CAST(intent AS TEXT), '$.releaseHeld') IS NOT NULL;",
        // The cutover is done (Oct 14): the old pipeline's tables the handover read go, and the feed's job rows nothing
        // reads.
        """
        DELETE FROM feed_rows WHERE kind = 'jobs';
        DROP TABLE conversations;
        DROP TABLE retired;
        DROP TABLE owner_edits;
        DROP TABLE vocabulary;
        """,
        // A conversation's turns in order (`facts(of:)`): with (kind, conversation) alone, SQLite read every turn
        // through (kind, start_ms) to skip a sort, 1.4 s for a 30-row list (Oct 20).
        """
        DROP INDEX feed_rows_conversation;
        CREATE INDEX feed_rows_conversation ON feed_rows (kind, conversation, start_ms);
        """,
    ]
}
