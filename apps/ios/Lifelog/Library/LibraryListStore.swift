import Foundation
import Library
import Observation
import ServerAPI
import Timeline

struct LibrarySection: Identifiable, Equatable {
    /// Local midnight.
    var day: Date
    var rows: [ConversationRow]
    /// Wordless recordings and dictation to the Mac that day: one line, opened on demand.
    var quiet: [ConversationRow] = []

    var id: Date { day }
}

/// Library feature store: the conversations the cache holds, paged by day with the audio not uploaded yet among them,
/// multi-select and the owner's merge; its search is `LibrarySearch`. It reads the library's cache and the outbox only
/// (docs/architecture.md, "Local first"), and reads the loaded rows again whenever the driver changed them
/// (`SyncStore.generation`).
@Observable
final class LibraryListStore {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    /// This week's conversations and their length. Equatable, so a publish that changes nothing notifies no one.
    struct Week: Equatable {
        var count: Int
        var duration: Duration
    }

    private(set) var phase = Phase.loading
    private(set) var sections: [LibrarySection] = []
    private(set) var isComplete = false
    /// Conversations this calendar week, once the loaded list reaches back past its start.
    private(set) var thisWeek: Week?
    /// Set after a date jump: the list starts at the end of that day.
    private(set) var jumpedTo: Date?
    var selection: Set<UUID> = []
    /// A merge that couldn't be kept, for the owner to read.
    var actionError: String?

    @ObservationIgnored let library: LibraryStore
    @ObservationIgnored let sync: SyncStore?
    @ObservationIgnored let meaningSearch: (@Sendable (String) async throws -> [MeaningHit])?
    /// The conversations loaded so far, newest first.
    @ObservationIgnored private var loaded: [CachedConversation] = []
    @ObservationIgnored private var start: CaptureInstant?
    @ObservationIgnored private var isLoadingPage = false
    /// A reload asked for while a page loaded: it runs once that page is in.
    @ObservationIgnored private var reloadOwed = false
    private static let pageSize = 30

    /// `meaningSearch` defaults to the server's; without it search matches words only.
    init(
        library: LibraryStore, sync: SyncStore?,
        meaningSearch: (@Sendable (String) async throws -> [MeaningHit])? = { query in
            try await ServerClient.production.search(query)
        }
    ) {
        self.library = library
        self.sync = sync
        self.meaningSearch = meaningSearch
    }

    /// Conversations loaded so far.
    var loadedCount: Int { loaded.count }

    /// Two conversations selected next to each other: the stretch a merge keeps together.
    var mergeRange: (from: Date, to: Date)? {
        let rows = sections.flatMap(\.rows).filter { !$0.isLocal }
        let indices = rows.indices.filter { selection.contains(rows[$0].id) }
        guard indices.count == 2, indices[1] == indices[0] + 1, !indices.contains(where: { rows[$0].isImported })
        else { return nil }
        // Newest first: the later index is the older conversation.
        return (rows[indices[1]].start, rows[indices[0]].end)
    }

    /// Oldest first, for export.
    var selectedIDs: [UUID] {
        sections.flatMap(\.rows).filter { selection.contains($0.id) && !$0.isLocal }.sorted { $0.start < $1.start }
            .map(\.id)
    }

    // MARK: Paging

    /// The next page, once the list shows its end.
    func loadMore() async {
        guard !isComplete, !isLoadingPage else { return }
        isLoadingPage = true
        do {
            let page = try await library.conversations(
                before: loaded.last.map { CaptureInstant($0.startAt) } ?? start, limit: Self.pageSize)
            loaded += page
            isComplete = page.count < Self.pageSize
            if !reloadOwed { await publish() }
        } catch {
            phase = .failed(report(error))
        }
        isLoadingPage = false
        if reloadOwed { await reload() }
    }

    /// Reads everything loaded again: the driver applied the feed, or the owner edited.
    func reload() async {
        guard !isLoadingPage else {
            reloadOwed = true
            return
        }
        reloadOwed = false
        isLoadingPage = true
        do {
            let limit = max(loaded.count, Self.pageSize)
            loaded = try await library.conversations(before: start, limit: limit)
            isComplete = loaded.count < limit
            if !reloadOwed { await publish() }
        } catch {
            phase = .failed(report(error))
        }
        isLoadingPage = false
        if reloadOwed { return await reload() }
    }

