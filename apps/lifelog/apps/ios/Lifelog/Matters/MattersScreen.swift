import LifeConnector
import SwiftUI

/// The running matters, most pressing first, with a filter menu. The filter and the areas are Kit's
/// (`MatterFilter`, `MatterList`); this draws them.
struct MattersScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var filter = MatterFilter.everything
    @State private var visibility = NavigationSplitViewVisibility.all
    /// What he typed on the asks pushed on a matter: here, above both columns, so a fold keeps it.
    @State private var notes = CardNotes()
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// A compact width opens a matter out of its row and closes it back into it; beside the list nothing is pushed, so
    /// nothing zooms. Set at every width, so a fold never changes what the detail column is (a draft on the page stays).
    @Namespace private var matterZoom

    /// Two columns, the list and the matter: side by side on a regular width, one at a time on a compact one.
    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.matterColumn) {
            ReadScreen(
                shown: life.matters.shown(isEmpty: { $0.matters.isEmpty }), retry: { await life.refreshMatters() },
                loading: { RowsPlaceholder() },
                empty: { NoMattersNotice() },
                content: { list in content(list) }
            )
            .background(Palette.bg)
            // A swipe's mark, said back with Undo.
            .saysBack()
            // Beside the matter, the Pendant and Settings are the matter column's (the list's bar keeps its title).
            .shellBar(
                "Matters", hasSettings: sizeClass != .regular, hasPendant: sizeClass != .regular, isTitleLarge: true
            )
            // The filter on, under the title: "Important".
            .navigationSubtitle(filter.shownName ?? "")
            .filterBar(isFiltered: filter != .everything, identifier: "matters.filter") { filterChoices }
        } detail: {
            if let id = router.matter {
                NavigationStack(path: $router.matterPath) {
                    MatterPage(id: id, hasSettings: sizeClass == .regular).id(id)
                        .navigationDestination(for: AppRouter.MatterRoute.self) { route in
                            switch route {
                            case .card(let ref):
                                CardPage(
                                    ref: ref, source: life.matter[id]?.value?.checks ?? [], notes: $notes,
                                    leave: { router.matterPath = [] })
                            case .project(let project): ProjectPage(id: project)
                            }
                        }
                }
                .zooms(from: id, in: matterZoom)
                // His word that a step is done, held for Undo after he left its ask: over the top of the matter.
                .heldToast(
                    shows: { ref in life.matter[id]?.value?.checks.contains { $0.ref == ref } == true },
                    undo: { life.undo($0) }
                )
                // Back to the matter, by his Done or the system's back: the result he read is forgotten, so the next ask
                // opens on its own question.
                .onChange(of: router.matterPath) { _, path in
                    guard path.isEmpty, let taken = notes.taken else { return }
                    life.forget(taken.key)
                    notes.taken = nil
                }
            } else {
                Notice(title: "No matter chosen.", detail: "Pick one from the list.").background(Palette.bg)
                    // Loading, unreachable, no matters: the top group stays.
                    .shellBar("", hasSettings: sizeClass == .regular)
            }
        }
        // Side by side on a regular width wide enough (the iPhone Duo open wide). Open upright (669 pt) UIKit overlays the
        // list on the matter, whatever the column widths: kept on purpose (the owner's call, 19 Nov 2026); the system's
        // sidebar button brings the list back.
        .navigationSplitViewStyle(.balanced)
        // The tabs hide while a matter fills a compact width and come back with the list. Set here, above both columns:
        // set on the matter's page, the hidden bar outlived the page, and the Inbox could no longer be reached.
        .toolbarVisibility(sizeClass != .regular && router.matterColumn == .detail ? .hidden : .automatic, for: .tabBar)
        // The split view can drop the selection when it expands: a regular width always shows a matter.
        .onChange(of: sizeClass, initial: true) { fillSelection() }
        .onChange(of: life.matters.value) { fillSelection() }
        // Here, above both columns, so a fold that collapses the matter's page keeps the sheet and its running start.
        .sheet(item: matterSheetBinding) { sheet in
            switch sheet {
            case .agent(let id): AgentSheet(matter: id)
            case .icon(let id): MatterIconSheet(matter: id)
            case .start(let id):
                if let matter = life.matter[id]?.value {
                    StartAgentSheet(matter: matter)
                }
            }
        }
    }

    /// Closing the start sheet clears the start it showed, so the next opens on the form.
    private var matterSheetBinding: Binding<AppRouter.MatterSheet?> {
        Binding(
            get: { router.matterSheet },
            set: { sheet in
                if sheet == nil, case .start(let id) = router.matterSheet { life.forget(.start(matter: id)) }
                router.matterSheet = sheet
            })
    }

    private func fillSelection() {
        guard sizeClass == .regular else { return }
        let matters = life.matters.value?.matters
        let isGone = router.matter == nil || matters?.contains { $0.id == router.matter } == false
        router.select(matter: isGone ? matters?.first?.id : router.matter)
    }

    /// A system menu: a line icon per row, a check on the chosen one.
    @ViewBuilder private var filterChoices: some View {
        Picker("Show", selection: $filter) {
            Label("Everything", systemImage: "list.bullet").tag(MatterFilter.everything)
            Label {
                Text("Needs you")
            } icon: {
                Image(systemName: "circle.fill").imageScale(.small).foregroundStyle(Palette.flag)
            }
            .tag(MatterFilter.needsYou)
            Label("Important", systemImage: "flag").tag(MatterFilter.important)
            Label {
                Text("Agent working")
            } icon: {
                Image(symbol: RuntimeName.unknown.mark)
            }.tag(MatterFilter.agentWorking)
        }
        .pickerStyle(.inline)
        if let areas = life.matters.value?.areasByCount, !areas.isEmpty {
            Picker("Area", selection: $filter) {
                ForEach(areas, id: \.self) { area in
                    Label(area, systemImage: MatterIcons.areaSymbol(area)).tag(MatterFilter.area(area))
                }
            }
            .pickerStyle(.inline)
        }
    }

    /// The rows in Life's order (his marked ones first); a parked or done project's matters last, under "Parked". A
    /// swipe to the right marks one, or unmarks it: the system's own swipe action, as Mail flags a message.
    private func content(_ list: MatterList) -> some View {
        let rows = list.shown(filter: filter) { life.isImportant($0.id, as: $0.important) }
        let parkedFrom = rows.firstIndex(where: \.isParked)
        return List {
            if rows.isEmpty {
                Text("No matter fits. Loosen the filter.").font(.body15).foregroundStyle(Palette.muted)
                    .padding(20).quietListRow()
            }
            ForEach(Array(rows.enumerated()), id: \.element.id) { at, row in
                let isSelected = sizeClass == .regular && router.matter == row.id
                let isMarked = life.isImportant(row.id, as: row.important)
                VStack(alignment: .leading, spacing: 0) {
                    if at == parkedFrom { ListLabel("Parked") }
                    Button {
                        router.open(matter: row.id)
                    } label: {
                        MatterRowView(row: row, isChosen: isSelected, isMarked: isMarked)
                    }
                    .buttonStyle(.plain)
                    .zoomSource(row.id, in: matterZoom)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
                .readingWidth()
                .appears()
                .quietListRow()
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button(isMarked ? "Unmark" : "Important", systemImage: isMarked ? "flag" : "flag.fill") {
                        Task { await life.setImportant(row.id, !isMarked) }
                    }
                    .tint(Color.pick)
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        // Room under the last row, on top of the floating filter's (`filterBar`): a safe area adds, a content margin replaces.
        .safeAreaPadding(.bottom, Metrics.Spacing.xl)
        .motion(Motion.standard, value: rows.map(\.id))
        .scrollDismissesKeyboard(.interactively)
    }
}

extension View {
    /// A list row with nothing of the list's own: no inset, separator or fill, so it draws as a row of a stack.
    func quietListRow() -> some View {
        listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

struct MatterRowView: View {
    let row: MatterRow
    let isChosen: Bool
    /// His mark, his tap first (`LifeStore.isImportant`).
    let isMarked: Bool

    var body: some View {
        let parked = row.isParked
        return Row(
            title: row.name, icon: row.symbol,
            iconTint: Palette.muted, detail: row.nextStep?.text, isMarked: isMarked
        ) {
            // A parked project's matter waits: no dot, no agent.
            if parked {
                EmptyView()
            } else if row.needsYou == true {
                StateDot(color: Palette.flag)
            } else if row.agent != nil {
                Spinner(size: .small).foregroundStyle(Palette.ai).accessibilityLabel("An agent is working")
            }
        }
        .opacity(parked ? 0.45 : 1)
        // The content on the page's gutter (the row's own inset); the chosen one's fill inset from the edges.
        .background {
            RoundedRectangle(cornerRadius: Metrics.Radius.passage).fill(isChosen ? Palette.card : .clear)
                .padding(.horizontal, Metrics.Spacing.s)
        }
        .motion(Motion.standard, value: isChosen)
        .motion(Motion.standard, value: isMarked)
        .accessibilityElement(children: .combine)
        // The dot and the flag have their words: the combined row would drop a hidden glyph's label.
        .accessibilityValue(
            [
                isMarked ? "Important" : nil, row.needsYou == true && !parked ? "Needs you" : nil,
                parked ? "Parked" : nil,
            ]
            .compactMap(\.self).joined(separator: ", "))
    }
}

extension MatterFilter {
    /// Its name in the filter menu; none for everything.
    var shownName: String? {
        switch self {
        case .everything: nil
        case .needsYou: "Needs you"
        case .important: "Important"
        case .agentWorking: "Agent working"
        case .area(let area): area
        }
    }
}

/// What the list and the search show while no matter is running.
struct NoMattersNotice: View {
    var body: some View {
        Notice(
            title: "No matter is running.",
            detail: "Life finds them in your messages, notes and voice. They show here as they appear.")
    }
}

private struct RowsPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            ForEach(0..<5, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 10) {
                    Placeholder(width: 220, height: 18)
                    Placeholder(width: 280, height: 14)
                    Placeholder(width: 150, height: 12)
                }
            }
            Spacer()
        }
        .padding(20)
        .accessibilityLabel("Loading the matters")
    }
}
