import LifeConnector
import SwiftUI

/// The People tab: everyone Life knows (his directory's people and organizations and everyone with a page), closest first
/// or A to Z, with one control for all, people or organizations; beside them, or over them on a compact width, the one
/// on show. The groups and the order are Kit's (`PeopleList.groups`); this draws them.
struct PeopleScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    @State private var order = PeopleList.Order.closeness
    @State private var kind = PeopleList.Kind.all
    @State private var visibility = NavigationSplitViewVisibility.all
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $router.personColumn) {
            ReadScreen(
                shown: life.people.shown(isEmpty: { $0.people.isEmpty }), retry: { await life.refreshPeople() },
                loading: { RowsPlaceholder() },
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
            // Beside a person, the Pendant and Settings are the person's column (the list's bar keeps its title).
            .shellBar(
                "People", hasSettings: sizeClass != .regular, hasPendant: sizeClass != .regular, isTitleLarge: true
            )
            .navigationSubtitle(order == .alphabet ? "A to Z" : "")
            .filterBar(isFiltered: order != .closeness, identifier: "people.sort") { orderChoices }
        } detail: {
            if let ref = router.person {
                NavigationStack {
                    PersonPage(ref: ref, hasSettings: sizeClass == .regular).id(ref)
                }
            } else {
                Notice(title: "No one chosen.", detail: "Pick someone from the list.").background(Palette.bg)
                    .shellBar("", hasSettings: sizeClass == .regular)
            }
        }
        .navigationSplitViewStyle(.balanced)
        // The tabs hide while a person fills a compact width and come back with the list (as in Matters).
        .toolbarVisibility(sizeClass != .regular && router.personColumn == .detail ? .hidden : .automatic, for: .tabBar)
        // A regular width always shows someone.
        .onChange(of: sizeClass, initial: true) { fillSelection() }
        .onChange(of: life.people.value) { fillSelection() }
        .task(id: life.parties.generation.current) { await life.refreshPeople() }
    }

    private func fillSelection() {
        guard sizeClass == .regular, router.person == nil else { return }
        router.select(person: life.people.value?.groups(order, kind).first?.rows.first?.id)
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
                            PersonRowButton(row: row, isChosen: sizeClass == .regular && router.person == row.id) {
                                router.select(person: row.id)
                            }
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
/// them waits on him, the chosen one's fill beside the page.
struct PersonRowButton: View {
    let row: PersonRow
    var isChosen = false
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            PartyRow(party: row.party) {
                if row.needsYou { StateDot(color: Palette.flag) }
            }
            .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.m)
            .contentShape(.rect)
            .background {
                RoundedRectangle(cornerRadius: Metrics.Radius.passage).fill(isChosen ? Palette.card : .clear)
                    .padding(.horizontal, Metrics.Spacing.s)
            }
        }
        .buttonStyle(.plain)
        .motion(Motion.standard, value: isChosen)
        .accessibilityValue(row.needsYou ? "Needs you" : "")
        .accessibilityAddTraits(isChosen ? .isSelected : [])
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

private struct RowsPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
            ForEach(0..<6, id: \.self) { _ in
                HStack(spacing: Metrics.Spacing.m) {
                    Placeholder(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                        Placeholder(width: 160, height: 16)
                        Placeholder(width: 220, height: 12)
                    }
                }
            }
            Spacer()
        }
        .padding(Metrics.gutter)
        .accessibilityLabel("Loading the people")
    }
}
