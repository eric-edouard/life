import LifeConnector
import SwiftUI

/// The running matters, most pressing first, with a search and three filters. The filter and the counts are Kit's
/// (`MatterFilter`, `MatterList`); this draws them.
struct MattersScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var query = ""
    @State private var scope = Scope.everything
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
            scope = .agent
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

    /// What the filter menu chooses: everything, what needs him, what an agent works on, or one area.
    private enum Scope: Hashable {
        case everything, needsYou, agent
        case area(String)

        var filter: MatterFilter {
            switch self {
            case .everything: MatterFilter()
            case .needsYou: MatterFilter(waits: [.decision, .owner])
            case .agent: MatterFilter(withAgent: true)
            case .area(let area): MatterFilter(area: area)
            }
        }
    }

    /// A system menu: a line icon per row, a check on the chosen one.
    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $scope) {
                Label("Everything", systemImage: "list.bullet").tag(Scope.everything)
                Label {
                    Text("Needs you")
                } icon: {
                    Image(systemName: "circle.fill").imageScale(.small).foregroundStyle(Palette.flag)
                }
                .tag(Scope.needsYou)
                Label("Agent working", systemImage: "sparkles").tag(Scope.agent)
            }
            .pickerStyle(.inline)
            if let areas = life.matters.value?.areaCounts, !areas.isEmpty {
                Picker("Area", selection: $scope) {
                    ForEach(areas, id: \.area) { item in
                        Label(item.area.capitalized, systemImage: item.area.areaSymbol).tag(Scope.area(item.area))
                    }
                }
                .pickerStyle(.inline)
            }
        } label: {
            Image(
                systemName: scope == .everything
                    ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filter")
        .accessibilityIdentifier("matters.filter")
    }

    private func content(_ list: MatterList) -> some View {
        let rows = list.shown(query: query, filter: scope.filter)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty {
                    Text("No matter fits. Loosen the search or the filter.").font(.body15).foregroundStyle(
                        Palette.muted
                    )
                    .padding(20)
                }
                ForEach(rows) { row in
                    let isSelected = sizeClass == .regular && router.matter == row.id
                    Button {
                        router.open(matter: row.id)
                    } label: {
                        MatterRowView(
                            row: row, isChosen: isSelected,
                            agent: life.agents.value?.agents.first { $0.id == row.agent })
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(.bottom, 24)
            .readingWidth()
            .motion(Motion.standard, value: rows.map(\.id))
        }
        .searchable(text: $query, prompt: "Search \(list.matters.count) matters")
        .scrollDismissesKeyboard(.interactively)
    }
}

extension MatterWait {
    /// The filter's words for it.
    var name: String {
        switch self {
        case .decision: "Your decision"
        case .owner: "You, to do something"
        case .ready: "Nothing: ready to do"
        case .event: "Something to arrive"
        case .stuck: "Stuck"
        }
    }

    /// The caps line on a row and a page, and whether it needs him.
    func line(waitsOn: String?) -> (text: String, needsYou: Bool) {
        switch self {
        case .decision: ("Your decision", true)
        case .owner: ("Waits on you", true)
        case .ready: ("Ready to do", false)
        case .event: (waitsOn.map { "Waits on \($0)" } ?? "Waits for something", false)
        case .stuck: ("Stuck", false)
        }
    }
}

private struct MatterRowView: View {
    let row: MatterRow
    let isChosen: Bool
    let agent: RegisteredAgent?

    /// The flag dot when it needs him (a wait on him, or a card open); the spinner when an agent is working.
    private var needsYou: Bool { row.wait?.line(waitsOn: nil).needsYou == true || (row.openChecks ?? 0) > 0 }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: (row.areas?.first ?? "").areaSymbol)
                .imageScale(.large).foregroundStyle(Palette.muted)
                .frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name).font(.rowName).foregroundStyle(Palette.fg).lineLimit(1)
                if let next = row.nextStep {
                    Text(next.text).font(.note).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if needsYou {
                    StateDot(color: Palette.flag).accessibilityLabel("Needs you")
                } else if agent?.status == .running {
                    ProgressView().controlSize(.small).tint(Palette.ai).accessibilityLabel("An agent is working")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(isChosen ? Palette.card : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
        .padding(.horizontal, 8)
        .motion(Motion.standard, value: isChosen)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

extension String {
    /// The line icon of an area, by its name; an area it has no icon for gets a plain one.
    var areaSymbol: String {
        switch lowercased() {
        case "home": "house"
        case "work": "briefcase"
        case "family": "heart"
        case "papers": "doc"
        case "money": "banknote"
        default: "folder"
        }
    }
}

private struct RowsPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Placeholder(height: 52)
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
