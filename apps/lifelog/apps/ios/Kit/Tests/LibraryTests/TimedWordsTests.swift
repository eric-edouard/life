import Foundation
import Testing

@testable import Library

// "Say hi to Kit": each word's length counts the spacing before it.
private let text = "Say hi to Kit"
private let words: [[Int64]] = [[0, 300, 3], [400, 600, 3], [700, 800, 3], [900, 1200, 4]]

@Test func wordsHaveTheirRangeWithoutTheSpacing() {
    #expect(
        words.ranges(in: text) == [
            NSRange(location: 0, length: 3), NSRange(location: 4, length: 2),
            NSRange(location: 7, length: 2), NSRange(location: 10, length: 3),
        ])
}

@Test func theSpokenWordIsTheLastBegun() {
    #expect(words.spokenIndex(at: -1) == nil)
    #expect(words.spokenIndex(at: 0) == 0)
    #expect(words.spokenIndex(at: 650) == 1)
    #expect(words.spokenIndex(at: 9_999) == 3)
    #expect(words.spoken(at: 650, in: text) == NSRange(location: 4, length: 2))
}

@Test func wordsThatDontFitTheTextAreNone() {
    #expect(words.ranges(in: "Say hi") == nil)
    #expect([[0, 100]].ranges(in: "Say") == nil)
    #expect(words.spoken(at: 0, in: "Say hi") == nil)
}
