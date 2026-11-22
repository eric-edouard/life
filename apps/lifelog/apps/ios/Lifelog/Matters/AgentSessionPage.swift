import LifeConnector
import SwiftUI

/// An agent's session on pi, read-only (the owner's decision 2 of 22 Nov 2026): pi has no app of its own, so this is
/// where he reads one. Pushed from the agent's page; its newest lines, oldest first, the last in view, each a
/// `SessionLineView`. Nothing here acts: what waits on him comes to the Inbox.
struct AgentSessionPage: View {
    let id: String

    @Environment(LifeStore.self) private var life

    var body: some View {
        ReadScreen(
            shown: (life.agentSession[id] ?? ReadState()).shown { $0.lines.isEmpty },
            retry: { await life.refreshAgentSession(id) },
            loading: { Spinner().foregroundStyle(Palette.fg).frame(maxHeight: .infinity) },
            empty: { Notice(title: "Nothing yet.", detail: "Its session shows here once its first turn begins.") },
            content: page
        )
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.bg)
        .screenTitle("Session")
        .shellBar("", hasSettings: false)
        .task { await life.refreshAgentSession(id) }
    }

    private func page(_ session: AgentSession) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                ForEach(Array(session.lines.enumerated()), id: \.offset) { _, line in
                    SessionLineView(line: line)
                }
            }
            .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
            .readingWidth()
        }
        .defaultScrollAnchor(.bottom)
    }
}
