import LifeConnector
import SwiftUI

/// A project's page: its name, its status as one control (underway, parked, done: one tap, said back with Undo), what
/// that means when it is not underway, his goal for it, and its matters as the list draws them (each dimmed by the
/// project it shows under: one shared with a project underway is not).
struct ProjectPage: View {
    let id: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let state = life.project[id] ?? ReadState()
        ReadScreen(
            shown: state.shown(isEmpty: { $0.project == nil }), retry: { await life.refreshProject(id) },
            loading: { PagePlaceholder() },
            empty: { Notice(title: "This project is gone.", detail: "Life no longer lists it.") },
            content: { list in list.project.map { page($0, matters: list.matters) } }
        )
        .background(Palette.bg)
        .saysBack()
        .shellBar("", hasSettings: false)
        .task { await life.refreshProject(id) }
    }

    private func page(_ head: MatterList.ProjectHead, matters: [MatterRow]) -> some View {
        let status = life.status(of: id, as: head.status)
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(head.name).font(.screenName).foregroundStyle(Palette.fg)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                    .stepsAsideForToast()
                SegmentedChoice(
                    choices: [ProjectStatus.active, .parked, .done],
                    selection: Binding(
                        get: { status.isUnderway ? .active : status },
                        set: { choice in choose(choice, head: head, status: status) }),
                    title: \.shownWord
                )
                .disabled(life.whyOutOfReach != nil)
                if let line = meaning(of: status) {
                    Text(line).font(.small).foregroundStyle(Palette.muted).appears()
                }
                if let goal = head.goal {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Caps("Goal", color: Palette.muted)
                        Text(goal).font(.bodyStrong).foregroundStyle(Palette.fg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
                    .frame(maxWidth: .infinity, alignment: .leading).card()
                }
                VStack(spacing: 0) {
                    ForEach(Array(matters.enumerated()), id: \.element.id) { at, row in
                        Button {
                            router.open(matter: row.id)
                        } label: {
                            MatterRowView(row: row, isMarked: life.isImportant(row.id, as: row.important))
                        }
                        .buttonStyle(.groupedRow(at: at, of: matters.count))
                    }
                }
                // The card on the page's gutter: a grouped row keeps a list's inset from its column's edges.
                .padding(.horizontal, -Metrics.Spacing.m)
            }
            .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.xl).readingWidth()
            .motion(Motion.standard, value: status)
        }
    }

    /// One tap: a status other than the one shown is his word, said back by its own name.
    private func choose(_ choice: ProjectStatus?, head: MatterList.ProjectHead, status: ProjectStatus) {
        guard let choice, choice != (status.isUnderway ? .active : status) else { return }
        Task {
            await life.setStatus(of: id, named: head.name, to: choice, was: status, words: choice.shownWord)
        }
    }

    /// What a status means for its matters, in one small line; none while it is underway. Parking stops new agents only.
    private func meaning(of status: ProjectStatus) -> String? {
        switch status {
        case .parked: "No new agent starts on its matters."
        case .done: "Nothing more is asked about it."
        default: nil
        }
    }
}

extension ProjectStatus {
    /// The status as the app names it: active and waiting are one, underway.
    var shownWord: String {
        switch self {
        case .parked: "Parked"
        case .done: "Done"
        default: "Underway"
        }
    }
}
