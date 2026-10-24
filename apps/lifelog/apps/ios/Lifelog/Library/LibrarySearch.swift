import Foundation
import Library
import Observation

/// The Library's search over its `LibraryListStore`: what the owner typed and what it found.
@Observable
final class LibrarySearch {
    enum Search: Equatable {
        case idle
        /// The trigram index needs `LibraryStore.minimumSearchLength` characters.
        case tooShort
        case searching
        case results([ConversationRow], isComplete: Bool)
        case failed(String)
    }

    /// What the owner typed: a search starts once typing pauses for 250 ms, cancelling the one before.
    var query = "" {
        didSet {
            guard query != oldValue else { return }
            refresh(after: .milliseconds(250))
        }
    }
    private(set) var search = Search.idle
    /// The server's search by meaning didn't answer (offline, no token): results are word matches only.
    private(set) var isWordsOnly = false

    @ObservationIgnored private let list: LibraryListStore
    @ObservationIgnored private var words: [ConversationRow] = []
    @ObservationIgnored private var wordsComplete = false
    @ObservationIgnored private var meaning: [MeaningHit] = []
    @ObservationIgnored private var meaningRows: [UUID: ConversationRow] = [:]
    @ObservationIgnored private var searching: Task<Void, Never>?
    private static let searchPage = 30

    init(list: LibraryListStore, query: String = "") {
        self.list = list
        self.query = query
        if !query.isEmpty { refresh() }
    }

    /// Searches again from the first result, cancelling the search going on: typing paused, or the list changed.
    func refresh(after delay: Duration = .zero) {
        searching?.cancel()
        searching = Task {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await runSearch()
        }
    }

    /// Searches `query` from the first result: word matches on this phone at once, then, after a further pause in
    /// typing, what the server finds by meaning.
    private func runSearch() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        words = []
        meaning = []
        meaningRows = [:]
        if text.isEmpty {
            search = .idle
        } else if text.count < LibraryStore.minimumSearchLength {
            search = .tooShort
        } else {
            search = .searching
            await searchPage(text)
            await searchMeaning(text)
        }
    }

    func loadMoreResults() async {
        guard case .results(_, isComplete: false) = search else { return }
        await searchPage(query.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func isCurrent(_ text: String) -> Bool { text == query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func searchPage(_ text: String) async {
        do {
            let hits = try await list.library.search(text, limit: Self.searchPage, offset: words.count)
            // A newer keystroke cancels this search.
            try Task.checkCancellation()
            var page: [ConversationRow] = []
            for hit in hits {
                guard var row = try await list.rows([hit.conversation])[hit.conversation] else { continue }
                row.snippet = hit.snippet
                row.match = hit.passage
                page.append(row)
            }
            guard isCurrent(text) else { return }
            words += page
            wordsComplete = hits.count < Self.searchPage
            publishResults()
        } catch is CancellationError {
            return
        } catch {
            search = .failed(report(error))
        }
    }

    /// Asks the server once the owner has paused (the list waits 250 ms, this 150 ms more), so typing never sends a
    /// request per keystroke. Offline or without a token, the results stay word matches, and say so.
    private func searchMeaning(_ text: String) async {
        guard case .results = search else { return }
        guard let meaningSearch = list.meaningSearch else {
            isWordsOnly = true
            return
        }
        do {
            try await Task.sleep(for: .milliseconds(150))
            let found = try await meaningSearch(text)
            let live = try await list.rows(Array(Set(found.map(\.conversation))))
            guard isCurrent(text) else { return }
            // A conversation merged away since the server indexed it lives on in its successor.
            meaning = found.compactMap { hit in
                guard let row = live[hit.conversation] else { return nil }
                var hit = hit
                hit.conversation = row.id
                return hit
            }
            meaningRows = Dictionary(live.values.map { ($0.id, $0) }) { first, _ in first }
            isWordsOnly = false
            publishResults()
        } catch is CancellationError {
            return
        } catch {
            _ = report(error)
            guard isCurrent(text) else { return }
            isWordsOnly = true
        }
    }

    /// Word matches, then conversations only meaning found (`SearchMerge`).
    private func publishResults() {
        let wordRows = Dictionary(words.map { ($0.id, $0) }) { first, _ in first }
        let matches = SearchMerge.merge(
            words: words.map {
                SearchMatch(conversation: $0.id, passage: $0.match, snippet: $0.snippet ?? "", source: .words)
            },
            meaning: meaning)
        let results = matches.compactMap { match -> ConversationRow? in
            let isMeaning = match.source == .meaning
            guard var row = isMeaning ? meaningRows[match.conversation] : wordRows[match.conversation] else {
                return nil
            }
            row.match = match.passage
            row.byMeaning = isMeaning
            if isMeaning { row.snippet = match.snippet }
            return row
        }
        search = .results(results, isComplete: wordsComplete)
    }
}
