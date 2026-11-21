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
        case .done(let what, let undo):
            TellLightLine(kind: .answer)
            head(what)
            note("On your list.")
            if undo != nil { QuietChip("Undo", symbol: "arrow.uturn.backward", isMuted: true) { tell("Undo that") } }
        case .agent(let agent, let told, let back):
            TellLightLine(kind: .answer)
            head("\(agent) is on it")
            TellStrandRow(title: agent, isDone: false)
            note("What it was told: \(told)")
            if let back { note(back) }
        case .card(let ref):
            TellLightLine(kind: .answer)
            head("A card is ready in your Inbox")
            QuietChip("Open in Inbox", symbol: "tray") { open(ref) }
        case .fix(let before, let after, let places, let undo):
            TellLightLine(kind: .answer)
            Text(before).font(.small).foregroundStyle(Palette.muted).strikethrough()
            head(after)
            note("Fixed in \(places) \(places == 1 ? "place" : "places")")
            if undo != nil { QuietChip("Undo", symbol: "arrow.uturn.backward", isMuted: true) { tell("Undo that") } }
        case .question(let words, let answers):
            TellLightLine(kind: .point)
            head(words)
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
