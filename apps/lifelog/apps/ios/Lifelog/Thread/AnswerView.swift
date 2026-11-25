import ContextMarkdown
import LifeConnector
import SwiftUI

/// What Life says: its Markdown (headings, lists, quotes, code, tables) and, between, its own blocks. What it can't
/// show (an image, HTML) shows as its words.
struct AnswerView: View {
    let parts: [AnswerPart]
    let actions: BlockActions

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .markdown(let text): MarkdownView(text: text)
                case .block(let block): BlockView(block: block, actions: actions)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What a `life:` link names that is neither a person nor an ask: Life's own text of it, a sheet (the one exception to
/// "nothing of Life's opens a screen", beside a picture or a phrase).
struct LinkSheet: View {
    let ref: String
    @Environment(LifeStore.self) private var life
    @State private var read = ReadState<LifeLinkRead>()

    var body: some View {
        ScrollView {
            switch read.value {
            case .person(let name, let line)?: Text([name, line].compactMap { $0 }.joined(separator: "\n"))
            case .text(let text)?: MarkdownView(text: text)
            case nil: Spinner().frame(maxWidth: .infinity)
            }
        }
        .padding(Metrics.Spacing.l).task { await life.fetch(ref) { read.apply($0) } }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}
