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

/// The links every app reads alike (`fixtures/wire/pairing-links.json`).
@Test func aLinkGivesLifesOriginAndCodeOverHTTPSOrLoopback() throws {
    struct Case: Decodable {
        struct Expected: Decodable { let origin: String, code: String }
        let `case`: String
        let link: String
        let life: Expected?
    }
    let cases = try JSONDecoder().decode([Case].self, from: Data(try wireText("pairing-links.json").utf8))
    #expect(cases.filter { $0.life != nil }.count == 3)
    for c in cases {
        let pairing = LifePairing(link: try #require(URL(string: c.link), "\(c.case)"))
        #expect(pairing?.origin.absoluteString == c.life?.origin, "\(c.case)")
        #expect(pairing?.code == c.life?.code, "\(c.case)")
    }
}
