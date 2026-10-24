import Foundation
import SourceStore
import Timeline

public enum LibraryCacheError: Error, Equatable {
    /// A feed page without its cursor: nothing of it is applied.
    case malformedFeed
}

/// A cached row a read couldn't decode: it is left out of what the read returns, and reported
/// (`LibraryStore.init(report:)`), so one bad row never empties a screen.
public struct UndecodableRow: Error, CustomStringConvertible {
    public var kind: String
    public var key: String
    public var error: any Error

    public var description: String { "\(kind) \(key): \(error)" }

    package init(kind: String, key: String, error: any Error) {
        self.kind = kind
        self.key = key
        self.error = error
    }
}

/// The server's feed (`GET /changes`, contract "The feed") kept in `library.sqlite`: screens read the server's
/// conversations, words, chapters and the rest from here, offline too. Each row is kept as the server sent it, under
/// its key; a row the feed emits again replaces it, so applying a page twice changes nothing. A row the feed lists in
/// `removed` goes. A page and its cursor are applied in one transaction.
///
/// A turn or chapter belongs to the conversation the feed says (`conversationId`): the server sends it again
/// after every regroup that moves it, so nothing is placed by time here.
extension LibraryStore {
    /// The feed's arrays and the fields that key their rows. (`assignments` are the server's: turns carry their
    /// speaker.)
    static let feedKeys: [String: [String]] = [
        "conversations": ["id"], "turns": ["jobId", "turnIndex"], "chapters": ["id"],
        "people": ["id"], "quietRanges": ["id"], "edits": ["id"],
    ]

    /// `removed[].kind` (the server's change kind) to the array its rows came in. A ref is the row's key (a turn's
    /// `jobId:turnIndex`). A removed job is the uploader's (`apply`'s `withdrawn`), not the cache's.
    static let removedKinds = [
        "turn": "turns", "chapter": "chapters", "person": "people",
        "edit": "edits", "conversation": "conversations", "quietRange": "quietRanges",
    ]

    /// What each kind's search text is made of.
    static let searchFields: [String: [String]] = [
        "conversations": ["ownerTitle", "title", "tldr", "place"], "turns": ["text"],
        "chapters": ["title", "summary"],
    ]

