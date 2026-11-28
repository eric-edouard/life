import Foundation
import Testing

@testable import LifeConnector

@Test func theCacheKeepsEachReadsLastTextAndWhen() throws {
    let cache = ReadCache(directory: FileManager.default.temporaryDirectory.appending(path: "reads-\(UUID())"))
    #expect(cache.load("read_inbox") == nil)
    cache.store(#"{"total":1}"#, key: "read_inbox")
    cache.store(#"{"total":2}"#, key: "read_inbox")
    cache.store("matter", key: "read_matter/../x")
    let kept = try #require(cache.load("read_inbox"))
    #expect(kept.text == #"{"total":2}"#)
    #expect(abs(kept.at.timeIntervalSinceNow) < 60)
    #expect(cache.load("read_matter/../x")?.text == "matter")
    cache.clear()
    #expect(cache.load("read_inbox") == nil)
}
