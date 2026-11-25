import LifeConnector
import SwiftUI

/// What a block may do: only his words and the phone's own screens, never an act of its own.
struct BlockActions {
    /// An answer he taps in a question goes as his words.
    var say: (String) -> Void = { _ in }
    var openSettings: () -> Void = {}
}

/// One of Life's components (`LifeBlock`). Items and pictures are Life's own things by ref, drawn live (`Items/`).
struct BlockView: View {
    let block: LifeBlock
    let actions: BlockActions
    @Environment(\.openURL) private var openURL
    @State private var shownPhrase: LifeBlock.Phrase?

    var body: some View {
        switch block {
        case .items(let refs): ItemsBlock(refs: refs)
        case .pictures(let refs): PicturesBlock(refs: refs)
        case .table(let table): TableBlock(table: table)
        case .document(let doc):
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                Text(doc.title).font(.rowTitle)
                ForEach(doc.lines, id: \.self) { Text($0).font(.line).foregroundStyle(Palette.muted) }
                if let total = doc.total { Text(total).font(.rowTitle) }
            }
            .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
        case .phrase(let phrase):
            Button {
                shownPhrase = phrase
            } label: {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    Text(phrase.text).font(.quote)
                    Text(phrase.mine).font(.line).foregroundStyle(Palette.muted)
                }
                .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
            }
            .buttonStyle(.plain)
            .fullScreenCover(item: $shownPhrase) { PhraseScreen(phrase: $0) }
        case .place(let place):
            Button {
                var c = URLComponents(string: "https://maps.apple.com/")
                c?.queryItems = [URLQueryItem(name: "q", value: "\(place.name), \(place.address)")]
                if let url = c?.url { openURL(url) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(place.name).font(.rowTitle)
                    Text(place.address).font(.line).foregroundStyle(Palette.muted)
                }
                .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
            }
            .buttonStyle(.plain)
        case .question(let q):
            VStack(spacing: Metrics.Spacing.s) {
                ForEach(q.answers, id: \.self) { answer in
                    Button(answer) { actions.say(answer) }
                        .buttonStyle(.pill(answer == q.recommended ? .filled : .quiet, size: .compact))
                }
            }
        case .settings:
            Button("Settings", action: actions.openSettings).buttonStyle(.pill(.quiet, size: .compact))
        }
    }
}

private struct TableBlock: View {
    let table: LifeBlock.Table

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: Metrics.Spacing.l, verticalSpacing: Metrics.Spacing.xs) {
            GridRow {
                ForEach(table.columns, id: \.self) { Text($0).font(.heading).foregroundStyle(Palette.muted) }
            }
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in Text(cell) } }
            }
            if let total = table.total {
                GridRow { Text(total).font(.rowTitle).gridCellColumns(table.columns.count) }
            }
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
