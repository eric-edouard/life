import LifeConnector
import SwiftUI

/// The running matters, most pressing first, with a filter menu. The filter and the areas are Kit's
/// (`MatterFilter`, `MatterList`); this draws them.
struct MattersScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var filter = MatterFilter.everything
    @State private var visibility = NavigationSplitViewVisibility.all
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// Two columns, the list and the matter: side by side on a regular width, one at a time on a compact one.
    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.matterColumn) {
            ReadScreen(
                shown: life.matters.shown(isEmpty: { $0.matters.isEmpty }), retry: { await life.refreshMatters() },
                loading: { RowsPlaceholder() },
                empty: {
                    Notice(
                        title: "No matter is running.",
                        detail: "Life finds them in your messages, notes and voice. They show here as they appear.")
                },
                content: { list in content(list) }
            )
            .background(Palette.bg)
            .shellBar("Matters")
            .toolbar { ToolbarItem(placement: .topBarLeading) { filterMenu } }
        } detail: {
            if let id = router.matter {
                MatterPage(id: id).id(id)
            } else {
                Notice(title: "No matter chosen.", detail: "Pick one from the list.").background(Palette.bg)
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
        .onChange(of: router.showsAgentsOnly, initial: true) { _, on in
            guard on else { return }
            filter = .agentWorking
            router.showsAgentsOnly = false
        }
        // Here, above both columns, so a fold that collapses the matter's page keeps the sheet and its running start.
        .sheet(isPresented: startSheetBinding) {
            if let id = router.startSheetMatter, let matter = life.matter[id]?.value {
                StartAgentSheet(matter: matter).presentationPlacement(.leading)
            }
        }
    }

    /// Closing the sheet clears the start it showed, so the next opens on the form.
    private var startSheetBinding: Binding<Bool> {
        Binding(
            get: { router.startSheetMatter != nil },
            set: { isOpen in
                guard !isOpen, let id = router.startSheetMatter else { return }
                life.forget(.start(matter: id))
                router.startSheetMatter = nil
            })
    }

    private func fillSelection() {
        guard sizeClass == .regular else { return }
        let matters = life.matters.value?.matters
        let isGone = router.matter == nil || matters?.contains { $0.id == router.matter } == false
        router.select(matter: isGone ? matters?.first?.id : router.matter)
    }

    /// A system menu: a line icon per row, a check on the chosen one.
    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $filter) {
                Label("Everything", systemImage: "list.bullet").tag(MatterFilter.everything)
                Label {
                    Text("Needs you")
                } icon: {
                    Image(systemName: "circle.fill").imageScale(.small).foregroundStyle(Palette.flag)
                }
                .tag(MatterFilter.needsYou)
                Label {
                    Text("Agent working")
                } icon: {
                    Image(systemName: "sparkles").foregroundStyle(Palette.ai)
                }.tag(MatterFilter.agentWorking)
            }
            .pickerStyle(.inline)
            if let areas = life.matters.value?.areasByCount, !areas.isEmpty {
                Picker("Area", selection: $filter) {
                    ForEach(areas, id: \.self) { area in
                        Label(area, systemImage: area.areaSymbol).tag(MatterFilter.area(area))
                    }
                }
                .pickerStyle(.inline)
            }
        } label: {
            Image(
                systemName: filter == .everything
                    ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filter")
        .accessibilityIdentifier("matters.filter")
    }

    private func content(_ list: MatterList) -> some View {
        let rows = list.shown(filter: filter)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty {
                    Text("No matter fits. Loosen the filter.").font(.body15).foregroundStyle(
                        Palette.muted
                    )
                    .padding(20)
                }
                ForEach(rows) { row in
                    let isSelected = sizeClass == .regular && router.matter == row.id
                    Button {
                        router.open(matter: row.id)
                    } label: {
                        MatterRowView(row: row, isChosen: isSelected)
                    }
                    .buttonStyle(.plain)
                    .appears()
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(.bottom, 24)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

private struct MatterRowView: View {
    let row: MatterRow
    let isChosen: Bool

    var body: some View {
        Row(
            title: row.name, icon: row.areas?.first.map(\.areaSymbol) ?? String.defaultAreaSymbol,
            iconTint: row.agent != nil ? Palette.ai : Palette.muted, detail: row.nextStep?.text
        ) {
            if row.needsYou {
                StateDot(color: Palette.flag).accessibilityLabel("Needs you")
            } else if row.agent != nil {
                ProgressView().controlSize(.small).tint(Palette.ai).accessibilityLabel("An agent is working")
            }
        }
        .background(isChosen ? Palette.card : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
        .padding(.horizontal, 8)
        .motion(Motion.standard, value: isChosen)
        .accessibilityElement(children: .combine)
    }
}

extension String {
    /// What a matter with no area shows.
    static let defaultAreaSymbol = "folder"

    /// The line icon of an area, by its meaning; an area it has no icon for gets the plain one.
    var areaSymbol: String {
        switch lowercased() {
        case "home": "house"
        case "work": "briefcase"
        case "family": "heart"
        case "papers", "admin": "doc"
        case "money": "banknote"
        default: Self.defaultAreaSymbol
        }
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
