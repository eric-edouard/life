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
/// when the scope is People. Each source is read on its own and shows through its own `ReadScreen` (loading, stale,
/// failed, unpaired, each with its way back), so one never waits on or hides the other; "Nothing holds" waits for
/// every source asked to have read nothing. A result opens in its own tab, where its page lives.
struct SearchScreen: View {
    let query: String
    let scope: SearchScope

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    private var asked: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        // One reading of what shows, for the rows, "Nothing holds" and the title's count alike. Unpaired, one notice says
        // so: the people's.
        let results = SearchResults(
            query: query, people: peopleRead, matters: scope == .people ? nil : life.matters, isPaired: life.isPaired)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if results.isNothing {
                    Text("Nothing holds “\(asked)”.").font(.body15).foregroundStyle(Palette.muted)
                        .padding(Metrics.gutter)
                        .appears()
                }
                if let people = results.people {
                    ReadScreen(
                        shown: people, retry: { await readPeople() },
                        loading: { Placeholder().padding(Metrics.gutter) },
                        empty: {
                            if asked.isEmpty {
                                Notice(
                                    title: "No one yet.",
                                    detail: "The people and organizations in your directory show here.")
                            }
                        },
                        content: { list in peopleRows(list) }
                    )
                }
                if let matters = results.matters {
                    ReadScreen(
                        shown: matters, retry: { await life.refreshMatters() },
                        loading: { Placeholder().padding(Metrics.gutter) },
                        empty: { if asked.isEmpty { NoMattersNotice() } },
                        content: { _ in
                            matterRows(
                                results.matterRows ?? [], isLabelled: results.people?.onScreen?.people.isEmpty == false)
                        }
                    )
                }
            }
            .padding(.bottom, Metrics.Spacing.l)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.bg)
        .screenTitle("Search", state: results.count.map { $0 == 1 ? "1 result" : "\($0) results" })
        // Each source on its own: the matters once per pairing, the people a moment after he stops typing (a newer
        // query replaces the read under way), and again on a new pairing.
        .task(id: life.parties.generation.current) {
            if life.matters.value == nil { await life.refreshMatters() }
        }
        .task(id: [AnyHashable(PeopleQuery(text: asked, pairing: life.parties.generation.current)), scope]) {
            guard scope != .matters, !asked.isEmpty else {
                if scope == .people, life.people.value == nil { await life.refreshPeople() }
                return
            }
            guard (try? await Task.sleep(for: .milliseconds(250))) != nil else { return }
            await life.findPeople(asked)
        }
    }

    /// The read of people this search shows, nil when it asks none: everyone with the field empty on People, else
    /// what `asked` found (not read yet: a read to come).
    private var peopleRead: ReadState<PeopleList>? {
        guard scope != .matters else { return nil }
        guard !asked.isEmpty else { return scope == .people ? life.people : nil }
        return life.peopleFound.flatMap { $0.query == asked ? $0.state : nil } ?? ReadState()
    }

    private func readPeople() async {
        if asked.isEmpty { await life.refreshPeople() } else { await life.findPeople(asked) }
    }

    private func peopleRows(_ list: PeopleList) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            section("People", list.people.filter { $0.party.kind != .organization })
            section("Organizations", list.people.filter { $0.party.kind == .organization })
            // Only seen by Life (in his Contacts, named by someone): quieter, and never a page to open.
            if let others = list.others, !others.isEmpty {
                ListLabel("Others Life has seen")
                ForEach(Array(others.enumerated()), id: \.element.ref) { at, party in
                    PartyRow(party, isDim: true)
                        .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.s)
                        .groupedRow(at: at, of: others.count)
                        .appears()
                }
            }
        }
        .motion(Motion.standard, value: list.people.map(\.id) + (list.others ?? []).map(\.ref))
    }

    private func matterRows(_ rows: [MatterRow], isLabelled: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !rows.isEmpty, isLabelled { ListLabel("Matters") }
            ForEach(Array(rows.enumerated()), id: \.element.id) { at, row in
                Button {
                    router.open(matter: row.id)
                } label: {
                    MatterRowView(row: row, isMarked: life.isImportant(row.id, as: row.important))
                }
                .buttonStyle(.plain)
                .groupedRow(at: at, of: rows.count)
                .appears()
            }
        }
        .motion(Motion.standard, value: rows.map(\.id))
    }

    @ViewBuilder private func section(_ label: String, _ rows: [PersonRow]) -> some View {
        if !rows.isEmpty {
            ListLabel(label)
            ForEach(Array(rows.enumerated()), id: \.element.id) { at, row in
                PersonRowButton(row: row) { router.open(party: row.id) }.groupedRow(at: at, of: rows.count).appears()
            }
        }
    }
}
