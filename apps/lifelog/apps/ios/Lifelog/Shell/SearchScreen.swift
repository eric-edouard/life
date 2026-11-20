import LifeConnector
import SwiftUI

/// What the search's scope control keeps: everything, the matters, or the people and organizations.
enum SearchScope: Hashable, CaseIterable {
    case all, matters, people

    var word: String {
        switch self {
        case .all: "All"
        case .matters: "Matters"
        case .people: "People"
        }
    }
}

/// The system's search tab, the one search: the people and organizations Life knows whose name or line holds what he
/// typed (`read_people_and_organizations` with a query), the running matters that hold it (`MatterList.matching`), then,
/// last, the others Life has seen by that name, only there. With the field empty it lists every matter, or everyone
/// when the scope is People. A result opens in its own tab, where its page lives.
struct SearchScreen: View {
    let query: String
    let scope: SearchScope

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    private var asked: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        ReadScreen(
            shown: life.matters.shown(isEmpty: { $0.matters.isEmpty && scope == .matters }),
            retry: { await life.refreshMatters() },
            loading: { Placeholder().padding(Metrics.gutter) },
            empty: { NoMattersNotice() },
            content: { list in results(scope == .people ? [] : list.matching(query)) }
        )
        .background(Palette.bg)
        // What he typed, read a moment after he stops; a newer query replaces the read under way.
        .task(id: [asked, "\(scope)"]) {
            guard scope != .matters else { return }
            guard !asked.isEmpty else {
                if life.people.value == nil { await life.refreshPeople() }
                return
            }
            guard (try? await Task.sleep(for: .milliseconds(250))) != nil else { return }
            await life.findPeople(asked)
        }
    }

    /// The people and organizations found (everyone, with the field empty on People), none in the Matters scope.
    private var found: PeopleList? {
        guard scope != .matters else { return nil }
        guard !asked.isEmpty else { return scope == .people ? life.people.value : nil }
        return life.peopleFound.flatMap { $0.query == asked ? $0.state.value : nil }
    }

    private func results(_ rows: [MatterRow]) -> some View {
        let people = found?.people ?? []
        let others = found?.others ?? []
        let persons = people.filter { $0.party.kind != .organization }
        let organizations = people.filter { $0.party.kind == .organization }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty && people.isEmpty && others.isEmpty && !asked.isEmpty {
                    Text("Nothing holds “\(asked)”.").font(.body15).foregroundStyle(Palette.muted)
                        .padding(Metrics.gutter)
                        .appears()
                }
                section("People", persons)
                section("Organizations", organizations)
                if !rows.isEmpty, scope == .all, !people.isEmpty { ListLabel("Matters") }
                ForEach(rows) { row in
                    Button {
                        router.open(matter: row.id)
                    } label: {
                        MatterRowView(row: row, isChosen: false, isMarked: life.isImportant(row.id, as: row.important))
                    }
                    .buttonStyle(.plain)
                    .appears()
                }
                // Only seen by Life (in his Contacts, named by someone): quieter, and never a page to open.
                if !others.isEmpty {
                    ListLabel("Others Life has seen")
                    ForEach(others, id: \.ref) { party in
                        PartyRow(party, isDim: true)
                            .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.m)
                            .appears()
                    }
                }
            }
            .motion(Motion.standard, value: rows.map(\.id) + people.map(\.id) + others.map(\.ref))
            .padding(.bottom, Metrics.Spacing.l)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder private func section(_ label: String, _ rows: [PersonRow]) -> some View {
        if !rows.isEmpty {
            ListLabel(label)
            ForEach(rows) { row in
                PersonRowButton(row: row) { router.open(party: row.id) }.appears()
            }
        }
    }
}
