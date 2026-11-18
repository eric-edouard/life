import Foundation
import Library
import SourceStore
import Timeline

/// The owner's edits on their way to the server (contract "Edits"). Each is kept in `library.sqlite` as what the owner
/// did (`OwnerIntent`), in the order made, with a client uuid, and becomes its request only when it is sent
/// (`OwnerIntent.request`). Screens show the waiting ones at once with a "waiting to sync" mark (`PendingEdits`), and a
/// refused one with the server's message until the owner lets it go.
public enum Outbox {
    /// Sends each waiting edit in order until the server answers. A 2xx takes it out; a refusal (`ServerClient.refuses`) keeps it with
    /// the server's message, for the owner, and the next goes on. Anything else (offline, a 5xx, the token refused, too
    /// many requests) stops here, so nothing overtakes an edit made before it; the next run starts again there.
    /// Returns whether an edit was settled, accepted or refused.
    @discardableResult
    public static func replay(_ library: LibraryStore, client: ServerClient) async throws -> Bool {
        var settled = false
        for entry in try await library.outbox() where entry.refused == nil {
            do {
                let (method, path, body) = try entry.intent.request(id: entry.id, at: entry.createdAt)
                var request = try client.request(path, method: method)
                if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
                _ = try await client.send(request, body: body)
                try await library.settle(entry.id, refused: nil)
            } catch ServerClient.ClientError.server(let status, _, let message) where ServerClient.refuses(status) {
                try await library.settle(entry.id, refused: message)
            }
            settled = true
        }
        return settled
    }
}

/// Something the owner did that the server must apply: the switches, the vocabulary, a playback quiet range.
public enum OwnerIntent: Sendable, Equatable, Codable {
    /// The owner turns transcription or AI on or off, picks the AI model, or sets when the server asks him to open the
    /// app; `nil` leaves one as it is.
    case switches(
        transcription: Bool? = nil, ai: Bool? = nil, engine: ServerClient.Switches.Engine? = nil,
        openAppAfterMinutes: Int? = nil)
    /// The owner's whole word list (people's names are the server's own).
    case vocabulary([String])
    /// A stretch this app played a recording out loud, padded: never transcription. Its id is the edit's.
    case playbackQuiet(from: Date, to: Date)

    /// The request it becomes. `id` is the edit's uuid (a playback range's id); `at`, when the
    /// owner made it.
    func request(id: UUID, at: Date) throws -> (method: String, path: String, body: Data?) {
        var method = "PUT"
        let path: String
        let body: (any Encodable)?
        switch self {
        case .switches(let transcription, let ai, let engine, let openAppAfterMinutes):
            path = "switches"
            body = SwitchesBody(
                transcription: transcription, ai: ai, engine: engine, openAppAfterMinutes: openAppAfterMinutes)
        case .vocabulary(let terms):
            path = "vocabulary"
            body = ["terms": terms]
        case .playbackQuiet(let from, let to):
            (method, path) = ("POST", "quiet-ranges")
            body = QuietBody(id: lower(id), startedAt: from, endedAt: to)
        }
        return (method, path, try body.map { try ServerClient.encode($0) })
    }

    private struct SwitchesBody: Encodable {
        var transcription: Bool?
        var ai: Bool?
        var engine: ServerClient.Switches.Engine?
        var openAppAfterMinutes: Int?
    }

    private struct QuietBody: Encodable {
        var id: String
        var startedAt: Date
        var endedAt: Date
        var source = "playback"
    }
}

private func lower(_ id: UUID) -> String { id.uuidString.lowercased() }

/// One edit in the outbox.
public struct OutboxEntry: Sendable, Equatable {
    public var id: UUID
    public var intent: OwnerIntent
    /// When the owner made it: the edit's `editedAt`.
    public var createdAt: Date
    /// The server's message when it refused this edit (`ServerClient.refuses`); `nil` while it waits.
    public var refused: String?

