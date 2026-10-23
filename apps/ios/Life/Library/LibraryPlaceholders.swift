import Library
import SwiftUI
import Timeline

/// A designed empty or failed state: the title in Newsreader, the explanation in the secondary text color.
struct LibraryMessage<Actions: View>: View {
    let title: String
    let systemImage: String
    var description: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(title).font(.cardTitle).foregroundStyle(Palette.textPrimary)
            } icon: {
                Image(systemName: systemImage).foregroundStyle(Palette.textTertiary)
            }
        } description: {
            if let description { Text(description).foregroundStyle(Palette.textSecondary) }
        } actions: {
            actions.buttonStyle(.glass)
        }
    }
}

extension LibraryMessage where Actions == EmptyView {
    init(title: String, systemImage: String, description: String? = nil) {
        self.init(title: title, systemImage: systemImage, description: description) { EmptyView() }
    }
}

/// Loading, empty, failed and search states over the list. Placeholders sit here rather than in the list: a list
/// that already has rows when it first appears is laid out before the search drawer joins the bar, and opens
/// scrolled under it with the large title collapsed.
struct LibraryOverlay: View {
    let store: LibraryListStore
    let search: LibrarySearch

    var body: some View {
        if !search.query.isEmpty {
            switch search.search {
            case .tooShort:
                LibraryMessage(
                    title: "Keep typing", systemImage: "magnifyingglass",
                    description: "Search needs at least \(LibraryStore.minimumSearchLength) characters.")
            case .results(let rows, _) where rows.isEmpty:
                LibraryMessage(
                    title: "Nothing found", systemImage: "magnifyingglass",
                    description: "No title, transcript, person or place matches “\(search.query)”.")
            case .searching: LibraryLoadingRows()
            case .idle, .results: EmptyView()
            case .failed(let error):
                LibraryMessage(title: "Search failed", systemImage: "exclamationmark.triangle", description: error)
            }
        } else {
            switch store.phase {
            case .loading: LibraryLoadingRows()
            case .failed(let error):
                LibraryMessage(
                    title: "Couldn’t load the library", systemImage: "exclamationmark.triangle", description: error
                ) {
                    Button("Try again") { Task { await store.reload() } }
                }
            case .loaded where store.sections.isEmpty && store.jumpedTo != nil:
                LibraryMessage(title: "Nothing on or before this day", systemImage: "calendar") {
                    Button("Show the newest") { Task { await store.jump(to: nil) } }
                }
            case .loaded where store.sections.isEmpty:
                LibraryMessage(
                    title: "No conversations yet", systemImage: "waveform",
                    description: "Conversations appear here once the Pendant has synced and the audio is processed.")
            case .loaded: EmptyView()
            }
        }
    }
}

/// What the list shows, by result ids rather than whole rows: animating on it fades between the journal, the
/// placeholders and the results, and lets later pages of results ease in.
enum SearchShape: Equatable {
    case journal
    case typing
    case searching
    case results([UUID])
    case failed

    init(_ search: LibrarySearch) {
        guard !search.query.isEmpty else {
            self = .journal
            return
        }
        self =
            switch search.search {
            case .idle, .tooShort: .typing
            case .searching: .searching
            case .results(let rows, _): .results(rows.map(\.id))
            case .failed: .failed
            }
    }
}

/// A placeholder day while the first page or a search loads, laid out like the list's own header and rows so the real
/// ones take its place without moving. VoiceOver hears one "Loading" instead.
struct LibraryLoadingRows: View {
    private static let rows = [("Lunch with a friend in town", 48), ("A call about the week", 12), ("Dinner", 95)]
        .enumerated().map { index, sample in
            let start = Date(timeIntervalSinceReferenceDate: Double(index) * 3_600)
            return ConversationRow(
                id: ConversationID(anchor: CaptureInstant(start)).serverID, title: sample.0,
                summary: "A one-line summary of what was said in this conversation.", start: start,
                end: start.addingTimeInterval(Double(sample.1) * 60), people: ["Someone"], place: "Somewhere")
        }

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader(title: "Today", detail: "Fri, Jan 1", trailing: conversationCount(Self.rows.count))
                .journalHeader()
            ForEach(Self.rows) { row in
                ConversationRowView(row: row)
                    .padding(.horizontal, Metrics.gutter)
                    .overlay(alignment: .bottom) {
                        Palette.hairline.frame(height: 0.5).padding(.horizontal, Metrics.gutter)
                    }
            }
        }
        .redacted(reason: .placeholder)
        .frame(maxHeight: .infinity, alignment: .top)
        // Over a list that is jumping to a date; kept clear of the bar, which carries the large title.
        .background(Palette.ground, ignoresSafeAreaEdges: [])
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading")
    }
}
