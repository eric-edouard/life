import LifeConnector
import SwiftUI

/// A project's Details (`DuoFoldProjectDetails`, from its header's info button or its chip's menu): its name, its status
/// as one control (underway, parked, done: one tap, said back with Undo), the goal it serves and its place among his
/// goals, its people (each opening their page), its chats and its repos with their folder on the Mac. A chat and a repo
/// are shown, never opened: Life's read names them (a chat's key, a repo's folder) but gives nothing the phone can open
/// (life#928).
struct ProjectDetails: View {
    let id: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        let state = life.projectHead[id] ?? ReadState()
        ReadScreen(
            shown: state.shown(), retry: { await life.refreshProjectHead(id) },
            loading: { PagePlaceholder() },
            empty: { EmptyView() },
            content: { header in page(header.project) }
        )
        .background(Palette.bg)
        .saysBack()
        .shellBar("")
        .task { await life.refreshProjectHead(id) }
    }

    private func page(_ head: ProjectHeader.Head) -> some View {
        let status = life.status(of: id, as: head.status)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(head.name).font(.screenName).foregroundStyle(Palette.fg)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, Metrics.gutter).stepsAsideForToast()
                ListLabel("Status")
                SegmentedChoice(
                    choices: [ProjectStatus.active, .parked, .done],
                    selection: Binding(
                        get: { status.isUnderway ? .active : status },
                        set: { choice in choose(choice, head: head, status: status) }),
                    title: \.shownWord
                )
                .offWhileOutOfReach()
                .padding(.horizontal, Metrics.gutter)
                if let goal = head.goal {
                    ListLabel("The goal it serves")
                    Row(
                        title: goal.text, icon: "list.bullet.indent", detail: "Your goal \(goal.rank) of \(goal.of)",
                        isInList: true
                    ) {}
                    .groupedRow(at: 0, of: 1)
                }
                if !head.people.isEmpty {
                    ListLabel("People")
                    ForEach(Array(head.people.enumerated()), id: \.element.ref) { at, party in
                        Button {
                            router.open(party: party.ref)
                        } label: {
                            Row(title: party.name, icon: "person", detail: party.line, isInList: true) {
                                Image(systemName: "chevron.right").font(.smallStrong).foregroundStyle(Palette.muted)
                            }
                        }
                        .buttonStyle(.groupedRow(at: at, of: head.people.count))
                    }
                }
                if !head.chats.isEmpty {
                    ListLabel("Chats")
                    ForEach(Array(head.chats.enumerated()), id: \.element.key) { at, chat in
                        Row(title: chat.name, icon: "person.2", isInList: true) {}
                            .groupedRow(at: at, of: head.chats.count)
                    }
                }
                if !head.repos.isEmpty {
                    ListLabel("Repos")
                    ForEach(Array(head.repos.enumerated()), id: \.element.name) { at, repo in
                        Row(title: repo.name, icon: "doc", detail: repo.folder, isInList: true) {}
                            .groupedRow(at: at, of: head.repos.count)
                    }
                }
            }
            .padding(.bottom, Metrics.Spacing.xl).readingWidth()
            .motion(Motion.standard, value: status)
        }
    }

    /// One tap: a status other than the one shown is his word, said back by its own name.
    private func choose(_ choice: ProjectStatus?, head: ProjectHeader.Head, status: ProjectStatus) {
        guard let choice, choice != (status.isUnderway ? .active : status) else { return }
        Task {
            await life.setStatus(of: id, named: head.name, to: choice, was: status, words: choice.shownWord)
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
