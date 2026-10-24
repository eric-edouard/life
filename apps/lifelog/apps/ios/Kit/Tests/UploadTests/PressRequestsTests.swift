import Foundation
import Testing

@testable import ServerAPI

@Test func aQuickQuestionFillsTheAppUnlessItIsTooLong() throws {
    let prompt = QuickQuestion.prompt("Où est la gare ? Is it far?")
    #expect(prompt.hasPrefix("Below is a transcript of the last minute around me."))
    let link = try #require(QuickQuestion.link(.claude, text: prompt))
    #expect(link.absoluteString.hasPrefix("https://claude.ai/new?q=Below%20is"))
    #expect(URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == prompt)
    #expect(QuickQuestion.link(.chatgpt, text: prompt)?.host() == "chatgpt.com")
    #expect(QuickQuestion.link(.chatgpt, text: String(repeating: "é", count: 2_000)) == nil, "over 6 KB encoded")
}
