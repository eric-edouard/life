import ContextMarkdown
import LifeConnector
import SwiftUI

// Life's words and its answer blocks, as components: Markdown in the app's type, then a document, a phrase, a place and a table.

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
        case .heading(let level, let runs): InkText(text: runs.attributed).font(level == 2 ? .rowTitle : .header)
        case .paragraph(let runs): InkText(text: runs.attributed)
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
                        InkText(text: item.text.attributed)
                        if !item.items.isEmpty { ListView(items: item.items) }
                    }
                }
            }
        }
    }
}

extension URL {
    /// A `life:` ref as a link `RootView` opens (`life-open:`), the one way to open a profile, an ask or a page.
    static func lifeOpen(_ ref: String) -> URL? {
        URL(string: "life-open:" + (ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ref))
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
                piece.link = .lifeOpen(ref)
            case nil: break
            }
            text += piece
        }
    }
}

/// A document Life shows (an invoice): its title, its lines, its total, on a card.
struct DocumentBlock: View {
    let title: String
    let lines: [String]
    var total: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text(title).font(.rowTitle)
            ForEach(lines, id: \.self) { Text($0).font(.line).foregroundStyle(Palette.muted) }
            if let total { Text(total).font(.rowTitle) }
        }
        .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
    }
}

/// A phrase to say to someone, with what it means: tapping it shows it full screen.
struct PhraseBlock: View {
    let text: String
    let mine: String

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text(text).font(.quote)
            Text(mine).font(.line).foregroundStyle(Palette.muted)
        }
        .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
    }
}

/// A place: its name and address on a card; tapping it opens Maps.
struct PlaceBlock: View {
    let name: String
    let address: String

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs / 2) {
            Text(name).font(.rowTitle)
            Text(address).font(.line).foregroundStyle(Palette.muted)
        }
        .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading).card()
    }
}

/// Life's table: its columns muted, its rows, its total.
struct TableBlock: View {
    let columns: [String]
    let rows: [[String]]
    var total: String?

    var body: some View {
        // Full width: the label column left, the numbers right-aligned, no rules (spacing only).
        Grid(alignment: .trailing, horizontalSpacing: Metrics.Spacing.l, verticalSpacing: Metrics.Spacing.s) {
            GridRow {
                ForEach(Array(columns.enumerated()), id: \.offset) { i, name in
                    Text(name).font(.heading).foregroundStyle(Palette.muted)
                        .gridColumnAlignment(i == 0 ? .leading : .trailing)
                        .frame(maxWidth: i == 0 ? .infinity : nil, alignment: i == 0 ? .leading : .trailing)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { i, cell in
                        Text(cell).monospacedDigit().frame(
                            maxWidth: i == 0 ? .infinity : nil, alignment: i == 0 ? .leading : .trailing)
                    }
                }
            }
            if let total {
                GridRow {
                    Text("Total").font(.rowTitle).frame(maxWidth: .infinity, alignment: .leading)
                    Text(total).font(.rowTitle).monospacedDigit().gridCellColumns(max(columns.count - 1, 1))
                        .gridColumnAlignment(.trailing)
                }
                .padding(.top, Metrics.Spacing.xs)
            }
        }
        .frame(maxWidth: .infinity)
    }
}
