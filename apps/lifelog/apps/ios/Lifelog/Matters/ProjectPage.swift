import LifeConnector
import SwiftUI

/// A project's page: its name, its status as one control (underway, parked, done: one tap, said back with Undo), what
/// that means when it is not underway, his goal for it, and its matters as the list draws them (dimmed while it waits).
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
                    .padding(.top, Metrics.Spacing.s)
                SegmentedChoice(
                    choices: [ProjectStatus.active, .parked, .done],
                    selection: Binding(
                        get: { status.isUnderway ? .active : status },
                        set: { choice in choose(choice, head: head, status: status) }),
                    title: \.shownWord)
                if let line = meaning(of: status, matters: head.parkedMatters ?? matters.count) {
                    Text(line).font(.small).foregroundStyle(Palette.muted).appears()
                }
                if let goal = head.goal {
                    VStack(alignment: .leading, spacing: 8) {
                        Caps("Goal")
                        Text(goal).font(.lead).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
                    .frame(maxWidth: .infinity, alignment: .leading).card()
                }
                VStack(spacing: 0) {
                    ForEach(matters) { row in
                        Button {
                            router.open(matter: row.id)
                        } label: {
                            MatterRowView(
                                row: row, isChosen: false, isMarked: life.isImportant(row.id, as: row.important),
                                isParked: !status.isUnderway)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, -Metrics.Spacing.s)
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

    /// What a status means for its matters, in one small line; none while it is underway.
    private func meaning(of status: ProjectStatus, matters count: Int) -> String? {
        switch status {
        case .parked:
            count == 1
                ? "Its matter waits: no agent works on it." : "Its \(count) matters wait: no agent works on them."
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
