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
        ReadScreen(
            shown: life.matters.shown(isEmpty: { $0.matters.isEmpty }), retry: { await life.refreshMatters() },
            loading: { Placeholder().padding(Metrics.gutter) },
            empty: {
                Notice(
                    title: "No matter is running.",
                    detail: "Life finds them in your messages, notes and voice. They show here as they appear.")
            },
            content: { list in results(list.matching(query)) }
        )
        .background(Palette.bg)
    }

    private func results(_ rows: [MatterRow]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                if rows.isEmpty {
                    Text("No matter holds “\(query)”.").font(.body15).foregroundStyle(Palette.muted)
                        .transition(Motion.appears)
                }
                RowGroup {
                    ForEach(rows) { row in
                        Button {
                            router.open(matter: row.id)
                        } label: {
                            Row(title: row.name, detail: row.nextStep.map { "Next: \($0.text.prefixLowercased)" })
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .motion(Motion.standard, value: rows.map(\.id))
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, Metrics.Spacing.l)
            .readingWidth()
        }
        .scrollDismissesKeyboard(.interactively)
    }
}
