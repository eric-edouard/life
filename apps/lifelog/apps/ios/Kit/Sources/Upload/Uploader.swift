import AudioPipeline
import Foundation
import Library
import ServerAPI
import SourceStore
import Timeline

/// Sends the phone's part to the server: speech fragments, then timeline facts with how far the speech went
/// (`sentThrough`). The server decides blocks from them (docs/timeline.md, "Fragments and blocks"); the phone keeps one
/// cursor. The app's driver runs one pass at a time: on each Bluetooth sync that saved audio, on the server's silent
/// push, in the background task and in the foreground.
///
/// One rule decides what goes up: kept speech on every page the server doesn't hold, across the whole archive. Below
/// the cursor (`nextPage`) every page is with the server or has nothing to send. Past it, the server's pages
/// (`GET /sources/{id}/blocks`, read when the cursor moves back or a fragment is refused) are sent around. A page goes in
/// one fragment: the server refuses a page it holds (409 `held`), and the same pages and audio sent again answer the
/// same fragment, so a crash between the upload and the cursor's save sends nothing twice.
///
/// It reads the source store and never writes it: nothing here can feed `PageSink.ackableIndex`. Its state is in
/// `upload.sqlite`: the cursor and the heard-through it last said. `upload/` stays out of iCloud backups, so a restore
/// or a new phone starts over as a reinstall does: from the page holding the server's `sentThrough`, the server's pages
/// sent around (`restore`). Until the handover it does nothing.
public actor Uploader {
    public struct Configuration: Sendable {
        /// Spans per timeline request.
        public var spansPerRequest = 200
        /// A failed fragment waits this long before the next run may retry it.
        public var retryMillis: Int64 = 30_000
        /// Fragment renders start no new one past this much time in a run, so the edits and the feed never wait long
        /// behind a backlog.
        public var budget: Duration = .seconds(60)

        public init() {}
    }

    let source: SourceStore
    let scanner: TimelineScanner
    let client: ServerClient
    let db: SQLite
    let prepared: URL
    let configuration: Configuration
    /// In the background a render is followed by a rest as long as it took, so the loop stays near half a core: iOS
    /// kills a background app that holds the CPU (back-to-back Opus encodes did).
    let inBackground: @Sendable () -> Bool
    let canRunHeavyWork: @Sendable () -> Bool
    let rest: @Sendable (Duration) async throws -> Void
    /// Hears `upload.sent` for each fragment that goes up.
    let event: AppEvent
    /// The old pipeline's completed jobs, read once (`oldJobs`).
    var completedParts: [OldJob]?
    /// The pages the server holds, as last read; `nil` until read, and again once the cursor moves back or a fragment
    /// is refused.
    var held: IndexSet?
    /// Kept speech past the cursor as the last pass measured it, and the `sentThrough` last said.
    var unsentSpeech = Duration.zero
    /// What stopped the last run, other than the network or a cancellation: shown until a run ends.
    var runError: String?
    var saidSentThrough: CaptureInstant?
    /// The last fragment's failure, other than the network's, and its tries at `cursor`: it waits until `retryAt`.
    var failure: (message: String, attempts: Int, retryAt: ContinuousClock.Instant, cursor: UInt64)?

    /// - Parameter directory: where `upload.sqlite` and the renders on their way live; kept out of backups.
    public init(
        source: SourceStore, scanner: TimelineScanner, client: ServerClient, directory: URL,
        configuration: Configuration = .init(),
        inBackground: @escaping @Sendable () -> Bool = { false },
        canRunHeavyWork: @escaping @Sendable () -> Bool = DerivedAudioWorker.deviceAllowsHeavyWork,
        rest: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        event: @escaping AppEvent = { _, _ in }
    ) throws {
        self.source = source
        self.scanner = scanner
        self.client = client
        self.configuration = configuration
        self.inBackground = inBackground
        self.canRunHeavyWork = canRunHeavyWork
        self.rest = rest
        self.event = event
        // Renders are rebuilt when needed: what a crash left goes.
        prepared = directory.appending(path: "fragments", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: prepared)
        try FileManager.default.createDirectory(at: prepared, withIntermediateDirectories: true)
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        db = try SQLite(path: directory.appending(path: "upload.sqlite").path)
        try db.migrate(Self.migrations, tooNew: UploadError.unknownSchemaVersion)
    }

    var deviceID: String { scanner.deviceID }

    // MARK: Runs

    /// One pass: fragments, then the timeline. `savedThrough`: all audio the Pendant captured before it is on the phone
    /// (`FactsBuilder.savedThrough`, read before this pass). The Mac's word is the server's to wait for
    /// (`docs/processing.md`).
    public func run(savedThrough: Date?) async throws {
        do {
            try await pass(savedThrough: savedThrough)
            runError = nil
        } catch {
            switch error {
            case _ where error.isOfflineOrCancelled, ServerClient.ClientError.notPaired: break
            case ServerClient.ClientError.server(_, _, let text): runError = text
            case let error as ServerClient.ClientError: runError = "\(error)"
            default: runError = error.localizedDescription
            }
            throw error
        }
    }

    private func pass(savedThrough: Date?) async throws {
        var state = try state()
        if state == nil { state = try await restore() }
        guard var state else { return }
        let timeline = try await scanner.scan(cursor: state.nextPage)
        // A page stored below the cursor (a late drain, a held page repaired) is sent too.
        if let stored = timeline.storedFrom {
            if stored < state.nextPage { try rewind(to: stored, &state) }
            try await scanner.storedSeen(from: stored)
        }
        let heard = FactsBuilder.heardThrough(
            savedThrough: savedThrough.map(CaptureInstant.init),
            newestStored: try await timeline.audioEnd(atOrBefore: CaptureInstant(millis: .max)),
            unanalyzedFrom: timeline.unanalyzedFrom, sent: state.heardThrough)
        let unsent = try await sendSpeech(timeline, heardThrough: heard, state: &state)
        try await sendTimeline(timeline, heard: heard, sentThrough: unsent ?? heard, state: &state)
    }

    /// The speech the server doesn't have yet and why the last fragment failed. `nil` before the cutover.
    public func status() throws -> UploadStatus? {
        guard try state() != nil else { return nil }
        return UploadStatus(unsent: unsentSpeech, lastError: failure?.message ?? runError)
    }

    /// The audio overlapping `range` the server doesn't have yet: the stored audio from the cursor on.
    public func unsent(overlapping range: Range<CaptureInstant>) async throws -> [Range<CaptureInstant>] {
        guard let state = try state() else { return [] }
        let timeline = try await scanner.timeline()
        guard let start = try await timeline.start(ofPage: state.nextPage), start < range.upperBound,
            let end = try await timeline.audioEnd(atOrBefore: CaptureInstant(millis: .max)), start < end,
            end > range.lowerBound
        else { return [] }
        return [start..<end]
    }

    /// Fragments and queued jobs the server withdrew, by source and first page (the feed's removed jobs: a quiet range
    /// touched one before its block closed): the cursor moves back to the first of this source's, so their pages go
    /// again with the range cut out. No request, so the network dropping after the feed's page can't lose it.
    public func withdrawn(_ rows: [(sourceId: String, firstPage: UInt64)]) throws {
        guard let first = rows.filter({ $0.sourceId == deviceID }).map(\.firstPage).min(), var state = try state()
        else { return }
        try rewind(to: first, &state)
    }

    /// The cursor moves back to `page`; the server's pages past it are read again before the next fragment, even when
    /// the cursor is already below it (a withdrawn fragment's pages are free again).
    private func rewind(to page: UInt64, _ state: inout State) throws {
        held = nil
        guard page < state.nextPage else { return }
        state.nextPage = page
        try save(state)
    }

    // MARK: Fragments

    /// Sends kept speech from the cursor on as fragments (`SpeechFragment.next`), through the analyzed audio, around the
    /// server's pages, an hour of capture read at a time. A stretch with nothing to send moves the cursor past it. No
    /// render starts past `budget`, nor while a failure waits its backoff; offline stops the run until the next
    /// trigger. Returns where the first kept second not sent starts (`nil`: none waits), and measures the speech
    /// waiting from there in the window it stopped in.
    private func sendSpeech(_ timeline: TimelineSnapshot, heardThrough: CaptureInstant?, state: inout State)
        async throws -> CaptureInstant?
    {
        guard let end = try await analyzedEnd(timeline) else {
            unsentSpeech = .zero
            return nil
        }
        let deadline = ContinuousClock.now + configuration.budget
        var span = Self.windowMillis
        var refused: UInt64?
        while let from = try await timeline.start(ofPage: state.nextPage), from < end {
            try Task.checkCancellation()
            let cursor = state.nextPage
            let held = try await heldPages()
            let until = min(from.advanced(by: span), end)
            let all = try await timeline.spans(overlapping: from..<until).flatMap(\.runs)
            // Whole pages only: one still playing at the window's end waits for a wider window.
            let open = Set(all.filter { $0.end > until }.map(\.page))
            let complete = all.filter { !open.contains($0.page) }
            let whole = complete.map(\.end).max() ?? from
            // Kept audio a little past the last whole page, so speech going on across its end is seen as such; every
            // held page read, open ones too, is taken out of it.
            let reach = min(whole.advanced(by: 10_000), end)
            let free = SpeechFragment.unheld(
                kept: from < reach ? try await timeline.kept(in: from..<reach) : [], runs: all
            ) { $0 < cursor || held.contains(Int($0)) }
            let runs = free.runs.filter { !open.contains($0.page) }
            // Where this pass stops: the speech of this window waits.
            func waiting() -> CaptureInstant? {
                unsentSpeech = .milliseconds(free.kept.reduce(0) { $0 + $1.millis })
                return free.kept.first?.lowerBound
            }
            let speech = try await timeline.windows(overlapping: [from..<whole]).speech()
            if let fragment = SpeechFragment.next(
                kept: free.kept, runs: runs, speech: speech, heardThrough: heardThrough)
            {
                if !fragment.segments.isEmpty {
                    guard canRunHeavyWork(), ContinuousClock.now < deadline, (failure?.retryAt ?? .now) <= .now
                    else { return waiting() }
                    switch try await send(fragment, cursor: cursor, timeline: timeline) {
                    case .sent: break
                    case .failed: return waiting()
                    case .skipped: break
                    case .held:
                        // Read the server's pages again and render without them; refused twice, it waits.
                        guard refused != cursor else {
                            fail(fragment, cursor: cursor, status: 409, "the server holds pages it doesn't list")
                            return waiting()
                        }
                        refused = cursor
                        continue
                    }
                }
                state.nextPage = fragment.last + 1
                try save(state)
                span = Self.windowMillis
            } else if free.kept.isEmpty, let last = complete.map(\.page).max(), last + 1 > state.nextPage {
                state.nextPage = last + 1
                try save(state)
                span = Self.windowMillis
            } else if until == end {
                return waiting()
            } else {
                span += Self.windowMillis
            }
        }
        unsentSpeech = .zero
        return nil
    }

    /// How much capture `sendSpeech` reads at once: a backlog of weeks goes in linear time and little memory.
    static let windowMillis: Int64 = 3_600_000

    private enum Outcome {
        case sent, held, failed, skipped
    }

    /// Renders and puts one fragment.
    private func send(_ fragment: SpeechFragment, cursor: UInt64, timeline: TimelineSnapshot) async throws -> Outcome {
        let started = ContinuousClock.now
        let firstPage = fragment.pages.first?.lowerBound ?? fragment.last
        let url = prepared.appending(path: "\(firstPage).ogg")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            guard let map = TimeMap(segments: fragment.segments) else { throw UploadError.emptyFragment(firstPage) }
            let range = map.segments[0].lowerBound..<map.segments[map.segments.count - 1].upperBound
            let audio = SourceAudio(
                store: source, deviceID: deviceID, spans: try await timeline.spans(overlapping: range))
            let file = try await PreparedAudio.render(map, from: audio, to: url)
            try await client.putSpeech(
                source: deviceID, firstPage: firstPage, audio: url,
                metadata: .init(
                    pages: fragment.pages.map { [$0.lowerBound, $0.upperBound] }, map: .init(segments: map.segments),
                    audioSha256: file.sha256, durationSeconds: Double(file.durationMillis) / 1000))
            failure = nil
            // The latency `bun run events upload` reads: from the fragment's last kept second to the server.
            event(
                "upload.sent",
                [
                    "firstPage": "\(firstPage)", "pages": "\(fragment.pages.reduce(0) { $0 + $1.count })",
                    "audioMs": "\(file.durationMillis)", "ms": "\(started.duration(to: .now).millis)",
                    "sinceLastKeptMs": "\(CaptureInstant(Date.now).millis - range.upperBound.millis)",
                ])
        } catch ServerClient.ClientError.server(409, "held"?, _) {
            held = nil
            return .held
        } catch let error as URLError where error.isTransient {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // A refusal of this fragment itself (`ServerClient.refuses`), or a render that fails here, is skipped after
            // three tries so the speech after it goes; an outage (5xx), the token or the network blocks.
            let status: Int?
            let skippable: Bool
            var message = "\(error)"
            switch error {
            case ServerClient.ClientError.server(let code, _, let text):
                (status, message) = (code, text)
                skippable = ServerClient.refuses(code)
            case is URLError, is ServerClient.ClientError:
                (status, skippable) = (nil, false)
            default:
                (status, skippable) = (nil, true)
            }
            fail(fragment, cursor: cursor, status: status, message)
            guard skippable, let failure, failure.attempts >= Self.attemptsBeforeSkip else { return .failed }
            self.failure = nil
            event(
                "upload.skipped",
                ["firstPage": "\(firstPage)", "last": "\(fragment.last)", "pages": "\(fragment.pages)", "why": message])
            return .skipped
        }
        if inBackground() { try await rest(started.duration(to: .now)) }
        return .sent
    }

    /// Tries of one fragment the server refuses for itself before it is skipped.
    static let attemptsBeforeSkip = 3

    /// A failed fragment waits the same interval each time, so a recovered connection can drain its backlog promptly.
    private func fail(_ fragment: SpeechFragment, cursor: UInt64, status: Int?, _ message: String) {
        let attempts = failure?.cursor == cursor ? (failure?.attempts ?? 0) + 1 : 1
        failure = (message, attempts, .now + .milliseconds(configuration.retryMillis), cursor)
        event(
            "upload.failed",
            [
                "firstPage": "\(fragment.pages.first?.lowerBound ?? fragment.last)", "last": "\(fragment.last)",
                "status": status.map(String.init) ?? "", "message": message,
            ])
    }

    /// The pages the server holds, read once until the cursor moves back or a fragment is refused.
    private func heldPages() async throws -> IndexSet {
        if let held { return held }
        return take(try await client.blocks(source: deviceID))
    }

    /// Keeps the server's pages as `held`.
    @discardableResult
    private func take(_ server: ServerClient.SourceBlocks) -> IndexSet {
        var pages = IndexSet()
        for range in server.blocks.flatMap(\.ranges) {
            pages.insert(integersIn: Int(range.lowerBound)...Int(range.upperBound))
        }
        held = pages
        return pages
    }

    /// Where the stored audio the analyzers reached ends.
    private func analyzedEnd(_ timeline: TimelineSnapshot) async throws -> CaptureInstant? {
        guard let end = try await timeline.audioEnd(atOrBefore: CaptureInstant(millis: .max)) else { return nil }
        return min(end, timeline.unanalyzedFrom ?? end)
    }

    // MARK: Timeline

    /// Sends the spans owed (`factsFrom` on) in batches, with how far the phone has heard and sent. Each batch sent
    /// moves `factsFrom` past it.
    private func sendTimeline(
        _ timeline: TimelineSnapshot, heard: CaptureInstant?, sentThrough: CaptureInstant?, state: inout State
    ) async throws {
        guard let heard else { return }
        var from = timeline.factsFrom
        var moved = heard != state.heardThrough || sentThrough != saidSentThrough
        let pauses = TimelineScanner.pauses(try await source.recordingChanges(deviceID: deviceID))
        while moved || from != nil {
            var spans: [CaptureSpan] = []
            if let from {
                spans = try await timeline.spans(
                    overlapping: from..<CaptureInstant(millis: .max), limit: configuration.spansPerRequest)
            }
            var after: CaptureInstant?
            if let first = spans.first { after = try await timeline.audioEnd(atOrBefore: first.interval.lowerBound) }
            let facts = FactsBuilder.spans(
                spans, windows: try await timeline.windows(overlapping: spans.map(\.interval)), pauses: pauses,
                after: after)
            try await client.putTimeline(
                source: deviceID, TimelineFacts(heardThrough: heard.date, sentThrough: sentThrough?.date, spans: facts))
            state.heardThrough = heard
            try save(state)
            saidSentThrough = sentThrough
            moved = false
            if let start = from {
                let through = spans.count == configuration.spansPerRequest ? spans.last?.interval.upperBound : nil
                try await scanner.factsSent(from: start, through: through)
                from = through
            }
        }
    }

    /// Where the uploader starts, once the server holds the handover: after a reinstall, a restore or a new phone. The
    /// cursor and the timeline start at the page holding the server's `sentThrough`, the last install's word: before
    /// it everything was sent or decided, so its derived files (kept out of backups, lost with the old phone) are never
    /// read. Without one, from the first page, the server's pages sent around. `nil` before the handover.
    private func restore() async throws -> State? {
        let server = try await client.blocks(source: deviceID)
        guard server.handedOver else { return nil }
        take(server)
        let timeline = try await scanner.scan()
        let sent = server.sentThrough.map(CaptureInstant.init) ?? CaptureInstant(millis: .min)
        let spans = try await timeline.spans(overlapping: sent..<CaptureInstant(millis: .max))
        let first = spans.lazy.flatMap(\.runs).first { $0.end > sent }
        // Nothing stored here reaches it yet: wait, rather than start below it.
        if first == nil, server.sentThrough != nil { return nil }
        // A page stored late below it was the last install's to send: the marker would rewind the cursor to it.
        if let stored = timeline.storedFrom { try await scanner.storedSeen(from: stored) }
        // The facts of a span begun before it are the last install's: sent again, they would read its lost files.
        try await scanner.startFacts(from: spans.first { $0.interval.lowerBound >= sent }?.interval.lowerBound)
        let state = State(nextPage: first?.page ?? 0)
        try save(state)
        return state
    }

    // MARK: State

    /// Where one source stands. Below `nextPage` every page is with the server or has nothing to send.
    struct State: Equatable {
        var nextPage: UInt64
        var heardThrough: CaptureInstant?
    }

    func state() throws -> State? {
        try db.query("SELECT next_page, heard_through_ms FROM sources WHERE source_id = ?1", [.text(deviceID)]) {
            State(nextPage: UInt64($0.int(0)), heardThrough: $0.isNull(1) ? nil : CaptureInstant(millis: $0.int(1)))
        }.first
    }

    private func save(_ state: State) throws {
        try db.run(
            "INSERT OR REPLACE INTO sources (source_id, next_page, heard_through_ms) VALUES (?1, ?2, ?3)",
            [.text(deviceID), .int(Int64(state.nextPage)), state.heardThrough.map { .int($0.millis) } ?? .null])
    }

    /// Forward-only. Append a new entry for every schema change; never edit a shipped one.
    static let migrations = [
        // `backup`: what the raw backup sent, by kind (`pack`, `snapshot`, `job`) and name (`Uploader+Backup.swift`).
        """
        CREATE TABLE sources (
            source_id TEXT PRIMARY KEY,
            next_page INTEGER NOT NULL,
            heard_through_ms INTEGER
        ) WITHOUT ROWID;
        CREATE TABLE blocks (
            source_id TEXT NOT NULL,
            first_page INTEGER NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            owing INTEGER NOT NULL,
            json BLOB NOT NULL,
            PRIMARY KEY (source_id, first_page)
        ) WITHOUT ROWID;
        CREATE INDEX blocks_start ON blocks (source_id, start_ms);
        CREATE INDEX blocks_end ON blocks (source_id, end_ms);
        CREATE TABLE backup (
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            sha256 TEXT,
            outcome TEXT NOT NULL,
            at_ms INTEGER NOT NULL,
            PRIMARY KEY (kind, name)
        ) WITHOUT ROWID;
        """,
        // The server cuts the blocks: the cursor moves back to the first block never sent, whose pages go up as
        // fragments. Blocks with a job are held on the server; covered ones (bought already, or from before the
        // Mac's first quiet range) stay behind the cursor. The jobs' first pages are kept, so a queued one the server
        // withdraws later still sends its pages again.
        """
        UPDATE sources SET next_page = MIN(next_page, COALESCE((
            SELECT MIN(b.first_page) FROM blocks b
            WHERE b.source_id = sources.source_id AND json_extract(CAST(b.json AS TEXT), '$.jobID') IS NULL
            AND COALESCE(json_extract(CAST(b.json AS TEXT), '$.covered'), 0) = 0
        ), next_page));
        CREATE TABLE fragments (
            source_id TEXT NOT NULL,
            id TEXT NOT NULL,
            first_page INTEGER NOT NULL,
            at_ms INTEGER NOT NULL,
            PRIMARY KEY (source_id, id)
        ) WITHOUT ROWID;
        INSERT OR IGNORE INTO fragments
        SELECT source_id, json_extract(CAST(json AS TEXT), '$.jobID'), first_page,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM blocks WHERE json_extract(CAST(json AS TEXT), '$.jobID') IS NOT NULL;
        DROP TABLE blocks;
        """,
        // The feed's removal of a withdrawn fragment carries its first page.
        "DROP TABLE fragments;",
        // Oct 23: a handover before the server's `sentThrough` started the cursor at page 0, below derived files a new
        // phone doesn't have; such an install hands over again once, from `sentThrough` (`restore`).
        "DELETE FROM sources WHERE next_page = 0;",
    ]
}

/// Where uploads stand (`Uploader.status`).
public struct UploadStatus: Sendable, Equatable {
    /// Kept speech stored here the server doesn't have yet.
    public var unsent: Duration
    /// Why speech isn't going, other than the network: the last fragment's failure, or what stopped the last run. The
    /// next run tries again.
    public var lastError: String?

    public init(unsent: Duration = .zero, lastError: String? = nil) {
        self.unsent = unsent
        self.lastError = lastError
    }
}

public enum UploadError: Error, Equatable {
    /// `upload.sqlite` was written by a newer app. Fail closed.
    case unknownSchemaVersion(Int)
    /// A fragment with no audio to render: never cut that way.
    case emptyFragment(UInt64)
}
