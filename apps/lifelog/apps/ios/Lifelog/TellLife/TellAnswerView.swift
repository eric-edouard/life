import LifeConnector
import SwiftUI

/// One answer of Tell Life, by its kind (decision 88's closed list). Every chip or button either opens something
/// (`open`, by ref) or gives words as his (`tell`): an answer never acts on its own.
struct TellAnswerView: View {
    let answer: TellAnswer
    let again: () -> Void
    let open: (String) -> Void
    let tell: (String) -> Void

    static func head(_ words: String) -> some View {
        Text(words.withoutMarks).font(.tellAnswer).foregroundStyle(Palette.fg).fixedSize(
            horizontal: false, vertical: true)
    }

    static func note(_ words: String) -> some View {
        Text(words).font(.note).foregroundStyle(Palette.muted)
    }

    private func head(_ words: String) -> some View { Self.head(words) }
    private func note(_ words: String) -> some View { Self.note(words) }

    var body: some View {
        switch answer {
        case .reply(let words, let why, let sources):
            TellLightLine(kind: .answer)
            head(words)
            if let why { note(why) }
            ForEach(sources, id: \.self) { ref in QuietChip("Open source", symbol: "arrow.up.right") { open(ref) } }
        case .question(let question, let answers):
            TellLightLine(kind: .point)
            head(question)
            ForEach(answers, id: \.self) { words in QuietChip(words, symbol: "bubble.left") { tell(words) } }
        case .error(let what):
            TellLightLine(kind: .broken)
            head(what)
            note("Your words are kept.")
            QuietChip("Try again", symbol: "arrow.clockwise", action: again)
        case .unknown:
            TellLightLine(kind: .broken)
            note("Life answered in a way this app can't show yet.")
        }
    }
}
