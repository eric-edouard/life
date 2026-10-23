import Library
import ServerAPI
import SwiftUI
import Timeline

enum LibraryRoute: Hashable {
    /// Opens at `at` when set: a search result opens at its matching passage.
    case conversation(UUID, at: CaptureInstant? = nil)
    case people
    /// "Who's this?": the voices to name, one at a time.
    case naming
}

/// The library tab: `store` is `nil` while the library isn't open.
struct LibraryView: View {
    let store: LibraryListStore?
    @Binding var path: [LibraryRoute]
    @Environment(\.library) private var library

    var body: some View {
        Group {
            if let store {
                LibraryScreen(store: store, path: $path)
            } else {
                NavigationStack {
                    Group {
                        if library == nil {
                            LibraryMessage(
                                title: "Library not open", systemImage: "tray", description: LibraryStore.notOpen)
                        } else {
                            LibraryLoadingRows()
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Palette.ground)
                    .tabTitle("Library", summary: "")
                    .connectionStatus()
                }
            }
        }
        .timesFirstRender(
            "library", ready: store?.phase == .loaded, rows: store?.sections.reduce(0) { $0 + $1.rows.count } ?? 0)
    }
}

/// The journal: day sections with sticky headers, search in the toolbar, a date jump and multi-select to export or
/// merge.
struct LibraryScreen: View {
    @Bindable var store: LibraryListStore
    @Binding var path: [LibraryRoute]
    @State private var search: LibrarySearch
    @State private var isSelecting: Bool
    @State private var isExporting = false
    @State private var isConfirmingMerge = false
    @State private var isPickingDate = false
    @Namespace private var zoom
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(NamingQueue.self) private var naming: NamingQueue?

    init(store: LibraryListStore, path: Binding<[LibraryRoute]>, isSelecting: Bool = false, query: String = "") {
        self.store = store
        _path = path
        _search = State(initialValue: LibrarySearch(list: store, query: query))
        self.isSelecting = isSelecting
    }

    var body: some View {
        NavigationStack(path: $path) {
            List(selection: $store.selection) {
                // At accessibility sizes the bar keeps a small title and the week's summary wraps here instead.
                if typeSize.isAccessibilitySize, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .padding(.vertical, 8)
                        .journalRow()
                        .listRowSeparator(.hidden)
                        .selectionDisabled()
                }
                if search.query.isEmpty {
                    FeedSections(store: store, zoom: zoom)
                } else {
                    SearchSection(search: search, zoom: zoom)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Palette.ground)
            .tint(Palette.textPrimary)
            .overlay { LibraryOverlay(store: store, search: search) }
            // Search placeholders give way to results, and results to the journal, as a fade rather than a cut.
            .motion(Motion.standard, value: SearchShape(search))
            .tabTitle("Library", summary: subtitle)
            .connectionStatus()
            .searchable(
                text: $search.query, placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Titles, words, people, places"
            )
            .task { if store.phase == .loading { await store.loadMore() } }
            // The rows changed under a search: it runs again.
            .onChange(of: store.sections) { if !search.query.isEmpty { search.refresh() } }
            .refreshable { await store.reload() }
            .environment(\.editMode, .constant(isSelecting ? .active : .inactive))
            .toolbar { toolbar }
            .navigationDestination(for: LibraryRoute.self) { route in
                switch route {
                case .conversation(let id, let at):
                    if reduceMotion {
                        ConversationView(id: id, at: at)
                    } else {
                        ConversationView(id: id, at: at).navigationTransition(.zoom(sourceID: id, in: zoom))
                    }
                case .people: PeopleScreen()
                case .naming: NamingView()
                }
            }
            .sheet(isPresented: $isExporting) { ExportSheet(conversations: store.selectedIDs) }
            .sheet(isPresented: $isPickingDate) {
                DateJumpSheet { day in Task { await store.jump(to: day) } }
            }
            .confirmationDialog("Merge these two conversations?", isPresented: $isConfirmingMerge) {
                Button("Merge") { Task { await store.mergeSelection() } }
            } message: {
                Text("They stay one conversation from now on. Undo it at the top of the conversation.")
            }
            .alert("Couldn’t do that", item: $store.actionError) { _ in
                Button("OK") {}
            } message: { error in
                Text(error)
            }
        }
        // Tabs show on the list only: not while selecting, nor under a pushed page (a conversation has its own
        // player). Decided here from the path, never by the page: a page's own "hidden" could outlive an interrupted
        // zoom back, and the tabs stayed gone.
        .toolbarVisibility(path.isEmpty && !isSelecting ? .visible : .hidden, for: .tabBar)
    }

    private var subtitle: String {
        if isSelecting {
            return store.selection.isEmpty ? "Select conversations" : "\(store.selection.count) selected"
        }
        guard let week = store.thisWeek, week.count > 0 else { return "" }
        let length = week.duration.formatted(.units(allowed: [.hours, .minutes], width: .narrow))
        return "\(conversationCount(week.count)) this week · \(length)"
    }

    private func setSelecting(_ selecting: Bool) {
        withMotion(Motion.standard) {
            isSelecting = selecting
            if !selecting { store.selection = [] }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if !isSelecting {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Go to date", systemImage: "calendar") { isPickingDate = true }
                    .accessibilityIdentifier("library.date")
                Button("People", systemImage: "person.2") { path.append(.people) }
                    .badge(naming?.count ?? 0)
                    .accessibilityIdentifier("library.people")
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button(isSelecting ? "Done" : "Select") { setSelecting(!isSelecting) }
                .accessibilityIdentifier("library.select")
                .fontWeight(isSelecting ? .semibold : .regular)
                .disabled(!isSelecting && store.sections.isEmpty)
        }
        if isSelecting {
            ToolbarItem(placement: .bottomBar) {
                Button("Merge", systemImage: "arrow.triangle.merge") { isConfirmingMerge = true }
                    .disabled(store.mergeRange == nil)
                    .accessibilityIdentifier("library.merge")
                    .accessibilityHint("Select two conversations next to each other.")
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button(
                    store.selection.isEmpty ? "Export" : "Export \(store.selection.count)",
                    systemImage: "square.and.arrow.up"
                ) { isExporting = true }
                .labelStyle(.titleAndIcon)
                .primaryGlassButton()
                .disabled(store.selection.isEmpty)
                .accessibilityIdentifier("library.export")
                .contentTransition(.numericText(value: Double(store.selection.count)))
                .motion(Motion.standard, value: store.selection.count)
            }
        }
    }
}

/// "1 conversation", "5 conversations".
func conversationCount(_ count: Int) -> String {
    String(AttributedString(localized: "^[\(count) conversation](inflect: true)").characters)
}

/// Rows for the list: hairline separators edge to edge inside the gutter, the ground behind.
extension View {
    func journalRow() -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: Metrics.gutter, bottom: 0, trailing: Metrics.gutter))
            .listRowBackground(Palette.ground)
            .listRowSeparatorTint(Palette.hairline)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }

    /// A sticky day header spanning the width, over a translucent ground.
    func journalHeader() -> some View {
        padding(.horizontal, Metrics.gutter)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.ground.opacity(0.92))
            .overlay(alignment: .bottom) { Palette.hairline.frame(height: 0.5) }
            .listRowInsets(EdgeInsets())
    }
}
