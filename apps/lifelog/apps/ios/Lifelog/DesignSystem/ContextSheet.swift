import ContextMarkdown
import LifeConnector
import SafariServices
import SwiftUI

/// One of Life's things a context links to (`life:` and the ref `fetch` opens), with the link's words and its kind.
struct LifeLinkTarget: Hashable, Identifiable {
    let ref: String
    let words: String
    let kind: Check.LifeLink.Kind

    var id: String { ref }

    /// The small glyph a link of this kind leads with.
    static func glyph(_ kind: Check.LifeLink.Kind) -> String {
        switch kind {
        case .person: "person"
        case .appointment: "calendar"
        case .matter: "folder"
        case .message, .unit: "bubble"
        case .file: "doc"
        case .observation: "text.quote"
        case .conversation, .turn: "waveform"
        case .ask, .unknown: "link"
        }
    }
}

/// A context's Markdown, block by block, in KitContext's type (`ContextMarkdown` reads it; nothing here parses). A link
/// to one of Life's things goes to `openLife`; a web link opens in Safari over it; any other (`tel:`, `mailto:`, Maps)
/// to the system. Its text is selectable. The context sheet's body, and the open Duo's context in place.
struct ContextView: View {
    let lifeLinks: [Check.LifeLink]
    let openLife: (LifeLinkTarget) -> Void
    private let blocks: [ContextBlock]

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var web: WebPage?

    init(markdown: String, lifeLinks: [Check.LifeLink], openLife: @escaping (LifeLinkTarget) -> Void) {
        blocks = ContextMarkdown.blocks(markdown)
        (self.lifeLinks, self.openLife) = (lifeLinks, openLife)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                draw(block).padding(.top, index == 0 ? 0 : Self.space(above: block))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .tint(Palette.fg)
        .environment(
            \.openURL,
            OpenURLAction { url in
                switch ContextLink(url: url) {
                case .life(let ref, let words):
                    openLife(LifeLinkTarget(ref: ref, words: words, kind: kind(of: ref)))
                    return .handled
                case .web(let url):
                    web = WebPage(url: url)
                    return .handled
                case .system: return .systemAction
                // Never drawn as a link (`ContextLink`): nothing else opens.
                case nil: return .discarded
                }
            }
        )
        .sheet(item: $web) { SafariPage(url: $0.url).ignoresSafeArea() }
    }

    private static func space(above block: ContextBlock) -> CGFloat {
        switch block {
        case .heading(let level, _): level == 2 ? 20 : 16
        default: 10
        }
    }

    private func kind(of ref: String) -> Check.LifeLink.Kind {
        lifeLinks.first { $0.ref == ref }?.kind ?? .unknown
    }

    @ViewBuilder private func draw(_ block: ContextBlock) -> some View {
        switch block {
        case .heading(let level, let runs):
            text(runs).font(level == 2 ? TypeStep.contextHeading : TypeStep.bodyBold).foregroundStyle(Palette.fg)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let runs): paragraph(runs)
        case .list(let items): list(items)
        case .quote(let runs, let source):
            VStack(alignment: .leading, spacing: 6) {
                paragraph(runs)
                if let source { text(source).font(.small).foregroundStyle(Palette.muted) }
            }
            .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.tile))
        case .code(let code):
            ScrollView(.horizontal) {
                Text(verbatim: code).font(.codeBlock).lineSpacing(3).foregroundStyle(Palette.fg).fixedSize()
                    .padding(Metrics.Spacing.m)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.tile))
        case .table(let head, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 10) {
                    GridRow { ForEach(Array(head.enumerated()), id: \.offset) { text($0.element).font(.smallStrong) } }
                        .foregroundStyle(Palette.muted)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow { ForEach(Array(row.enumerated()), id: \.offset) { text($0.element).font(.note) } }
                            .foregroundStyle(Palette.fg)
                    }
                }
                .fixedSize().padding(Metrics.Spacing.m)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.tile))
        case .space: Color.clear.frame(height: 10)
        }
    }

    private func paragraph(_ runs: [Inline]) -> some View {
        text(runs).font(.body15).lineSpacing(3).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
    }

    /// A list's items: a hanging indent of 18, the marker in `muted`, 6 between items; an item's own items under it, one
    /// level deep (`ContextMarkdown` flattens deeper ones).
    private func list(_ items: [ContextListItem]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                row(item)
                ForEach(Array(item.items.enumerated()), id: \.offset) { row($0.element).padding(.leading, 18) }
            }
        }
    }

    private func row(_ item: ContextListItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(item.marker).font(.body15).foregroundStyle(Palette.muted).frame(minWidth: 18, alignment: .leading)
            paragraph(item.text)
        }
    }

    /// Runs as one `Text`: bold, italic, code on `tile`, and links: Life's in `ai` after their kind's glyph, the web's
    /// underlined with an arrow after. A link is a `Text` link, read back by `ContextLink(url:)`.
    private func text(_ runs: [Inline]) -> Text {
        runs.reduce(Text(verbatim: "")) { text, run in
            var string = AttributedString(run.text)
            string.link = run.link?.url
            if run.isCode {
                string.font = TypeStep.codeInline.font(at: typeSize)
                string.backgroundColor = Palette.tile
            }
            if case .life = run.link { string.foregroundColor = Palette.ai }
            var piece = Text(string)
            if run.isBold { piece = piece.bold() }
            if run.isItalic { piece = piece.italic() }
            switch run.link {
            case .life(let ref, _):
                let glyph = Text(Image(systemName: LifeLinkTarget.glyph(kind(of: ref)))).foregroundStyle(Palette.ai)
                return Text("\(text)\(glyph)\u{2009}\(piece)")
            case .web:
                return Text("\(text)\(piece.underline()) \(Image(systemName: "arrow.up.right"))")
            case .system, nil:
                return Text("\(text)\(piece)")
            }
        }
    }
}

