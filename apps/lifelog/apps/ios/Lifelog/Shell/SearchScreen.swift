import LifeConnector
import SwiftUI

/// The system's search tab: the running matters whose name, goal, next step or people hold what he typed
/// (`MatterList.matching`), every one while the field is empty. A result opens in the Matters tab, where a matter's
/// page and its sheets live.
struct SearchScreen: View {
    let query: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let found = life.matters.value?.matching(query)
        ReadScreen(
            shown: life.matters.shown(isEmpty: { $0.matters.isEmpty }), retry: { await life.refreshMatters() },
            loading: { Placeholder().padding(Metrics.gutter) },
            empty: { NoMattersNotice() },
            content: { _ in results(found ?? []) }
        )
        .background(Palette.bg)
        // How many hold what he typed; nothing while he typed nothing.
        .screenTitle(
            "Search",
            state: query.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil : found.map { $0.count == 1 ? "1 result" : "\($0.count) results" })
    }

    private func results(_ rows: [MatterRow]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty {
                    Text("No matter holds “\(query)”.").font(.body15).foregroundStyle(Palette.muted)
                        .padding(Metrics.gutter)
                        .appears()
                }
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
            .motion(Motion.standard, value: rows.map(\.id))
            .padding(.bottom, Metrics.Spacing.l)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
    }
}
