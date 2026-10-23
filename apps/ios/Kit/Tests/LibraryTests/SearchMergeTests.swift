import Foundation
import Library
import Testing
import Timeline

private func id(_ minutes: Int64) -> UUID {
    ConversationID(anchor: CaptureInstant(millis: 1_791_392_400_000 + minutes * 60_000)).serverID
}

private func at(_ conversation: UUID, _ seconds: Int64) -> CaptureInstant {
    (ConversationID(serverID: conversation)?.anchor ?? CaptureInstant(millis: 0)).advanced(by: seconds * 1000)
}

private func words(_ conversation: UUID, passage: Int64?) -> SearchMatch {
    SearchMatch(
        conversation: conversation, passage: passage.map { at(conversation, $0) }, snippet: "words", source: .words)
}

private func meaning(_ conversation: UUID, _ from: Int64, _ text: String = "meaning") -> MeaningHit {
    MeaningHit(conversation: conversation, passage: at(conversation, from)..<at(conversation, from + 45), text: text)
}

@Test func wordMatchesComeFirstAndMeaningAddsOnlyWhatTheyMissed() {
    let a = id(0)
    let b = id(60)
    let c = id(120)
    let merged = SearchMerge.merge(
        words: [words(b, passage: 10), words(a, passage: 300)],
        meaning: [meaning(c, 0, "the ferry leaves early"), meaning(a, 300)])
    #expect(merged.map(\.conversation) == [b, a, c])
    #expect(merged.map(\.source) == [.words, .words, .meaning])
    // The meaning hit in `a` is the passage words already found: one row, words' own.
    #expect(merged[1] == words(a, passage: 300))
    #expect(merged[2].passage == at(c, 0))
    #expect(merged[2].snippet == "the ferry leaves early")
}

@Test func meaningKeepsTheBestPassagePerConversation() {
    let a = id(0)
    let merged = SearchMerge.merge(words: [], meaning: [meaning(a, 90, "best"), meaning(a, 0, "second")])
    #expect(merged == [SearchMatch(conversation: a, passage: at(a, 90), snippet: "best", source: .meaning)])
}

@Test func aWordMatchWithoutAPassageOpensAtTheMeaningPassage() {
    // Words matched the title only; meaning knows where in the conversation.
    let a = id(0)
    let merged = SearchMerge.merge(words: [words(a, passage: nil)], meaning: [meaning(a, 120)])
    #expect(merged == [SearchMatch(conversation: a, passage: at(a, 120), snippet: "words", source: .words)])
}

@Test func offlineIsWordsOnly() {
    let matches = [words(id(0), passage: 5), words(id(9), passage: nil)]
    #expect(SearchMerge.merge(words: matches, meaning: []) == matches)
}