/// The context sheet (decision 81): the system's sheet, its head the link's words and Close, its body the context. A
/// `life:` link pushes that thing's page inside it, with Back, at large. Nothing in it acts: he reads, then closes. It
/// opens at its own height when the context is shorter than medium.
struct ContextSheet: View {
    let title: String
    let markdown: String
    let lifeLinks: [Check.LifeLink]
    /// The asking agent's own app and its name: a quiet link under the context.
    var appLink: URL?
    var appName: String?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var path: [LifeLinkTarget] = []
    @State private var detent = PresentationDetent.medium
    /// The head's and the body's heights, and the sheet's own: the context's fit, and whether it is under medium.
    @State private var headHeight: CGFloat = 0
    @State private var bodyHeight: CGFloat = 0

    private var fit: CGFloat { headHeight + bodyHeight }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(alignment: .leading, spacing: 0) {
                SheetHeader(title: title) { dismiss() }
                    .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
                    .onGeometryChange(for: CGFloat.self) {
                        $0.size.height
                    } action: { height in
                        headHeight = height.rounded(.up)
                    }
                ScrollView {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                        ContextView(markdown: markdown, lifeLinks: lifeLinks) { target in
                            detent = .large
                            path.append(target)
                        }
                        if let appLink {
                            TextLink("Open in \(appName ?? "its app")", to: .outside) { openURL(appLink) }
                        }
                    }
                    .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.xl).readingWidth()
                    .onGeometryChange(for: CGFloat.self) {
                        $0.size.height
                    } action: { height in
                        bodyHeight = height.rounded(.up)
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Palette.sheet)
            // At medium the sheet's height is medium's: a context that fits under it opens at its own height.
            .onGeometryChange(for: CGFloat.self) {
                $0.size.height
            } action: { height in
                if detent == .medium, bodyHeight > 0, fit < height {
                    detent = .height(fit)
                }
            }
            .navigationDestination(for: LifeLinkTarget.self) { target in
                LifeLinkPage(target: target) { dismiss() }
            }
        }
        .presentationDetents(bodyHeight > 0 ? [.height(fit), .medium, .large] : [.medium, .large], selection: $detent)
    }
}

/// What a `life:` link names, as `fetch` gives it: a person by name and line, else Life's text. Pushed inside the
/// context sheet (Back pops it), or the root of a sheet of its own (no Back); Close closes the sheet.
struct LifeLinkPage: View {
    let target: LifeLinkTarget
    var isPushed = true
    let close: () -> Void

    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var back
    @State private var read = ReadState<LifeLinkRead>()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Metrics.Spacing.m) {
                if isPushed { RoundIconButton(symbol: "chevron.left", label: "Back") { back() } }
                Text(title).font(.sheetQuestion).foregroundStyle(Palette.fg).lineLimit(1)
                Spacer(minLength: 0)
                CloseButton(close: close)
            }
            .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
            .toolbar(.hidden, for: .navigationBar)
            ReadScreen(
                shown: read.shown(), retry: load, loading: { Spinner().frame(maxWidth: .infinity) },
                empty: { EmptyView() },
                content: { value in ScrollView { page(value).padding(.horizontal, Metrics.gutter).readingWidth() } }
            )
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.sheet)
        .task { await load() }
    }

    private var title: String {
        if case .person(let name, _)? = read.value { return name }
        return target.words
    }

    private func load() async { await life.fetch(target.ref) { read.apply($0) } }

    @ViewBuilder private func page(_ value: LifeLinkRead) -> some View {
        switch value {
        case .person(let name, let line):
            HStack(spacing: 14) {
                PartyDisc(name: name, size: .page)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.sheetQuestion).foregroundStyle(Palette.fg)
                    if let line { Text(line).font(.note).foregroundStyle(Palette.muted) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .text(let text):
            Text(verbatim: text).font(.body15).lineSpacing(3).foregroundStyle(Palette.fg).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A web page opened from a context: Safari's own view, over the sheet.
private struct WebPage: Identifiable {
    let url: URL
    var id: URL { url }
}

private struct SafariPage: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