    /// Starts the list at the end of `day`; `nil` goes back to the newest.
    func jump(to day: Date?) async {
        let end = day.flatMap {
            Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: $0))
        }
        start = end.map { CaptureInstant($0) }
        jumpedTo = day
        loaded = []
        isComplete = false
        selection = []
        phase = .loading
        // A reload, so a page still loading for the old start is read again after it, never shown.
        await reload()
    }

    private func publish() async {
        let facts = (try? await library.facts(of: loaded)) ?? [:]
        // Audio the server has no conversation for, where the loaded list reaches.
        let oldest = isComplete ? Date.distantPast : loaded.last?.startAt ?? .distantFuture
        let newest = start?.date ?? .distantFuture
        let reach =
            CaptureInstant(
                min(oldest, loaded.last?.startAt ?? oldest))..<CaptureInstant(
                max(newest, loaded.map(\.endAt).max() ?? newest))
        let unsent = reach.isEmpty ? [] : await sync?.unsent(overlapping: reach) ?? []
        var rows = loaded.map { row($0, facts: facts[$0.id], unsent: unsent) }
        for range in ConversationState.notUploaded(unsent, between: loaded.map(\.range))
        where range.lowerBound.date >= oldest && range.lowerBound.date < newest && range.millis >= 1_000 {
            rows.append(ConversationRow(local: range))
        }
        let quiet =
            oldest < newest
            ? (try? await library.quietConversations(in: CaptureInstant(oldest)..<CaptureInstant(newest))) ?? [] : []
        let calendar = Calendar.current
        let byDay = Dictionary(grouping: rows) { calendar.startOfDay(for: $0.start) }
        let quietByDay = Dictionary(grouping: quiet.map(ConversationRow.init(quiet:))) {
            calendar.startOfDay(for: $0.start)
        }
        self.sections = Set(byDay.keys).union(quietByDay.keys).sorted(by: >).map { day in
            LibrarySection(
                day: day, rows: (byDay[day] ?? []).sorted { $0.start > $1.start },
                quiet: (quietByDay[day] ?? []).sorted { $0.start > $1.start })
        }
        thisWeek = Self.week(of: sections, isComplete: isComplete, jumped: jumpedTo != nil)
        phase = .loaded
    }

    private func row(_ conversation: CachedConversation, facts: ConversationFacts?, unsent: [Range<CaptureInstant>])
        -> ConversationRow
    {
        ConversationRow(conversation, facts: facts, unsent: unsent, pending: sync?.pending ?? PendingEdits([]))
    }

    /// Rows of these conversations, the live one when one was merged away.
    func rows(_ ids: [UUID]) async throws -> [UUID: ConversationRow] {
        var found: [UUID: CachedConversation] = [:]
        for id in ids { found[id] = try await library.conversation(id) }
        let facts = try await library.facts(of: Array(found.values))
        var shown: [ConversationRow] = []
        for conversation in found.values {
            let unsent = await sync?.unsent(overlapping: conversation.range) ?? []
            shown.append(row(conversation, facts: facts[conversation.id], unsent: unsent))
        }
        return Dictionary(shown.map { ($0.id, $0) }) { first, _ in first }
    }

    // MARK: Intents

    /// Keeps the two selected conversations together: the server applies it, and the rows say it waits until then.
    func mergeSelection() async {
        guard let range = mergeRange, let sync else { return }
        if let error = await sync.perform(.merge(from: range.from, to: range.to)) {
            actionError = error
            return
        }
        selection = []
    }

    private static func week(of sections: [LibrarySection], isComplete: Bool, jumped: Bool) -> Week? {
        guard !jumped, let week = Calendar.current.dateInterval(of: .weekOfYear, for: .now),
            isComplete || (sections.last.map { $0.day < week.start } ?? false)
        else { return nil }
        let rows = sections.filter { $0.day >= week.start }.flatMap(\.rows).filter { !$0.isLocal }
        return Week(count: rows.count, duration: .seconds(rows.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) }))
    }
}
