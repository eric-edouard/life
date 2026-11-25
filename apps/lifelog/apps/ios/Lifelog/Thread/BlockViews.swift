import LifeConnector
import SwiftUI

/// What a block may do: only his words and the phone's own screens, never an act of its own.
struct BlockActions {
    /// An answer he taps in a question goes as his words.
    var say: (String) -> Void = { _ in }
    var openSettings: () -> Void = {}
}

/// One of Life's components (`LifeBlock`). Items and pictures are Life's own things by ref, drawn live (`Items/`); the
/// rest are the design system's blocks.
struct BlockView: View {
    let block: LifeBlock
    let actions: BlockActions
    @Environment(\.openURL) private var openURL
    @State private var shownPhrase: LifeBlock.Phrase?

    var body: some View {
        switch block {
        case .items(let refs): ItemsBlock(refs: refs)
        case .pictures(let refs): PicturesBlock(refs: refs)
        case .table(let table): TableBlock(columns: table.columns, rows: table.rows, total: table.total)
        case .document(let doc): DocumentBlock(title: doc.title, lines: doc.lines, total: doc.total)
        case .phrase(let phrase):
            Button {
                shownPhrase = phrase
            } label: {
                PhraseBlock(text: phrase.text, mine: phrase.mine)
            }
            .buttonStyle(.plain)
            .fullScreenCover(item: $shownPhrase) { PhraseScreen(phrase: $0) }
        case .place(let place):
            Button {
                var c = URLComponents(string: "https://maps.apple.com/")
                c?.queryItems = [URLQueryItem(name: "q", value: "\(place.name), \(place.address)")]
                if let url = c?.url { openURL(url) }
            } label: {
                PlaceBlock(name: place.name, address: place.address)
            }
            .buttonStyle(.plain)
        case .question(let q): QuestionBlock(answers: q.answers, recommended: q.recommended, say: actions.say)
        case .settings:
            Button("Settings", action: actions.openSettings).buttonStyle(.pill(.quiet, size: .compact))
        }
    }
}

/// A phrase to show someone, full screen: holding the phone up is the task.
private struct PhraseScreen: View {
    let phrase: LifeBlock.Phrase
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Text(phrase.text).font(.profileName).multilineTextAlignment(.center).padding(Metrics.Spacing.xl)
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.bg).onTapGesture { dismiss() }
            .overlay(alignment: .topTrailing) { CloseButton { dismiss() }.padding(Metrics.Spacing.l) }
    }
}
