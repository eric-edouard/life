import LifeConnector
import SwiftUI

/// One answer of Tell Life, by its kind (decision 88's closed list). Every chip or button either opens something
/// (`open`, by ref) or gives words as his (`tell`): an answer never acts on its own.
struct TellAnswerView: View {
    let answer: TellAnswer
    let again: () -> Void
    let open: (String) -> Void
    let tell: (String) -> Void

    private func head(_ words: String) -> some View { TellHead(words: words) }
    private func note(_ words: String) -> some View { TellNote(words: words) }

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
        case .done(let words, let matter):
            TellLightLine(kind: .answer)
            head(words)
            if let matter { QuietChip("Open matter", symbol: "arrow.up.right") { open(matter) } }
        case .agent(let words, let agent, let told):
            TellLightLine(kind: .answer)
            head(words)
            TellStrandRow(title: agent, isDone: false)
            note("What it was told: \(told)")
        case .card(let words, let card):
            TellLightLine(kind: .answer)
            head(words)
            QuietChip("Open in Inbox", symbol: "tray") { open(card) }
        case .fix(let words):
            TellLightLine(kind: .answer)
            head(words)
            note("The caretaker has it.")
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
