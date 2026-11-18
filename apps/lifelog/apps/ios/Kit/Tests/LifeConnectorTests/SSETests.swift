import Foundation
import Testing

@testable import LifeConnector

@Test func anEventIsItsDataLinesJoinedAndEndedByABlankLine() {
    var parser = SSEParser()
    // Split anywhere: mid-line, mid-keyword, between the two newlines.
    let events = ["data: one\n", "\nda", "ta: two\r\ndata:three\n", "\n"].flatMap { parser.feed(Data($0.utf8)) }
    #expect(events == ["one", "two\nthree"])
}

@Test func commentsAndOtherFieldsAreSkipped() {
    var parser = SSEParser()
    #expect(parser.feed(Data(": keep-alive\n\nevent: message\nid: 4\ndata: {\"a\":1}\n\n".utf8)) == [#"{"a":1}"#])
}

@Test func anEventCutBeforeItsBlankLineIsNeverGiven() {
    var parser = SSEParser()
    #expect(parser.feed(Data("data: whole\n\ndata: half\n".utf8)) == ["whole"])
}
