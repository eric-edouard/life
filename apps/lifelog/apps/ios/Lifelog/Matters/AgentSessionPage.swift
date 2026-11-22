import LifeConnector
import SwiftUI

/// An agent's session on pi, read-only (the owner's decision 2 of 22 Nov 2026): pi has no app of its own, so this is
/// where he reads one. Pushed from the agent's page; its newest lines, oldest first, the last in view. What Life sent it
/// in a passage box, its words as text, a tool call and its answer in code type (a failed one in `flag`), a compaction
/// as a muted note. Nothing here acts: what waits on him comes to the Inbox.
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

/// One line of a session, by its kind.
private struct SessionLineView: View {
    let line: AgentSession.Line

    var body: some View {
        switch line.kind {
        case .asked:
            Text(line.text).font(.body15).foregroundStyle(Palette.fg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Metrics.Spacing.m)
                .background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.passage))
        case .said:
            Text(line.text).font(.body15).foregroundStyle(Palette.fg)
        case .tool, .result:
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                if line.kind == .tool, let tool = line.tool {
                    Text(tool).font(.smallStrong).foregroundStyle(Palette.muted)
                }
                Text(line.text).font(.codeBlock).lineLimit(line.kind == .tool ? 4 : 6)
                    .foregroundStyle(line.isError == true ? Palette.flag : Palette.muted)
            }
        case .summary:
            Text(line.text).font(.note).foregroundStyle(Palette.muted)
        case .unknown:
            EmptyView()
        }
    }
}
