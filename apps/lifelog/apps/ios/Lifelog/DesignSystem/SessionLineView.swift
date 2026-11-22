import LifeConnector
import SwiftUI

/// One line of an agent's session on pi (`AgentSessionPage`), by its kind: what Life sent it in a paper box, its words as
/// text, a tool call (its tool's name) and its answer ("Result") in code type, whole (Life cut each line), a failed turn
/// or answer under "Failed" in `flag`, a compaction as a muted note.
struct SessionLineView: View {
    let line: AgentSession.Line

    var body: some View {
        switch line.kind {
        case .asked:
            Text(line.text).font(.body15).foregroundStyle(Palette.fg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Metrics.Spacing.m).paperBox()
        case .said:
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                if line.isError == true { failed }
                Text(line.text).font(.body15).foregroundStyle(line.isError == true ? Palette.flag : Palette.fg)
            }
        case .tool, .result:
            // A call names its tool; its answer says so, and a failed one says it failed: never colour alone.
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                if line.isError == true {
                    failed
                } else {
                    Text(line.kind == .tool ? line.tool ?? "Tool" : "Result").font(.smallStrong)
                        .foregroundStyle(Palette.muted)
                }
                Text(line.text).font(.codeBlock)
                    .foregroundStyle(line.isError == true ? Palette.flag : Palette.muted)
            }
        case .summary:
            Text(line.text).font(.note).foregroundStyle(Palette.muted)
        case .unknown:
            EmptyView()
        }
    }

    private var failed: some View {
        Text("Failed").font(.smallStrong).foregroundStyle(Palette.flag)
    }
}