    /// Applies one feed page and returns its cursor and whether another page waits. The single values (`mac`,
    /// `switches`, `vocabulary`) are kept only from the last page of a pull (`more` false), with when
    /// it was applied (`pulledAt`): they say where the server stands once every row before them is in hand. The removed
    /// jobs that carry a first page (fragments and queued jobs the server withdrew) are the uploader's: they go to
    /// `withdrawn` before the page's cursor is saved, so a kill in between fetches the page again and rewinds again.
    @discardableResult
    public func apply(
        feed data: Data, at now: Date = .now,
        withdrawn: @Sendable ([(sourceId: String, firstPage: UInt64)]) async throws -> Void
    ) async throws -> (cursor: String, more: Bool) {
        guard let page = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LibraryCacheError.malformedFeed
        }
        let removed = page["removed"] as? [[String: Any]] ?? []
        try await withdrawn(
            removed.compactMap { row in
                guard row["kind"] as? String == "job", let source = row["sourceId"] as? String,
                    let first = row["firstPage"] as? UInt64
                else { return nil }
                return (sourceId: source, firstPage: first)
            })
        guard let cursor = page["cursor"] as? String else { throw LibraryCacheError.malformedFeed }
        let more = page["more"] as? Bool ?? false
        struct Row {
            var kind, key: String
            var conversation: String?
            var start, end: CaptureInstant?
            var json: Data
            var text: String?
        }
        var rows: [Row] = []
        for (kind, fields) in Self.feedKeys {
            for row in page[kind] as? [[String: Any]] ?? [] {
                let key = fields.map { "\(row[$0] ?? NSNull())" }.joined(separator: "|")
                let instant = { (names: [String]) in
                    names.lazy.compactMap { row[$0] as? String }.first.flatMap(Self.instant)
                }
                rows.append(
                    Row(
                        kind: kind, key: key,
                        conversation: row["conversationId"] as? String ?? (kind == "conversations" ? key : nil),
                        start: instant(["startAt", "startedAt"]), end: instant(["endAt", "endedAt"]),
                        json: try JSONSerialization.data(withJSONObject: row, options: .sortedKeys),
                        text: Self.searchFields[kind]?.compactMap { row[$0] as? String }.joined(separator: "\n")))
            }
        }
        let dropped = removed.compactMap { row -> (String, String)? in
            guard let kind = (row["kind"] as? String).flatMap({ Self.removedKinds[$0] }),
                let ref = row["ref"] as? String
            else { return nil }
            return (kind, kind == "turns" ? ref.replacing(":", with: "|") : ref)
        }
        var singles: Data?
        if !more {
            var state = try feedState().flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            for key in ["mac", "held", "switches", "vocabulary"] where page[key] != nil {
                state[key] = page[key]
            }
            state["pulledAt"] = now.formatted(Self.iso)
            singles = try JSONSerialization.data(withJSONObject: state, options: .sortedKeys)
        }
        try db.transaction {
            for (kind, key) in dropped {
                try db.run("DELETE FROM feed_rows WHERE kind = ?1 AND key = ?2", [.text(kind), .text(key)])
                try db.run("DELETE FROM feed_text WHERE rowid = ?1", [.int(Self.textID(kind, key))])
            }
            for row in rows {
                try db.run(
                    "INSERT OR REPLACE INTO feed_rows (kind, key, conversation, start_ms, json, end_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    [
                        .text(row.kind), .text(row.key), row.conversation.map { .text($0) } ?? .null,
                        row.start.map { .int($0.millis) } ?? .null, .blob(row.json),
                        row.end.map { .int($0.millis) } ?? .null,
                    ])
                guard let text = row.text else { continue }
                let id = Self.textID(row.kind, row.key)
                try db.run("DELETE FROM feed_text WHERE rowid = ?1", [.int(id)])
                if !text.isEmpty, let start = row.start {
                    try db.run(
                        "INSERT INTO feed_text (rowid, text, kind, start_ms, conversation) VALUES (?1, ?2, ?3, ?4, ?5)",
                        [
                            .int(id), .text(text), .text(row.kind), .int(start.millis),
                            row.conversation.map { .text($0) } ?? .null,
                        ])
                }
            }
            if let singles {
                try db.run("INSERT OR REPLACE INTO feed_state VALUES (0, ?1, ?2)", [.text(cursor), .blob(singles)])
            } else {
                try db.run(
                    "INSERT INTO feed_state VALUES (0, ?1, '{}') ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor",
                    [.text(cursor)])
            }
        }
        return (cursor, more)
    }

    /// The cursor of the last page applied; `nil` before the first.
    public func feedCursor() throws -> String? {
        try db.query("SELECT cursor FROM feed_state") { $0.text(0) }.first
    }

    /// The `mac`, `switches` and `vocabulary` of the last complete pull, as one JSON object, with `pulledAt`.
    public func feedState() throws -> Data? {
        try db.query("SELECT json FROM feed_state") { $0.blob(0) }.first
    }

    // MARK: Reads

    /// Live conversations the library lists (`listed`), newest first, starting
    /// strictly before `before`.
    public func conversations(before: CaptureInstant?, limit: Int) throws -> [CachedConversation] {
        try cached(
            """
            SELECT kind, key, json FROM feed_rows WHERE kind = 'conversations' AND start_ms < ?1 AND \(Self.listed())
            ORDER BY start_ms DESC LIMIT ?2
            """, [.int(before?.millis ?? .max), .int(Int64(limit))])
    }

    /// Live listed conversations starting strictly after `after`, oldest first.
    public func conversations(after: CaptureInstant, limit: Int) throws -> [CachedConversation] {
        try cached(
            """
            SELECT kind, key, json FROM feed_rows WHERE kind = 'conversations' AND start_ms > ?1 AND \(Self.listed())
            ORDER BY start_ms LIMIT ?2
            """, [.int(after.millis), .int(Int64(limit))])
    }

    /// Live listed conversations overlapping `range`, oldest first.
    public func conversations(overlapping range: Range<CaptureInstant>) throws -> [CachedConversation] {
        try cached(
            """
            SELECT kind, key, json FROM feed_rows WHERE kind = 'conversations' AND start_ms < ?2 AND end_ms > ?1 AND \(Self.listed())
            ORDER BY start_ms
            """, [.int(range.lowerBound.millis), .int(range.upperBound.millis)])
    }

    /// Live recordings of the hidden kinds (wordless, dictation to the Mac) starting in `range`, oldest first: the
    /// library folds them into one line a day.
    public func quietConversations(in range: Range<CaptureInstant>) throws -> [CachedConversation] {
        try cached(
            """
            SELECT kind, key, json FROM feed_rows WHERE kind = 'conversations' AND start_ms >= ?1 AND start_ms < ?2
            AND json_extract(CAST(json AS TEXT), '$.retired') IS NULL
            AND json_extract(CAST(json AS TEXT), '$.kind') IN ('silent', 'dictation')
            ORDER BY start_ms
            """, [.int(range.lowerBound.millis), .int(range.upperBound.millis)])
    }

    /// The conversation, or the live one a merge or undo retired it into. `nil` when the feed never sent it.
    public func conversation(_ id: UUID) throws -> CachedConversation? {
        var current = id
        var seen: Set<UUID> = []
        while seen.insert(current).inserted {
            let found: CachedConversation? = try cached(
                "SELECT kind, key, json FROM feed_rows WHERE kind = 'conversations' AND key = ?1",
                [.text(Self.key(current))]
            ).first
            guard let found else { return nil }
            guard let retired = found.retired else { return found }
            guard let successor = retired.successorId else { return found }
            current = successor
        }
        return nil
    }

    /// The conversation's turns with words, in order.
    public func turns(of conversation: UUID) throws -> [CachedTurn] {
        try cached(
            """
            SELECT kind, key, json FROM feed_rows WHERE kind = 'turns' AND conversation = ?1
            AND json_extract(CAST(json AS TEXT), '$.text') <> '' ORDER BY start_ms, key
            """, [.text(Self.key(conversation))])
    }

    /// Chapters of the conversation, in order.
    public func chapters(of conversation: UUID) throws -> [CachedChapter] {
        try cached(
            "SELECT kind, key, json FROM feed_rows WHERE kind = 'chapters' AND conversation = ?1 ORDER BY start_ms",
            [.text(Self.key(conversation))])
    }

    public func people() throws -> [CachedPerson] {
        try cached("SELECT kind, key, json FROM feed_rows WHERE kind = 'people'").sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    /// These grouping edits, as the server kept them, oldest first.
    public func edits(_ ids: [UUID]) throws -> [CachedEdit] {
        try cached(
            """
            SELECT kind, key, json FROM feed_rows WHERE kind = 'edits'
            AND key IN (SELECT value FROM json_each(?1)) ORDER BY start_ms
            """, [try Self.keys(ids)])
    }

    /// Who spoke, the first words and whether it has any, for each conversation: two small queries each, no turn
    /// decoded.
    public func facts(of conversations: [CachedConversation]) throws -> [UUID: ConversationFacts] {
        var facts: [UUID: ConversationFacts] = [:]
        for conversation in conversations {
            let id: [SQLValue] = [.text(Self.key(conversation.id))]
            let people = try db.query(
                """
                SELECT json_extract(CAST(json AS TEXT), '$.speaker.personName') AS name \(Self.turnsWithWords)
                AND name IS NOT NULL AND json_extract(CAST(json AS TEXT), '$.speaker.isOwner') IS NOT 1
                GROUP BY name ORDER BY MIN(start_ms)
                """, id
            ) { $0.text(0) }
            let opening = try db.query(Self.openingWords, id) { $0.text(0) }.joined(separator: " ")
            facts[conversation.id] = ConversationFacts(
                people: people, opening: opening.isEmpty ? nil : String(opening.prefix(200)),
                hasWords: !opening.isEmpty)
        }
        return facts
    }

    private static let turnsWithWords = """
        FROM feed_rows WHERE kind = 'turns' AND conversation = ?1
        AND json_extract(CAST(json AS TEXT), '$.text') <> ''
        """
    /// A conversation's first words; its plan is tested, since a list reads it for every row.
    static let openingWords =
        "SELECT json_extract(CAST(json AS TEXT), '$.text') \(turnsWithWords) ORDER BY start_ms LIMIT 4"

    /// Live conversations waiting for something, by the feed's reason (`waiting.reason`).
    public func waiting() throws -> [WaitingReason: Int] {
        Dictionary(
            try db.query(
                """
                SELECT json_extract(CAST(json AS TEXT), '$.waiting.reason') AS reason, COUNT(*) FROM feed_rows
                WHERE kind = 'conversations' AND reason IS NOT NULL AND \(Self.listed())
                GROUP BY reason
                """
            ) { (WaitingReason(rawValue: $0.text(0)) ?? .unknown, Int($0.int(1))) }, uniquingKeysWith: +)
    }

    // MARK: Search

    /// The trigram index matches nothing shorter.
    public static let minimumSearchLength = 3

    /// Conversations whose words, titles, summaries or chapters hold `text`, best match first, each
    /// once, with the text around its best match and, when words matched, the start of that turn. Case and
    /// diacritics insensitive. A query shorter than `minimumSearchLength` returns nothing.
    /// ponytail: reads up to 2000 matches then pages in memory; page in SQL if a word matches more.
    public func search(_ text: String, limit: Int, offset: Int = 0) throws -> [SearchMatch] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= Self.minimumSearchLength else { return [] }
        let hits = try db.query(
            """
            SELECT c.key, t.kind, t.start_ms, snippet(feed_text, 0, '', '', '…', 64)
            FROM feed_text t JOIN feed_rows c ON c.kind = 'conversations' AND c.key = t.conversation
                AND \(Self.listed("c.json"))
            WHERE feed_text MATCH ?1 ORDER BY t.rank LIMIT 2000
            """, [.text("\"" + query.replacing("\"", with: "\"\"") + "\"")]
        ) { row in
            (
                conversation: UUID(uuidString: row.text(0)),
                passage: row.text(1) == "turns"
                    ? CaptureInstant(millis: row.int(2)) : nil, snippet: row.text(3)
            )
        }
        var seen: Set<UUID> = []
        let matches = hits.compactMap { hit -> SearchMatch? in
            guard let id = hit.conversation, seen.insert(id).inserted else { return nil }
            return SearchMatch(conversation: id, passage: hit.passage, snippet: hit.snippet, source: .words)
        }
        return Array(matches.dropFirst(offset).prefix(limit))
    }

    // MARK: Private

    /// Live and listed: not retired; wordless audio and dictation to the Mac are not conversations.
    private static func listed(_ json: String = "json") -> String {
        """
        json_extract(CAST(\(json) AS TEXT), '$.retired') IS NULL
        AND json_extract(CAST(\(json) AS TEXT), '$.kind') NOT IN ('silent', 'dictation')
        """
    }

    /// Rows decoded as `T`, from a query selecting `kind, key, json`. A row that doesn't decode is left out and
    /// reported.
    private func cached<T: Decodable>(_ sql: String, _ values: [SQLValue] = []) throws -> [T] {
        try db.query(sql, values) { row -> T? in
            do {
                return try Self.feedDecoder.decode(T.self, from: row.blob(2))
            } catch {
                report(UndecodableRow(kind: row.text(0), key: row.text(1), error: error))
                return nil
            }
        }.compactMap(\.self)
    }

    /// A UUID as the server writes it in keys: lowercase.
    static func key(_ id: UUID) -> String { id.uuidString.lowercased() }

    /// The keys of `ids` as one JSON array, read in SQL with `json_each`.
    static func keys(_ ids: [UUID]) throws -> SQLValue {
        .text(String(decoding: try JSONEncoder().encode(ids.map(key)), as: UTF8.self))
    }

    /// The search row of a feed row: FNV-1a of its kind and key, 63 bits, so a row is replaced without a scan.
    static func textID(_ kind: String, _ key: String) -> Int64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in "\(kind)|\(key)".utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01b3
        }
        return Int64(bitPattern: hash >> 1)
    }

    /// Dates on the wire are ISO 8601 with milliseconds, as the server writes them.
    public static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    /// Every server answer's dates: ISO 8601, with milliseconds or without.
    public static let feedDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = instant(text)?.date else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: text))
            }
            return date
        }
        return decoder
    }()

    private static func instant(_ text: String) -> CaptureInstant? {
        ((try? iso.parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text))).map(CaptureInstant.init)
    }
}
