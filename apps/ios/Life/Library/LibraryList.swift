import Library
import SwiftUI
import Timeline

struct FeedSections: View {
    let store: LibraryListStore
    let zoom: Namespace.ID
    /// Days whose quiet recordings the owner opened.
    @State private var openQuiet: Set<Date> = []

    var body: some View {
        if let day = store.jumpedTo, !store.sections.isEmpty {
            HStack {
                Text("\(day.formatted(date: .abbreviated, time: .omitted)) and earlier")
                    .font(.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                Spacer(minLength: 8)
                Button("Show the newest") { Task { await store.jump(to: nil) } }
                    .buttonStyle(.glass)
                    .frame(minHeight: 44)
            }
            .padding(.vertical, 10)
            .journalRow()
            .selectionDisabled()
        }
        ForEach(store.sections) { section in
            let isLast = section.id == store.sections.last?.id
            Section {
                ForEach(section.rows) { row in
                    JournalRow(row: row, zoom: zoom)
                }
                if !section.quiet.isEmpty {
                    let isOpen = openQuiet.contains(section.day)
                    QuietLine(rows: section.quiet, isOpen: isOpen) {
                        withMotion(Motion.standard) {
                            if isOpen { openQuiet.remove(section.day) } else { openQuiet.insert(section.day) }
                        }
                    }
                    if isOpen {
                        ForEach(section.quiet) { row in
                            JournalRow(row: row, zoom: zoom)
                        }
                    }
                }
            } header: {
                let day = DayTitle.parts(section.day)
                SectionHeader(
                    title: day.title, detail: day.detail,
                    // The oldest day may still be paging in: no count until it is whole.
                    trailing: (isLast && !store.isComplete) || section.rows.isEmpty
                        ? nil : conversationCount(section.rows.count)
                )
                .journalHeader()
            }
        }
        if !store.isComplete && !store.sections.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                .accessibilityLabel("Loading earlier conversations")
                .journalRow()
                .listRowSeparator(.hidden)
                .selectionDisabled()
                .task(id: store.loadedCount) { await store.loadMore() }
        }
    }
}

struct SearchSection: View {
    let search: LibrarySearch
    let zoom: Namespace.ID

    var body: some View {
        switch search.search {
        case .results(let rows, let isComplete) where !rows.isEmpty:
            Section {
                ForEach(rows) { row in
                    JournalRow(row: row, query: search.query, zoom: zoom)
                }
                if !isComplete {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                        .accessibilityLabel("Loading more results")
                        .journalRow()
                        .listRowSeparator(.hidden)
                        .selectionDisabled()
                        .task(id: rows.count) { await search.loadMoreResults() }
                }
            } header: {
                SectionHeader(
                    title: "Matches",
                    // Offline or without a token: said once, quietly, rather than as an error.
                    detail: search.isWordsOnly ? "words only" : nil,
                    trailing: isComplete ? conversationCount(rows.count) : "\(rows.count)+"
                )
                .journalHeader()
            }
        default: EmptyView()
        }
    }
}

/// "3 quiet recordings · 2m": the day's wordless clips and dictation to the Mac, folded into one line the owner opens.
private struct QuietLine: View {
    let rows: [ConversationRow]
    let isOpen: Bool
    let toggle: () -> Void

    var body: some View {
        let length = Duration.seconds(rows.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) })
        Button(action: toggle) {
            HStack(spacing: 8) {
                Text(
                    "\(String(AttributedString(localized: "^[\(rows.count) quiet recording](inflect: true)").characters)) · \(DurationText.string(length, width: .narrow))"
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(isOpen ? 180 : 0))
                    .accessibilityHidden(true)
            }
            .font(.footnote)
            .foregroundStyle(Palette.textTertiary)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOpen ? "Shown" : "Hidden")
        .accessibilityHint("Recordings with no words, and dictation to your Mac")
        .accessibilityIdentifier("library.quiet")
        .journalRow()
        .selectionDisabled()
    }
}

/// A row that opens its conversation, zooming from the row; in select mode the list's selection takes the tap. Audio
/// not uploaded yet has no page: it plays.
private struct JournalRow: View {
    let row: ConversationRow
    var query = ""
    let zoom: Namespace.ID

    @Environment(PlaybackStore.self) private var playback

    var body: some View {
        Group {
            if row.isLocal {
                Button {
                    playback.open(id: row.id, title: row.title ?? "", range: row.range, autoplay: true)
                } label: {
                    ConversationRowView(row: row)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Plays it from this phone")
                .selectionDisabled()
            } else {
                NavigationLink(value: LibraryRoute.conversation(row.id, at: row.match)) {
                    ConversationRowView(row: row, query: query)
                }
                .navigationLinkIndicatorVisibility(.hidden)
                // The zoom grows out of the row as a rounded card on the ground, and shrinks back into it.
                .matchedTransitionSource(id: row.id, in: zoom) { source in
                    source.background(Palette.ground).clipShape(.rect(cornerRadius: Metrics.Radius.passage))
                }
            }
        }
        .accessibilityIdentifier("library.row")
        .journalRow()
        .tag(row.id)
    }
}
