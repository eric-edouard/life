import LifeConnector
import SwiftUI

/// The running matters, most pressing first, with a search and three filters. The filter and the counts are Kit's
/// (`MatterFilter`, `MatterList`); this draws them.
struct MattersScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var query = ""
    @State private var filter = MatterFilter()
    @State private var showsFilters = false
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
            filter.withAgent = true
            router.showsAgentsOnly = false
        }
        .sheet(isPresented: $showsFilters) {
            if let list = life.matters.value {
                FiltersSheet(list: list, query: query, filter: $filter).presentationPlacement(.trailing)
            }
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

    private func content(_ list: MatterList) -> some View {
        let rows = list.shown(query: query, filter: filter)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Field(prompt: "Search \(list.matters.count) matters", text: $query, icon: "magnifyingglass")
                    .submitLabel(.search)
                    .padding(.horizontal, 20).padding(.top, 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        FilterChip(name: "Area", value: filter.area ?? "All", isOn: filter.area != nil) {
                            showsFilters = true
                        }
                        FilterChip(
                            name: "Waits on",
                            value: filter.waits.isEmpty
                                ? "Anything" : filter.waits.map(\.name).sorted().joined(separator: ", "),
                            isOn: !filter.waits.isEmpty
                        ) { showsFilters = true }
                        FilterChip(name: "With an agent", isOn: filter.withAgent, hasMenu: false) {
                            filter.withAgent.toggle()
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .padding(.vertical, 12)
                if rows.isEmpty {
                    Text("No matter fits. Loosen the search or the filters.").font(.body15).foregroundStyle(
                        Palette.muted
                    )
                    .padding(20)
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { offset, row in
                    let isSelected = sizeClass == .regular && router.matter == row.id
                    Button {
                        router.open(matter: row.id)
                    } label: {
                        MatterRowView(
                            rank: offset + 1, row: row, cards: row.openChecks ?? 0,
                            agent: life.agents.value?.agents.first { $0.id == row.agent })
                    }
                    .buttonStyle(.plain)
                    .background(isSelected ? Color.fillTint : .clear)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(.bottom, 24)
            .readingWidth()
        }
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
    let rank: Int
    let row: MatterRow
    let cards: Int
    let agent: RegisteredAgent?

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(rank)").font(.monoSmall).foregroundStyle(Palette.faint).frame(width: 18, alignment: .leading)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.name).font(.quote).foregroundStyle(Palette.fg)
                    Spacer(minLength: 8)
                    if cards > 0 {
                        CountBadge(count: cards)
                            .accessibilityLabel("\(cards) card\(cards == 1 ? "" : "s")")
                    }
                }
                if let next = row.nextStep {
                    Text("Next: \(Text(next.text.prefixLowercased).foregroundStyle(Palette.muted))").font(
                        .lead
                    )
                    .foregroundStyle(Palette.fg)
                }
                HStack(spacing: 12) {
                    if let wait = row.wait?.line(waitsOn: row.nextStep?.waitsOn) {
                        Text(wait.text).label().foregroundStyle(wait.needsYou ? Palette.flag : Palette.fg)
                    }
                    if let area = row.areas?.first {
                        Text(area).font(.body15).foregroundStyle(Palette.muted)
                    }
                    if let agent {
                        Label(
                            agent.runtimeName.name
                                + (agent.wait.map { ", until " + $0.until.formatted(.dateTime.weekday(.abbreviated)) }
                                    ?? ""),
                            systemImage: "sparkle"
                        )
                        .font(.body15).foregroundStyle(Palette.ai).lineLimit(1)
                    }
                }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Hairline().padding(.leading, 52).padding(.trailing, 20) }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

extension String {
    /// A sentence's first word in lower case, to follow a label ("Next: send…").
    var prefixLowercased: String { prefix(1).lowercased() + dropFirst() }
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

/// The area and the kinds of wait, each with how many matters it holds, and how many would show.
private struct FiltersSheet: View {
    let list: MatterList
    let query: String
    @Binding var filter: MatterFilter
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Filters").font(.sheetTitle).foregroundStyle(Palette.fg)
                    Spacer()
                    TextLink("Clear") { filter = MatterFilter() }.disabled(filter.isEmpty)
                }
                Caps("Area")
                VStack(spacing: 0) {
                    line("All", list.matters.count, isOn: filter.area == nil) { filter.area = nil }
                    ForEach(list.areaCounts, id: \.area) { item in
                        line(item.area, item.count, isOn: filter.area == item.area) { filter.area = item.area }
                    }
                }
                Caps("Waits on")
                VStack(spacing: 0) {
                    ForEach(MatterWait.allCases, id: \.self) { wait in
                        line(wait.name, list.waitCounts[wait] ?? 0, isOn: filter.waits.contains(wait)) {
                            if filter.waits.contains(wait) {
                                filter.waits.remove(wait)
                            } else {
                                filter.waits.insert(wait)
                            }
                        }
                    }
                }
                Button("Show \(list.shown(query: query, filter: filter).count) matters") { dismiss() }.buttonStyle(
                    .pill(.filled))
            }
            .padding(20)
        }
        .background(Palette.sheet)
        .presentationDetents([.large])
    }

    private func line(_ name: String, _ count: Int, isOn: Bool, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack {
                Text(name).font(.lead).foregroundStyle(Palette.fg)
                Spacer()
                Text("\(count)").font(.monoTime).foregroundStyle(Palette.muted)
                Image(systemName: "checkmark").opacity(isOn ? 1 : 0).foregroundStyle(Palette.fg).accessibilityHidden(
                    true)
            }
            .frame(minHeight: 48).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
