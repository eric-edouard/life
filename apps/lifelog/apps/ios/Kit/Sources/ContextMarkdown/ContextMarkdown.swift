import Foundation
import Markdown

/// Where a link in a context goes: one of Life's things (`life:` and exactly the ref `fetch` opens), a web page, or
/// anything else, which the system opens (`tel:`, `mailto:`, Maps). The one reader of a link's destination.
public enum ContextLink: Equatable, Sendable {
    /// `ref` percent-decoded, as the card's `lifeLinks` name it; `words` the link's own text.
    case life(ref: String, words: String)
    case web(URL)
    case system(URL)

    private static let lifeScheme = "life:"
    /// What stays as it is in the URL a `life:` link carries; everything else is percent-encoded, `#` included.
    private static let kept = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    /// A Markdown link's destination; nil for one with no scheme, which shows as its words.
    public init?(destination: String, words: String = "") {
        if destination.hasPrefix(Self.lifeScheme) {
            let ref = String(destination.dropFirst(Self.lifeScheme.count))
            self = .life(ref: ref.removingPercentEncoding ?? ref, words: words)
        } else if let url = URL(string: destination), let scheme = url.scheme?.lowercased() {
            self = scheme == "http" || scheme == "https" ? .web(url) : .system(url)
        } else {
            return nil
        }
    }

    /// The link a tap gives back (`url`): a `life:` link carries its ref and words, each encoded, joined by `#`.
    public init?(url: URL) {
        let text = url.absoluteString
        guard text.hasPrefix(Self.lifeScheme) else {
            self.init(destination: text)
            return
        }
        let parts = text.dropFirst(Self.lifeScheme.count).split(separator: "#", omittingEmptySubsequences: false)
        let decoded = parts.map { String($0).removingPercentEncoding ?? String($0) }
        self = .life(ref: decoded[0], words: decoded.count > 1 ? decoded[1] : "")
    }

    /// The URL a `Text` link carries, read back by `init(url:)`.
    public var url: URL {
        switch self {
        case .web(let url), .system(let url): return url
        case .life(let ref, let words):
            let encode = { (text: String) in text.addingPercentEncoding(withAllowedCharacters: Self.kept) ?? "" }
            return URL(string: Self.lifeScheme + encode(ref) + "#" + encode(words)) ?? URL(filePath: "/")
        }
    }
}

/// A run of text in one style.
public struct Inline: Equatable, Sendable {
    public var text: String
    public var isBold = false
    public var isItalic = false
    public var isCode = false
    public var link: ContextLink?

    public init(_ text: String, isBold: Bool = false, isItalic: Bool = false, isCode: Bool = false, link: ContextLink? = nil) {
        (self.text, self.isBold, self.isItalic, self.isCode, self.link) = (text, isBold, isItalic, isCode, link)
    }
}

/// An item of a list: its marker (`•`, or `3.`), its words, and its own items, one level deep (deeper ones follow flat).
public struct ContextListItem: Equatable, Sendable {
    public let marker: String
    public let text: [Inline]
    public let items: [ContextListItem]
}

/// A block of a context as the sheet draws it (the spec's table, KitContext).
public enum ContextBlock: Equatable, Sendable {
    /// `#` and `##` are level 2 (the sheet's head is the only top level); `###` and deeper, 3.
    case heading(level: Int, [Inline])
    case paragraph([Inline])
    case list([ContextListItem])
    /// A message someone wrote, and the `*…*` line after it that says whose and where.
    case quote([Inline], source: [Inline]?)
    case code(String)
    case table(head: [[Inline]], rows: [[[Inline]]])
    /// `---`: a space, no line.
    case space
}

/// A card's context, read by Apple's swift-markdown into the blocks the sheet draws. Images and raw HTML are not
/// rendered: an image shows as a link to it, HTML as its text. A link inside code stays literal.
public enum ContextMarkdown {
    public static func blocks(_ markdown: String) -> [ContextBlock] {
        // The agent's words as written: no smart quotes or dashes.
        let children = Array(Document(parsing: markdown, options: .disableSmartOpts).children)
        var blocks: [ContextBlock] = []
        var index = 0
        while index < children.count {
            let child = children[index]
            index += 1
            if let quote = child as? BlockQuote {
                var (text, source) = quoted(quote)
                // `> words` then a blank line then `*source*`: the source is the paragraph after the quote.
                if source == nil, index < children.count, let line = sourceLine(children[index]) {
                    source = line
                    index += 1
                }
                blocks.append(.quote(text, source: source))
            } else {
                blocks.append(contentsOf: block(child))
            }
        }
        return blocks
    }

