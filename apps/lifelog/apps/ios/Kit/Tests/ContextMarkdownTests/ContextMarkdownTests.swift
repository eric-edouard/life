import Foundation
import Testing

@testable import ContextMarkdown

private func words(_ runs: [Inline]) -> String { runs.map(\.text).joined() }

@Test func everyBlockOfTheSpecReadsAsItsBlock() throws {
    let blocks = ContextMarkdown.blocks(
        """
        # Top
        Ana asked on **12 Nov** whether you *signed* it.

        ### What I used
        - Your note
          - its date
            - deeper
        1. first
        2. second

        ---

        | Reply | Tone |
        | --- | --- |
        | Yes | Plain |

        ```
        BEGIN:VEVENT
        ```

        <b>raw</b>
        """)
    #expect(blocks.count == 9)
    guard case .heading(2, let top) = blocks[0] else { Issue.record("# is shown as ##"); return }
    #expect(words(top) == "Top")
    guard case .paragraph(let paragraph) = blocks[1] else { Issue.record("a paragraph"); return }
    #expect(paragraph.first { $0.isBold }?.text == "12 Nov")
    #expect(paragraph.first { $0.isItalic }?.text == "signed")
    guard case .heading(3, _) = blocks[2] else { Issue.record("### and deeper"); return }
    guard case .list(let bullets) = blocks[3] else { Issue.record("a list"); return }
    #expect(bullets.map(\.marker) == ["•"])
    #expect(bullets[0].items.map { words($0.text) } == ["its date", "deeper"], "one level deep, deeper flattens")
    guard case .list(let numbered) = blocks[4] else { Issue.record("an ordered list"); return }
    #expect(numbered.map(\.marker) == ["1.", "2."])
    #expect(blocks[5] == .space)
    guard case .table(let head, let rows) = blocks[6] else { Issue.record("a table"); return }
    #expect(head.map(words) == ["Reply", "Tone"])
    #expect(rows.map { $0.map(words) } == [["Yes", "Plain"]])
    #expect(blocks[7] == .code("BEGIN:VEVENT"))
    #expect(blocks[8] == .paragraph([Inline("<b>raw</b>")]), "HTML shows as its text")
}

@Test(arguments: [
    "> Bonjour, avez-vous signé ?\n*Ana, WhatsApp, 12 Nov*",
    "> Bonjour, avez-vous signé ?\n> *Ana, WhatsApp, 12 Nov*",
    "> Bonjour, avez-vous signé ?\n\n*Ana, WhatsApp, 12 Nov*",
    "> Bonjour, avez-vous signé ?\n>\n> *Ana, WhatsApp, 12 Nov*",
])
func aQuoteKeepsItsSourceLineWhereverItIsWritten(markdown: String) throws {
    let blocks = ContextMarkdown.blocks(markdown)
    #expect(blocks.count == 1)
    guard case .quote(let text, let source) = try #require(blocks.first) else {
        Issue.record("a quote")
        return
    }
    #expect(words(text) == "Bonjour, avez-vous signé ?")
    #expect(words(try #require(source)) == "Ana, WhatsApp, 12 Nov")
}

@Test func anItalicQuoteStaysTheQuoteAndTheLineAfterItIsItsSource() {
    #expect(ContextMarkdown.blocks("> *Approved*") == [.quote([Inline("Approved", isItalic: true)], source: nil)])
    #expect(
        ContextMarkdown.blocks("> *Approved*\n\n*Ana, mail, 3 Nov*")
            == [.quote([Inline("Approved", isItalic: true)], source: [Inline("Ana, mail, 3 Nov")])])
}

@Test func aQuoteWithNoSourceLineHasNone() {
    #expect(ContextMarkdown.blocks("> Just words\n\nThen *more*.").first == .quote([Inline("Just words")], source: nil))
}

@Test func linksAreLifesTheWebOrTheSystemsAndCodeStaysLiteral() throws {
    let blocks = ContextMarkdown.blocks(
        "[Ana's message](life:msg:whatsapp%7Cwhatsapp:155@s.whatsapp.net/M1), [rules](https://example.org/a), "
            + "[call](tel:+15550100), ![slip](https://example.org/slip.png) and `life:matter_aaaaaaaaaaaa`.")
    guard case .paragraph(let runs) = try #require(blocks.first) else { Issue.record("a paragraph"); return }
    let links = runs.compactMap(\.link)
    #expect(
        links == [
            .life(ref: "msg:whatsapp|whatsapp:155@s.whatsapp.net/M1", words: "Ana's message"),
            .web(try #require(URL(string: "https://example.org/a"))),
            .system(try #require(URL(string: "tel:+15550100"))),
            .web(try #require(URL(string: "https://example.org/slip.png"))),
        ])
    #expect(runs.first { $0.text == "slip" }?.link != nil, "an image shows as a link to it")
    let code = try #require(runs.first { $0.isCode })
    #expect(code.text == "life:matter_aaaaaaaaaaaa" && code.link == nil)
}

/// Only Life's things, the web, a call, a mail and Maps open; another app's scheme stays readable text.
@Test func onlyTheSchemesOfDecision81Open() throws {
    #expect(
        ContextLink(destination: "mailto:ana@example.org")
            == .system(try #require(URL(string: "mailto:ana@example.org"))))
    #expect(
        ContextLink(destination: "https://maps.apple.com/?q=cafe")
            == .system(try #require(URL(string: "https://maps.apple.com/?q=cafe"))))
    #expect(ContextLink(destination: "shortcuts://run-shortcut?name=x") == nil)
    let blocks = ContextMarkdown.blocks("[Run it](shortcuts://run-shortcut?name=x)")
    #expect(blocks == [.paragraph([Inline("Run it")])], "shown as its words, opening nothing")
}

@Test(arguments: [
    ContextLink.life(ref: "msg:whatsapp|whatsapp:155@s.whatsapp.net/M#1", words: "Ana's #1 message"),
    ContextLink.life(ref: "person:test-ana/year/2024", words: ""),
    ContextLink.web(URL(string: "https://example.org/a?b=c#d")!),
])
func aLinkComesBackFromTheURLItsTextCarries(link: ContextLink) throws {
    #expect(ContextLink(url: link.url) == link)
}