    public init(id: UUID = UUID(), intent: OwnerIntent, createdAt: Date = .now, refused: String? = nil) {
        self.id = id
        self.intent = intent
        self.createdAt = createdAt
        self.refused = refused
    }
}

/// The outbox, in `library.sqlite`: durable, in the order the edits were made.
extension LibraryStore {
    /// Queues an edit under `id`. The same id twice is one edit.
    public func enqueue(_ intent: OwnerIntent, id: UUID = UUID(), at now: Date = .now) throws {
        try db.run(
            "INSERT OR IGNORE INTO outbox (id, intent, created_ms) VALUES (?1, ?2, ?3)",
            [.text(id.uuidString), .blob(try JSONEncoder().encode(intent)), .int(CaptureInstant(now).millis)])
    }

    /// Every queued edit in order, refused ones included until the owner dismisses them. One this app can't read is
    /// left out and reported (`UndecodableRow`).
    public func outbox() throws -> [OutboxEntry] {
        try db.query("SELECT id, intent, created_ms, refused FROM outbox ORDER BY seq") { row -> OutboxEntry? in
            do {
                return OutboxEntry(
                    id: UUID(uuidString: row.text(0)) ?? UUID(),
                    intent: try JSONDecoder().decode(OwnerIntent.self, from: row.blob(1)),
                    createdAt: CaptureInstant(millis: row.int(2)).date, refused: row.isNull(3) ? nil : row.text(3))
            } catch {
                report(UndecodableRow(kind: "outbox", key: row.text(0), error: error))
                return nil
            }
        }.compactMap(\.self)
    }

    /// The server answered: accepted (`refused` nil) leaves the outbox; refused stays, with the server's message.
    public func settle(_ id: UUID, refused: String?) throws {
        if let refused {
            try db.run("UPDATE outbox SET refused = ?2 WHERE id = ?1", [.text(id.uuidString), .text(refused)])
        } else {
            try dismiss(id)
        }
    }

    /// The owner saw a refused edit, or took back one still waiting: it goes. Returns whether it was there.
    @discardableResult
    public func dismiss(_ id: UUID) throws -> Bool {
        try db.run("DELETE FROM outbox WHERE id = ?1", [.text(id.uuidString)]) > 0
    }

    /// The outbox as screens show it.
    public func pendingEdits() throws -> PendingEdits { PendingEdits(try outbox()) }
}

/// The owner's edits the server hasn't accepted yet, as screens show them at once: a switch or the word list waits with a "waiting to sync" mark. A refused one is shown with the server's message and
/// is no longer applied: the screen rolls back to what the feed says.
public struct PendingEdits: Sendable, Equatable {
    /// Waiting, oldest first.
    public var waiting: [OutboxEntry]
    /// Refused by the server, with its message, until the owner dismisses them.
    public var refused: [OutboxEntry]

    public init(_ outbox: [OutboxEntry]) {
        waiting = outbox.filter { $0.refused == nil }
        refused = outbox.filter { $0.refused != nil }
    }

    private var intents: [OwnerIntent] { waiting.map(\.intent) }

    /// The word list waiting for the server, the latest whole; `nil` when none waits.
    public var vocabulary: [String]? {
        intents.reversed().lazy.compactMap { if case .vocabulary(let terms) = $0 { terms } else { nil } }.first
    }

    /// The feed's switches with the waiting changes applied, in order; `nil` until the feed said.
    public func switches(over feed: ServerClient.Switches?) -> ServerClient.Switches? {
        intents.reduce(feed) { shown, intent in
            guard var shown, case .switches(let transcription, let ai, let engine, let openAppAfter) = intent else {
                return shown
            }
            shown.transcription = transcription ?? shown.transcription
            shown.ai = ai ?? shown.ai
            shown.engine = engine ?? shown.engine
            shown.openAppAfterMinutes = openAppAfter ?? shown.openAppAfterMinutes
            return shown
        }
    }
}
