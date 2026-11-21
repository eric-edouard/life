import LifeConnector
import SwiftUI

/// The People tab: everyone Life knows (his directory's people and organizations and everyone with a page), closest first
/// or A to Z, with one control for all, people or organizations; beside them, or over them on a compact width, the one
/// on show. The groups and the order are Kit's (`PeopleList.groups`); this draws them. The pose is measured before
/// anything is drawn, so nothing is chosen for him on a pose that is not his.
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

    @State private var order = PeopleList.Order.closeness
    @State private var kind = PeopleList.Kind.all
    @State private var visibility = NavigationSplitViewVisibility.all
    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.personColumn) {
            ReadScreen(
                shown: life.people.shown(isEmpty: { $0.people.isEmpty }), retry: { await life.refreshPeople() },
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
            .screenTitle("People", state: order == .alphabet ? "A to Z" : nil)
            // Beside a person, the Pendant and Settings are the person's column.
            .shellBar("", hasSettings: !isSplit, hasPendant: !isSplit)
            .filterBar(isFiltered: order != .closeness, identifier: "people.sort", label: "Sort") { orderChoices }
        } detail: {
            if let ref = router.person {
                NavigationStack(path: $router.personPath) {
                    PersonPage(ref: ref, hasSettings: isSplit).id(ref)
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
                    .shellBar("", hasSettings: isSplit)
            }
        }
        .navigationSplitViewStyle(.balanced)
        // Stacked, the split view collapses as on a compact width: the list full screen, a tap pushes the page.
        .environment(\.horizontalSizeClass, isSplit ? .regular : .compact)
        // Beside the list there is always someone, one of the rows on show unless opened from elsewhere.
        .onChange(of: isSplit, initial: true) { fillSelection() }
        .onChange(of: life.people.value) { fillSelection() }
        .onChange(of: kind) { fillSelection() }
        // Back from someone opened elsewhere (a matter, Search) goes back there, not to this list.
        .onChange(of: router.personColumn) { _, column in if column == .sidebar, !isSplit { router.closePerson() } }
        .task(id: life.parties.generation.current) { await life.refreshPeople() }
    }

    private func fillSelection() {
        guard let list = life.people.value else { return }
        let ref = list.selectionOf(
            router.person, isFromElsewhere: router.isPersonFromElsewhere, kind: kind, order: order, isSplit: isSplit)
        if ref != router.person { router.select(person: ref) }
    }

    /// The system menu of the bar's leading button: Life's order, or A to Z.
    private var orderChoices: some View {
        Picker("Order", selection: $order) {
            Label("By closeness", systemImage: "person.2").tag(PeopleList.Order.closeness)
            Label("A to Z", systemImage: "textformat.abc").tag(PeopleList.Order.alphabet)
        }
        .pickerStyle(.inline)
    }

    /// The control, then the groups: by closeness each under its small label (the first has none), A to Z under its
    /// letter with the system's index of letters down the edge.
    private func content(_ list: PeopleList) -> some View {
        let groups = list.groups(order, kind)
        return List {
            SegmentedChoice(
                choices: PeopleList.Kind.allCases,
                selection: Binding(get: { kind }, set: { kind = $0 ?? .all }),
                title: \.word, icon: \.symbol
            )
            .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.xs)
            .readingWidth()
            .quietListRow()
            if groups.isEmpty {
                Text("No one here.").font(.body15).foregroundStyle(Palette.muted)
                    .padding(Metrics.gutter).quietListRow()
            }
            ForEach(groups) { group in
                Section {
                    ForEach(Array(group.rows.enumerated()), id: \.element.id) { at, row in
                        VStack(alignment: .leading, spacing: 0) {
                            if at == 0, let label = group.label { ListLabel(label) }
                            PersonRowButton(row: row) { router.select(person: row.id) }
                                .buttonStyle(
                                    .groupedRow(
                                        at: at, of: group.rows.count, isChosen: isSplit && router.person == row.id))
                        }
                        .readingWidth()
                        .appears()
                        .quietListRow()
                    }
                }
                .sectionIndexLabel(order == .alphabet ? group.label : nil)
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .listSectionIndexVisibility(order == .alphabet ? .visible : .hidden)
        .safeAreaPadding(.bottom, Metrics.Spacing.xl)
        .motion(Motion.standard, value: groups.flatMap(\.rows).map(\.id))
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
    fileprivate var word: String {
        switch self {
        case .all: "All"
        case .people: "People"
        case .organizations: "Organizations"
        }
    }

    fileprivate var symbol: String? {
        switch self {
        case .all: nil
        case .people: "person.2"
        case .organizations: "building.2"
        }
    }
}
