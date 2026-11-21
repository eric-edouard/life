import LifeConnector
import SwiftUI

extension RuntimeName {
    /// The mark of the program an agent runs in, never a star: Claude's, OpenAI's for Codex (from each maker's own kit,
    /// as custom symbols in `Marks.xcassets`), and a terminal for any other or none known. Drawn in one colour (`fg`, or
    /// `icon` in a row), never `ai`: OpenAI's terms allow no colour on its mark.
    var mark: String {
        switch self {
        case .claude: "claude.mark"
        case .codex: "openai.mark"
        case .pi, .unknown: "apple.terminal"
        }
    }
}

extension Image {
    /// A symbol by name: one of Life's own (`Marks.xcassets`), else the system's.
    init(symbol name: String) {
        self = UIImage(named: name) == nil ? Image(systemName: name) : Image(name)
    }
}

extension Check {
    /// The mark of the agent asking (its program's, else a terminal); nil when Life asks itself.
    func agentMark(runtime: RuntimeName?) -> String? {
        agentName(runtime: nil) == nil ? nil : (runtime ?? .unknown).mark
    }
}

/// An agent as he reads it: its program's mark in `fg`, then its name in `ai` ("Halden house agent"; the program's when
/// none is read). The caller sets the font.
struct AgentLabel: View {
    let runtime: RuntimeName
    var name: String?

    var body: some View {
        Label {
            Text(name ?? runtime.name)
        } icon: {
            Image(symbol: runtime.mark).foregroundStyle(Palette.fg)
        }
        .foregroundStyle(Palette.ai)
    }
}

/// One agent in the Agents list (AgentsList): its program's mark in a 40 disc, its name, one muted line (what it holds
/// in words), the flag dot when something it holds needs him. Pressed through `groupedRow`.
struct AgentListRow: View {
    let runtime: RuntimeName
    let name: String
    let line: String
    let needsYou: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(symbol: runtime.mark).font(.system(size: 20)).foregroundStyle(Palette.fg)
                .frame(width: 40, height: 40).background(Circle().fill(Palette.tile)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.rowName).foregroundStyle(Palette.fg)
                Text(line).font(.small).foregroundStyle(Palette.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if needsYou { StateDot(color: Palette.flag) }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityValue(needsYou ? "Needs you" : "")
    }
}
