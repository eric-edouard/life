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

/// Markdown as `ContextMarkdown` reads it, drawn in the app's type.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            ForEach(Array(ContextMarkdown.blocks(text).enumerated()), id: \.offset) { _, block in draw(block) }
        }
    }

    @ViewBuilder private func draw(_ block: ContextBlock) -> some View {
        switch block {
        case .heading(let level, let runs): Text(runs.attributed).font(level == 2 ? .rowTitle : .header)
        case .paragraph(let runs): Text(runs.attributed)
        case .list(let items): ListView(items: items)
        case .quote(let runs, let source):
            VStack(alignment: .leading, spacing: 2) {
                Text(runs.attributed)
                if let source { Text(source.attributed).font(.line).foregroundStyle(Palette.muted) }
            }
            .padding(.leading, Metrics.Spacing.m).overlay(alignment: .leading) {
                Rectangle().fill(Palette.glass).frame(width: 2)
            }
        case .code(let code):
            Text(code).font(.monoDetail).padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.card, in: .rect(cornerRadius: Metrics.Radius.control))
        case .table(let head, let rows):
            Grid(alignment: .leading, horizontalSpacing: Metrics.Spacing.l, verticalSpacing: Metrics.Spacing.xs) {
                GridRow {
                    ForEach(Array(head.enumerated()), id: \.offset) { _, c in Text(c.attributed).font(.heading) }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, c in Text(c.attributed) } }
                }
            }
        case .space: Color.clear.frame(height: Metrics.Spacing.s)
        }
    }
}

private struct ListView: View {
    let items: [ContextListItem]

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.s) {
                    Text(item.marker).foregroundStyle(Palette.muted)
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Text(item.text.attributed)
                        if !item.items.isEmpty { ListView(items: item.items) }
                    }
                }
            }
        }
    }
}

extension [Inline] {
    /// The runs as one styled text. A web or system link opens; a `life:` name is bold and opens (`life-open:`, handled by `AnswerView`).
    var attributed: AttributedString {
        reduce(into: AttributedString()) { text, run in
            var piece = AttributedString(run.text)
            if run.isBold { piece.inlinePresentationIntent = .stronglyEmphasized }
            if run.isItalic {
                piece.inlinePresentationIntent = (piece.inlinePresentationIntent ?? []).union(.emphasized)
            }
            if run.isCode { piece.inlinePresentationIntent = .code }
            switch run.link {
            case .web(let url), .system(let url): piece.link = url
            case .life(let ref, _):
                piece.inlinePresentationIntent = .stronglyEmphasized
                piece.link = URL(
                    string: "life-open:" + (ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ref))
            case nil: break
            }
            text += piece
        }
    }
}

/// What a `life:` link names: a person's profile, else Life's own text of it.
struct LinkSheet: View {
    let ref: String
    @Environment(LifeStore.self) private var life
    @State private var read = ReadState<LifeLinkRead>()

    var body: some View {
        if ref.hasPrefix("person:") {
            ProfileView(ref: ref).sheetStack()
        } else {
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
}
