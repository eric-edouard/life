import Export
import Foundation
import Library
import Observation
import ServerAPI
import Timeline

/// One conversation as the owner sees it, read from the library's cache and the outbox. The owner's edits go to the
/// outbox (`SyncStore.perform`) and show at once, marked as waiting until the server has them. Reloaded when the view
/// appears and whenever the driver changed the cache or the outbox.
@Observable
final class ConversationStore {
    enum Phase: Equatable {
        case loading
        /// The cache has no such conversation, even behind a merge.
        case missing
        case loaded
    }

    /// Follows a merge, so an old link opens the conversation that now holds it.
    private(set) var id: UUID
    private(set) var phase = Phase.loading
    private(set) var conversation: CachedConversation?
    /// Turns with words, in time order. Kept: the view reads them on every playback tick.
    private(set) var lines: [CachedTurn] = []
    /// `lines` as the page shows them, with chapter titles and the photos taken during a turn after it.
    private(set) var blocks: [TranscriptBlock] = []
    private(set) var chapters: [CachedChapter] = []
    /// Photos and screenshots taken during the conversation, in time order; empty without Photos access.
    private(set) var photos: [TranscriptPhoto] = []
    private(set) var people: [CachedPerson] = []
    private(set) var state = ConversationState.transcribed
    /// The owner's edits not on the server yet.
    private(set) var pending = PendingEdits([])
    /// The grouping edit that made this conversation's edges (the feed's `startEdit`, else `endEdit`), for "Split by
    /// AI · Undo": a split (the summary run's or the owner's) or the owner's merge.
    private(set) var undoableEdit: CachedEdit?
    /// Where the summary run suggests a split, less the ones the owner dismissed, and the owner's splits waiting for the
    /// server: each shows between its two passages.
    private(set) var splits: [Date] = []
    /// The owner's splits inside it the server doesn't have yet.
    private(set) var waitingSplits: Set<Date> = []
    /// Why the last intent didn't happen, for the owner.
    var failure: String?
    /// The passage whose speaker is being named, its pills open under it.
    var naming: CachedTurn?
    /// Who the last passages went to, newest first: one tap for the next.
    private(set) var recent: [WhoPills.Pick] = []
    /// The passage the owner asked to split at, waiting for confirmation.
    var splitting: CachedTurn?
    /// The photo open full screen.
    var viewing: TranscriptPhoto?

    /// Set by the view from the environment; `nil` in previews.
    @ObservationIgnored var sync: SyncStore?
    @ObservationIgnored var library: LibraryStore?

    init(id: UUID) {
        self.id = id
    }

    /// The owner's title waiting for the server wins over the cache's.
    var title: String? {
        guard let conversation else { return nil }
        return pending.titles[conversation.id].map { $0 ?? conversation.title } ?? conversation.shownTitle
    }

    /// A title, a split or a merge of it waits for the server.
    var editWaiting: Bool {
        guard let conversation else { return false }
        return pending.titles[conversation.id] != nil || pending.regrouping(conversation.range)
    }

    /// A new summary was asked for and waits to be sent.
    var summaryRequested: Bool { pending.summarizing(id) }

    /// Summaries are off (the server's default): none is made, and nothing offers one.
    var aiOff: Bool { sync?.switches?.ai == false }

    // MARK: Reading

    func load() async {
        guard let library else { return }
        do {
            guard let conversation = try await library.conversation(id) else {
                phase = .missing
                return
            }
            id = conversation.id
            let lines = try await library.turns(of: conversation.id)
            var pending = sync?.pending
            if pending == nil { pending = try await library.pendingEdits() }
            let shown = pending ?? PendingEdits([])
            let chapters = try await library.chapters(of: conversation.id)
            let state = ConversationState(
                conversation, unsent: !(await sync?.unsent(overlapping: conversation.range) ?? []).isEmpty)
            let undoing = Set(shown.grouping.compactMap { if case .undo(let edit) = $0 { edit } else { nil } })
            let edges = [conversation.startEdit, conversation.endEdit].compactMap(\.self)
            let edits = edges.isEmpty ? [] : try await library.edits(edges)
            let edge = edges.lazy.compactMap { id in edits.first { $0.id == id } }
                .first { $0.undoneAt == nil && !undoing.contains($0.id) }
            let people = try await library.people()
            let waitingSplits = shown.grouping.compactMap { intent -> Date? in
                guard case .split(let at) = intent, conversation.range.contains(CaptureInstant(at)) else { return nil }
                return at
            }
            let dismissed = Set(shown.dismissedSplits)
            let splits =
                conversation.isImported
                ? []
                : Array(
                    Set((conversation.splitSuggestions ?? []).map(\.at).filter { !dismissed.contains($0) })
                        .union(waitingSplits)
                ).sorted()
            // A newer load started (the view's `.task(id:)` cancelled this one): it writes the page, not this one.
            guard !Task.isCancelled else { return }
            self.people = people
            self.waitingSplits = Set(waitingSplits)
            // A reload that changed nothing leaves the page alone: rebuilding it re-lays out every line.
            if conversation != self.conversation || lines != self.lines || chapters != self.chapters
                || splits != self.splits
            {
                (self.conversation, self.lines, self.chapters, self.splits) = (conversation, lines, chapters, splits)
                fold()
            }
            (self.pending, self.state, undoableEdit) = (shown, state, edge)
            phase = .loaded
            // Asks for Photos access the first time a page has turns to place photos beside.
            if !lines.isEmpty {
                let photos = await PhotoLibrary.photos(in: conversation.range)
                if !Task.isCancelled, photos != self.photos {
                    self.photos = photos
                    fold()
                }
            }
        } catch {
            failure = report(error)
        }
    }

