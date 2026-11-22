import LifeConnector
import SwiftUI

/// The People tab: everyone Life knows (his directory's people and organizations and everyone with a page), his closest
/// first then A to Z, under one search field and one control for the people or the organizations; beside them, or over
/// them on a compact width, the one on show. What the list shows is Kit's (`PeopleList.sections`); this draws it. The
/// pose is measured before anything is drawn, so nothing is chosen for him on a pose that is not his.
struct PeopleScreen: View {
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        GeometryReader { window in
            let isSplit = PeopleList.isSplit(
                isRegularWidth: sizeClass == .regular, width: window.size.width, height: window.size.height)
            PeopleColumns(
                isSplit: isSplit, hasOwnBack: sizeClass == .regular && !isSplit)
        }
    }
}

/// The list and the one on show: beside it (`isSplit`), or pushed over it as folded (compact, or the open Duo upright:
/// decision 93).
private struct PeopleColumns: View {
    let isSplit: Bool
    /// Stacked on a regular width (the open Duo upright): the system collapses nothing there, so it draws no Back.
    let hasOwnBack: Bool
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var kind = PeopleList.Kind.people
    /// What he typed in the field: the list follows it as he types.
    @State private var query = ""
    @State private var visibility = NavigationSplitViewVisibility.all
    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.personColumn) {
            ReadScreen(
                shown: life.people.shown(isEmpty: { $0.people.isEmpty }), stamp: life.people.stamp,
                retry: { await life.refreshPeople() },
                loading: { RowsPlaceholder(hasDisc: true, label: "Loading the people") },
                empty: {
                    Notice(
                        title: "No one yet.",
                        detail:
                            "The people and organizations in your directory, and everyone Life writes about, show here."
                    )
                },
                content: { list in content(list) }
            )
            .background(Palette.bg)
            .safeAreaBar(edge: .top, spacing: 0) { searchBar }
            // Beside a person, the Pendant is the person's column.
            .shellBar("", hasPendant: !isSplit)
        } detail: {
            if let ref = router.person {
                NavigationStack(path: $router.personPath) {
                    PersonPage(ref: ref).id(ref)
                        .toolbar {
                            if hasOwnBack {
                                ToolbarItem(placement: .topBarLeading) {
                                    Button("Back", systemImage: "chevron.backward") { router.personColumn = .sidebar }
                                        .labelStyle(.iconOnly)
                                }
                            }
                        }
                        .navigationDestination(for: AppRouter.PersonRoute.self) { route in
                            switch route {
                            case .part(let part, let title): ProsePage(ref: part, title: title)
                            case .latest(let subject): LatestScreen(subject: subject)
                            case .writing(let subject): WritingPage(subject: subject)
                            case .party(let ref): PersonPage(ref: ref)
                            }
                        }
                }
            } else {
                Notice(title: "No one chosen.", detail: "Pick someone from the list.").background(Palette.bg)
                    .shellBar("")
            }
        }
        .navigationSplitViewStyle(.balanced)
        // Stacked, the split view collapses as on a compact width: the list full screen, a tap pushes the page.
        .environment(\.horizontalSizeClass, isSplit ? .regular : .compact)
        // Beside the list there is always someone, one of the rows on show unless opened from elsewhere.
        .onChange(of: isSplit, initial: true) { fillSelection() }
        .onChange(of: life.people.value) { fillSelection() }
        .onChange(of: kind) { fillSelection() }
        .onChange(of: query) { fillSelection() }
        // Back from someone opened elsewhere (a matter, a card) goes back there, not to this list.
        .onChange(of: router.personColumn) { _, column in if column == .sidebar, !isSplit { router.closePerson() } }
        .task(id: life.parties.generation.current) { await life.refreshPeople() }
    }

    private func fillSelection() {
        guard let list = life.people.value else { return }
        let ref = list.selectionOf(
            router.person, isFromElsewhere: router.isPersonFromElsewhere, kind: kind, query: query, isSplit: isSplit)
        if ref != router.person { router.select(person: ref) }
    }

    /// The search field, the first line of the page on the Pendant's line; it sits clear of the Pendant's corner on a
    /// compact width, where the bar holds it.
    private var searchBar: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Image(systemName: "magnifyingglass").font(.note).foregroundStyle(Palette.muted).accessibilityHidden(true)
            DictationField(prompt: "Search", label: "Search the people", text: $query)
                .font(.body15).foregroundStyle(Palette.fg)
                .accessibilityIdentifier("people.search")
        }
        .padding(.horizontal, Metrics.Spacing.l)
        .card(radius: Metrics.Radius.card)
        .padding(.horizontal, Metrics.gutter)
        .padding(.trailing, isSplit ? 0 : Metrics.tapTarget + Metrics.Spacing.s)
        .padding(.top, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.l)
    }

    /// The control, then the groups: "Close to you" over the letters, then A to Z under its letter with the system's index
    /// of letters down the edge. On a search, the other kind's matches are one last row, and a search that found no one
    /// says so and offers Life.
    private func content(_ list: PeopleList) -> some View {
        let shown = list.cut(to: router.cut(of: .people))
        let sections = shown.sections(kind: kind, query: query)
        let others = shown.sections(kind: kind.other, query: query).flatMap(\.rows).count
        return List {
            CutToast(kind: .people).quietListRow()
            control(list)
            if sections.isEmpty, query.isEmpty {
                Text("No one here.").font(.body15).foregroundStyle(Palette.muted)
                    .padding(Metrics.gutter).quietListRow()
            }
            ForEach(sections) { section in
                Section {
                    ForEach(Array(section.rows.enumerated()), id: \.element.id) { at, row in
                        VStack(alignment: .leading, spacing: 0) {
                            if at == 0 { ListLabel(section.label) }
                            PersonRowButton(row: row) { router.select(person: row.id) }
                                .buttonStyle(
                                    .groupedRow(
                                        at: at, of: section.rows.count,
                                        isChosen: isSplit && router.person == row.id))
                        }
                        .readingWidth()
                        .appears()
                        .quietListRow()
                    }
                }
                .sectionIndexLabel(section.label == PeopleList.close ? nil : section.label)
            }
            // What he typed left this kind out, or left everyone out: said under its rows, never a blank list.
            if !query.isEmpty, sections.isEmpty {
                Text("No one named \(query).").font(.body15).foregroundStyle(Palette.muted)
                    .padding(.horizontal, Metrics.gutter).quietListRow()
            }
            if !query.isEmpty, others > 0 {
                switchRow(others)
            } else if !query.isEmpty, sections.isEmpty {
                askLifeRow
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .listSectionIndexVisibility(.visible)
        .safeAreaPadding(.bottom, Metrics.Spacing.xl)
        .motion(Motion.standard, value: sections.flatMap(\.rows).map(\.id))
        .scrollDismissesKeyboard(.interactively)
    }

    /// People | Organizations, each with how many rows of it the list holds; the chosen one stays chosen.
    private func control(_ list: PeopleList) -> some View {
        SegmentedChoice(
            choices: PeopleList.Kind.allCases,
            selection: Binding(get: { kind }, set: { kind = $0 ?? kind }),
            title: \.word, detail: { "\(list.count(of: $0))" }
        )
        .accessibilityIdentifier("people.kind")
        .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.xs)
        .readingWidth()
        .quietListRow()
    }

    /// The other kind's matches, one last row under his search: its tap shows them.
    private func switchRow(_ count: Int) -> some View {
        Button {
            kind = kind.other
        } label: {
            Row(title: "\(count) in \(kind.other.word)", icon: kind.other.symbol, detail: nil, isInList: true) {
                RowValue()
            }
        }
        .buttonStyle(.groupedRow(at: 1, of: 2))
        .readingWidth()
        .appears()
        .quietListRow()
    }

    /// A search that found no one of either kind: Life may know the name.
    private var askLifeRow: some View {
        QuietChip("Ask Life who it might be", symbol: "waveform", iconTint: Palette.ai) {
            router.isAskLifeOpen = true
        }
        .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.s)
        .readingWidth()
        .quietListRow()
    }
}

/// One person or organization as a row of a list that opens their page: `PartyRow`, the flag dot when something with
/// them waits on him. Its list sets it in its card (`.buttonStyle(.groupedRow(…))`).
struct PersonRowButton: View {
    let row: PersonRow
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            PartyRow(party: row.party) {
                if row.needsYou { StateDot(color: Palette.flag) }
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.s)
        }
        .accessibilityValue(row.needsYou ? "Needs you" : "")
    }
}

extension PeopleList.Kind {
    /// The other one the control shows, as the search's last row names it.
    fileprivate var other: PeopleList.Kind { self == .people ? .organizations : .people }

    fileprivate var word: String {
        switch self {
        case .people: "People"
        case .organizations: "Organizations"
        }
    }

    fileprivate var symbol: String {
        switch self {
        case .people: "person.2"
        case .organizations: "building.2"
        }
    }
}
