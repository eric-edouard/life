import LifeConnector
import SwiftUI

/// One line of an agent's session on pi (`AgentSessionPage`), by its kind: what Life sent it in a paper box, its words as
/// text (a failed turn's why in `flag`), a tool call and its answer in code type (a failed one in `flag`), a compaction as a
/// muted note.
struct SessionLineView: View {
    let line: AgentSession.Line

    var body: some View {
        switch line.kind {
        case .asked:
            Text(line.text).font(.body15).foregroundStyle(Palette.fg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Metrics.Spacing.m).paperBox()
        case .said:
            Text(line.text).font(.body15).foregroundStyle(line.isError == true ? Palette.flag : Palette.fg)
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