    private func fold() {
        blocks = TranscriptBlock.fold(
            lines, photos: lines.turns(of: photos, at: \.taken), chapters: chapters, splits: splits)
    }

    /// A provider label names a voice within its job only.
    static func voice(_ line: CachedTurn) -> String { "\(line.jobId)|\(line.speaker.label ?? "")" }

    /// Named people only; unnamed voices never read as people.
    func isPerson(_ line: CachedTurn) -> Bool { line.speaker.personId != nil || line.speaker.isOwner == true }

    /// An answer about this voice waits for the server.
    func speakerWaiting(_ line: CachedTurn) -> Bool { pending.speakers.contains(Self.voice(line)) }

    /// The whole transcript with speaker names and times, as in an exported TXT.
    /// Built only when asked (Copy): a long transcript costs too much to build on every redraw.
    func plainText() -> String? {
        guard let conversation, !lines.isEmpty else { return nil }
        return ConversationExport(conversation: conversation, turns: lines, chapters: chapters, timeZone: .current)
            .plainText()
    }

    // MARK: Intents

    /// An empty title clears the owner's, which brings back the generated one.
    func rename(_ title: String) async {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard title != conversation?.ownerTitle ?? "" else { return }
        await perform(.title(conversation: id, title: title.isEmpty ? nil : title))
    }

    /// A new title and summary, run on the owner's Mac.
    /// Generate: a new summary, unless one newer than the one shown already came.
    func summarize() async { await perform(.summarize(conversation: id, after: conversation?.runId)) }

    /// Names the speaker of `line`: that turn alone, or every passage of its voice.
    func name(_ line: CachedTurn, as pick: WhoPills.Pick, everywhere: Bool) async {
        guard let label = line.speaker.label else { return }
        naming = nil
        recent = Array(([pick] + recent.filter { $0 != pick }).prefix(3))
        await perform(
            .speaker(job: line.jobId, label: label, target: pick.target, turnIndex: everywhere ? nil : line.turnIndex))
    }

    /// Ends this conversation at the start of `line`; the rest becomes the next conversation.
    func split(at line: CachedTurn) async { await perform(.split(at: line.startAt)) }

    /// "Split here?" answered: split at the suggestion, or keep it together and the suggestion goes.
    func answerSplit(at: Date, split: Bool) async {
        await perform(split ? .split(at: at) : .dismissSplit(at: at))
    }

    /// Takes back the split or merge that made this conversation's edges.
    func undoEdge() async {
        guard let edit = undoableEdit else { return }
        await perform(.undo(edit: edit.id))
    }

    /// Plays this conversation from `instant` (its start when `nil`).
    func play(_ playback: PlaybackStore, at instant: CaptureInstant? = nil, autoplay: Bool = true) {
        guard let conversation else { return }
        playback.open(conversation, at: instant, autoplay: autoplay)
    }

    private func perform(_ intent: OwnerIntent) async {
        guard let sync else { return }
        failure = await sync.perform(intent)
        await load()
    }

    #if DEBUG
        /// Previews: before the first load, or a conversation the cache doesn't have.
        static func preview(_ phase: Phase) -> ConversationStore {
            let store = ConversationStore(id: UUID())
            store.phase = phase
            return store
        }

        /// Previews: a fixture conversation in a given state, no library.
        static func preview(_ layout: FixtureLayout, state: ConversationState? = nil) -> ConversationStore {
            let store = ConversationStore(id: layout.conversation.id)
            store.conversation = layout.conversation
            store.lines = layout.turns
            store.chapters = layout.chapters
            store.state =
                state
                ?? (layout.conversation.tldr == nil ? .transcribed : .summarized)
            store.people = FixtureLibrary.people.map { CachedPerson(id: $1, name: $0, isOwner: $0 == "Dave") }
            store.splits = (layout.conversation.splitSuggestions ?? []).map(\.at)
            if let edit = layout.conversation.startEdit {
                store.undoableEdit = CachedEdit(id: edit, kind: .split, at: layout.conversation.startAt, source: .ai)
            }
            store.fold()
            store.phase = .loaded
            return store
        }
    #endif
}
