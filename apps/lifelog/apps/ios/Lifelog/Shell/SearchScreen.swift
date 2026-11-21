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
/// when the scope is People. Each source stands alone (`SearchPart`): one still reading or failed never hides the
/// other's rows, and "Nothing holds" waits for every source asked. A result opens in its own tab, where its page lives.
struct SearchScreen: View {
    let query: String
    let scope: SearchScope

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    private var asked: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        let matters = scope == .people ? nil : SearchPart(life.matters) { $0.matching(query) }
        let people = peopleRead.map { state in SearchPart(state) { $0.people } }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !asked.isEmpty, [matters?.isNothing, people?.isNothing].allSatisfy({ $0 != false }) {
                    Text("Nothing holds “\(asked)”.").font(.body15).foregroundStyle(Palette.muted)
                        .padding(Metrics.gutter)
                        .appears()
                }
                if let people { peopleRows(people) }
                if let matters { matterRows(matters, isLabelled: people != nil) }
                // Only seen by Life (in his Contacts, named by someone): quieter, and never a page to open.
                if let others = peopleRead?.value?.others, !others.isEmpty {
                    ListLabel("Others Life has seen")
                    ForEach(others, id: \.ref) { party in
                        PartyRow(party, isDim: true)
                            .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.m)
                            .appears()
                    }
                }
            }
            .motion(Motion.standard, value: (people?.found?.map(\.id) ?? []) + (matters?.found?.map(\.id) ?? []))
            .padding(.bottom, Metrics.Spacing.l)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.bg)
        // What he typed, read a moment after he stops; a newer query replaces the read under way, and a new pairing
        // reads it again.
        .task(id: [asked, "\(scope)", "\(life.parties.generation.current)"]) {
            if scope != .people, life.matters.value == nil { await life.refreshMatters() }
            guard scope != .matters else { return }
            guard !asked.isEmpty else {
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

    @ViewBuilder private func peopleRows(_ part: SearchPart<[PersonRow]>) -> some View {
        switch part {
        case .reading: Placeholder().padding(Metrics.gutter)
        case .failed:
            PartRetry(what: "People") {
                if asked.isEmpty { await life.refreshPeople() } else { await life.findPeople(asked) }
            }
            .padding(Metrics.gutter)
        case .found(let rows):
            section("People", rows.filter { $0.party.kind != .organization })
            section("Organizations", rows.filter { $0.party.kind == .organization })
        }
    }

    @ViewBuilder private func matterRows(_ part: SearchPart<[MatterRow]>, isLabelled: Bool) -> some View {
        switch part {
        case .reading: Placeholder().padding(Metrics.gutter)
        case .failed: PartRetry(what: "Matters") { await life.refreshMatters() }.padding(Metrics.gutter)
        case .found(let rows) where rows.isEmpty && asked.isEmpty: NoMattersNotice()
        case .found(let rows):
            if !rows.isEmpty, isLabelled { ListLabel("Matters") }
            ForEach(rows) { row in
                Button {
                    router.open(matter: row.id)
                } label: {
                    MatterRowView(row: row, isChosen: false, isMarked: life.isImportant(row.id, as: row.important))
                }
                .buttonStyle(.plain)
                .appears()
            }
        }
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
