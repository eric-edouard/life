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
        case .unknown: "apple.terminal"
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

/// An agent as he reads it: its program's mark in `fg`, then the program's name in `ai`. The caller sets the font.
struct AgentLabel: View {
    let runtime: RuntimeName

    var body: some View {
        Label {
            Text(runtime.name)
        } icon: {
            Image(symbol: runtime.mark).foregroundStyle(Palette.fg)
        }
        .foregroundStyle(Palette.ai)
    }
}
