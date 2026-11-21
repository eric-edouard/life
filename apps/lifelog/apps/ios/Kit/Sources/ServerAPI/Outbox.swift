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

/// Something the owner did that the server must apply: the switches, the vocabulary, a quiet range of this phone.
public enum OwnerIntent: Sendable, Equatable, Codable {
    /// The owner turns transcription on or off, or sets when the server asks him to open the app; `nil` leaves one as
    /// it is. (`ai` and `engine` are the server's own: no screen writes them.)
    case switches(transcription: Bool? = nil, openAppAfterMinutes: Int? = nil)
    /// The owner's whole word list (people's names are the server's own).
    case vocabulary([String])
    /// A stretch this app played a recording out loud, padded: never transcription. Its id is the edit's.
    case playbackQuiet(from: Date, to: Date)
    /// A stretch the owner dictated to this phone, padded, in capture time: the phone drops the Pendant's audio of it
    /// (#802), and the server's copy brings it back to a reinstalled phone through the feed. Its id is the edit's.
    case dictationQuiet(from: Date, to: Date)

    /// The request it becomes. `id` is the edit's uuid (a playback range's id); `at`, when the
    /// owner made it.
    func request(id: UUID, at: Date) throws -> (method: String, path: String, body: Data?) {
        var method = "PUT"
        let path: String
        let body: (any Encodable)?
        switch self {
        case .switches(let transcription, let openAppAfterMinutes):
            path = "switches"
            body = SwitchesBody(transcription: transcription, openAppAfterMinutes: openAppAfterMinutes)
        case .vocabulary(let terms):
            path = "vocabulary"
            body = ["terms": terms]
        case .playbackQuiet(let from, let to):
            (method, path) = ("POST", "quiet-ranges")
            body = QuietBody(id: lower(id), startedAt: from, endedAt: to, source: "playback")
        case .dictationQuiet(let from, let to):
            (method, path) = ("POST", "quiet-ranges")
            body = QuietBody(id: lower(id), startedAt: from, endedAt: to, source: "dictation")
        }
        return (method, path, try body.map { try ServerClient.encode($0) })
    }

    private struct SwitchesBody: Encodable {
        var transcription: Bool?
        var openAppAfterMinutes: Int?
    }

    private struct QuietBody: Encodable {
        var id: String
        var startedAt: Date
        var endedAt: Date
        var source: String
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
    /// reported once (`UndecodableRow`) and deleted, on purpose: builds only move forward, so it is a kind of edit an
    /// older build queued and this one no longer makes, which nothing could ever send.
    public func outbox() throws -> [OutboxEntry] {
        var unreadable: [String] = []
        let entries = try db.query("SELECT id, intent, created_ms, refused FROM outbox ORDER BY seq") {
            row -> OutboxEntry? in
            do {
                return OutboxEntry(
                    id: UUID(uuidString: row.text(0)) ?? UUID(),
                    intent: try JSONDecoder().decode(OwnerIntent.self, from: row.blob(1)),
                    createdAt: CaptureInstant(millis: row.int(2)).date, refused: row.isNull(3) ? nil : row.text(3))
            } catch {
                report(UndecodableRow(kind: "outbox", key: row.text(0), error: error))
                unreadable.append(row.text(0))
                return nil
            }
        }.compactMap(\.self)
        for id in unreadable {
            try db.run("DELETE FROM outbox WHERE id = ?1", [.text(id)])
        }
        return entries
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
    /// Every edit, refused ones included, in the order made.
    public let entries: [OutboxEntry]

    public init(_ outbox: [OutboxEntry]) { entries = outbox }

    /// Waiting, oldest first.
    public var waiting: [OutboxEntry] { entries.filter { $0.refused == nil } }
    /// Refused by the server, with its message, until the owner dismisses them.
    public var refused: [OutboxEntry] { entries.filter { $0.refused != nil } }

    private var intents: [OwnerIntent] { waiting.map(\.intent) }

    /// The word list waiting for the server, the latest whole; `nil` when none waits.
    public var vocabulary: [String]? {
        intents.reversed().lazy.compactMap { if case .vocabulary(let terms) = $0 { terms } else { nil } }.first
    }

    /// The feed's switches with the waiting changes applied, in order; `nil` until the feed said.
    public func switches(over feed: ServerClient.Switches?) -> ServerClient.Switches? {
        intents.reduce(feed) { shown, intent in
            guard var shown, case .switches(let transcription, let openAppAfter) = intent else { return shown }
            shown.transcription = transcription ?? shown.transcription
            shown.openAppAfterMinutes = openAppAfter ?? shown.openAppAfterMinutes
            return shown
        }
    }
}

/// A value the server holds, as a screen says it: never shown as known before the server said.
public enum ServerValue<T: Sendable & Equatable>: Sendable, Equatable {
    /// The feed never said: a spinner, never a default.
    case asking
    case known(T)
    /// His change shows at once, waiting for the server.
    case saving(T)
    /// The server refused his newest change: the value is the one shown (rolled back).
    case refused(T, message: String)

    /// What to draw: the value, or nil while asking.
    public var shown: T? {
        switch self {
        case .asking: nil
        case .known(let value), .saving(let value), .refused(let value, _): value
        }
    }
}

/// A switch the phone writes: where it lives in the server's `Switches`, and whether an intent writes it.
public struct SwitchField<T: Sendable & Equatable>: Sendable {
    let read: @Sendable (ServerClient.Switches) -> T
    let isWrittenBy: @Sendable (OwnerIntent) -> Bool

    public static var transcription: SwitchField<Bool> {
        .init(read: { $0.transcription }, isWrittenBy: { if case .switches(.some, _) = $0 { true } else { false } })
    }
    public static var openAppAfterMinutes: SwitchField<Int> {
        .init(
            read: { $0.openAppAfterMinutes }, isWrittenBy: { if case .switches(_, .some) = $0 { true } else { false } })
    }
}

/// A switch's state: the value `switches(over:)` shows, and where it stands. The newest edit touching the field decides.
public func serverValue<T>(_ field: SwitchField<T>, feed: ServerClient.Switches?, pending: PendingEdits) -> ServerValue<
    T
> {
    guard let shown = pending.switches(over: feed) else { return .asking }
    return state(of: field.read(shown), newest: pending.entries.last { field.isWrittenBy($0.intent) })
}

/// The word list's state, the same way.
public func serverVocabulary(feed: [String]?, pending: PendingEdits) -> ServerValue<[String]> {
    guard let shown = pending.vocabulary ?? feed else { return .asking }
    return state(of: shown, newest: pending.entries.last { if case .vocabulary = $0.intent { true } else { false } })
}

private func state<T>(of value: T, newest: OutboxEntry?) -> ServerValue<T> {
    guard let newest else { return .known(value) }
    guard let message = newest.refused else { return .saving(value) }
    return .refused(value, message: message)
}