    private static func block(_ markup: any Markup) -> [ContextBlock] {
        switch markup {
        case let heading as Heading: [.heading(level: heading.level <= 2 ? 2 : 3, inlines(heading))]
        case let paragraph as Paragraph: [.paragraph(inlines(paragraph))]
        case let list as ListItemContainer: [.list(items(list, isNested: false))]
        case let quote as BlockQuote: [quoteBlock(quoted(quote))]
        case let code as CodeBlock: [.code(code.code.trimmingCharacters(in: .newlines))]
        case let html as HTMLBlock: [.paragraph([Inline(html.rawHTML.trimmingCharacters(in: .whitespacesAndNewlines))])]
        case let table as Table:
            [
                .table(
                    head: table.head.cells.map(inlines),
                    rows: table.body.rows.map { $0.cells.map(inlines) })
            ]
        case is ThematicBreak: [.space]
        default: []
        }
    }

    private static func quoteBlock(_ quote: (text: [Inline], source: [Inline]?)) -> ContextBlock {
        .quote(quote.text, source: quote.source)
    }

    /// A quote's words, its paragraphs one per line; its source when its last line is `*…*` alone.
    private static func quoted(_ quote: BlockQuote) -> (text: [Inline], source: [Inline]?) {
        var paragraphs = Array(quote.children)
        var source: [Inline]?
        if let last = paragraphs.last, let line = sourceLine(last) {
            source = line
            paragraphs.removeLast()
        } else if let last = paragraphs.last as? Paragraph {
            // `> words` then `*source*` on the next line: one paragraph, its last line the source.
            let parts = Array(last.inlineChildren)
            if parts.count >= 2, parts[parts.count - 2] is SoftBreak || parts[parts.count - 2] is LineBreak,
                let emphasis = parts.last as? Emphasis
            {
                source = inlines(emphasis)
                paragraphs[paragraphs.count - 1] = Paragraph(parts.dropLast(2))
            }
        }
        let text = paragraphs.enumerated().flatMap { index, block in
            (index > 0 ? [Inline("\n")] : []) + ((block as? InlineContainer).map(inlines) ?? [Inline(block.format())])
        }
        return (text, source)
    }

    /// A paragraph that is one `*…*` and nothing else: a quote's source.
    private static func sourceLine(_ markup: any Markup) -> [Inline]? {
        guard let paragraph = markup as? Paragraph, paragraph.childCount == 1,
            let emphasis = paragraph.child(at: 0) as? Emphasis
        else { return nil }
        return inlines(emphasis)
    }

    private static func items(_ list: ListItemContainer, isNested: Bool) -> [ContextListItem] {
        var number = (list as? OrderedList).map { Int($0.startIndex) }
        var found: [ContextListItem] = []
        for item in list.listItems {
            let marker = number.map { "\($0)." } ?? "•"
            number = number.map { $0 + 1 }
            let words = item.children.filter { !($0 is ListItemContainer) }.enumerated().flatMap { index, block in
                (index > 0 ? [Inline("\n")] : []) + ((block as? InlineContainer).map(inlines) ?? [Inline(block.format())])
            }
            let nested = item.children.compactMap { $0 as? ListItemContainer }.flatMap { items($0, isNested: true) }
            if isNested {
                found.append(ContextListItem(marker: marker, text: words, items: []))
                found.append(contentsOf: nested)
            } else {
                found.append(ContextListItem(marker: marker, text: words, items: nested))
            }
        }
        return found
    }

    private struct Style {
        var isBold = false
        var isItalic = false
        var link: ContextLink?
    }

    /// A container's runs, neighbours in the same style joined (the parser splits words at punctuation and tags).
    private static func inlines(_ container: any Markup) -> [Inline] {
        inlines(container, Style()).reduce(into: []) { runs, run in
            if var last = runs.last, last.isBold == run.isBold, last.isItalic == run.isItalic,
                last.isCode == run.isCode, last.link == run.link
            {
                last.text += run.text
                runs[runs.count - 1] = last
            } else {
                runs.append(run)
            }
        }
    }

    private static func inlines(_ container: any Markup, _ style: Style) -> [Inline] {
        container.children.flatMap { child -> [Inline] in
            var inner = style
            switch child {
            case let text as Markdown.Text: return [run(text.string, style)]
            case let code as InlineCode:
                return [Inline(code.code, isBold: style.isBold, isItalic: style.isItalic, isCode: true, link: style.link)]
            case is SoftBreak: return [run(" ", style)]
            case is LineBreak: return [run("\n", style)]
            case let html as InlineHTML: return [run(html.rawHTML, style)]
            case let image as Image:
                inner.link = image.source.flatMap { ContextLink(destination: $0) }
                return [run(image.plainText.isEmpty ? image.source ?? "" : image.plainText, inner)]
            case let link as Link:
                inner.link = link.destination.flatMap { ContextLink(destination: $0, words: link.plainText) }
            case is Strong: inner.isBold = true
            case is Emphasis: inner.isItalic = true
            default: break
            }
            return inlines(child, inner)
        }
    }

    private static func run(_ text: String, _ style: Style) -> Inline {
        Inline(text, isBold: style.isBold, isItalic: style.isItalic, link: style.link)
    }
}
