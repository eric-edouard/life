import Foundation
import Library
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
        struct Expected: Decodable { let origin: String, code: String, mac: String?, relay: String? }
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
        // The Mac's iroh key and relay, both of them or neither (`MacLink`): a link that names none pairs as before.
        #expect(pairing?.mac?.id == c.life?.mac, "\(c.case)")
        #expect(pairing?.mac?.relay.absoluteString == c.life?.relay, "\(c.case)")
    }
}

/// A link that names half of the Mac's key, or a relay that is not HTTPS, pairs over Tailscale: no iroh key at all.
@Test func aMacKeyNeedsItsIdAndAnHTTPSRelay() throws {
    func mac(_ link: String) throws -> MacKey? {
        let url = try #require(URL(string: link))
        return try #require(LifePairing(link: url)).mac
    }
    let id = "56229760d41db2765745bb773d7b49b9c7f55898762dcec483d18ec3d275da8d"
    let https = "https%3A%2F%2Frelay.example.test"
    let pair = "lifelog://pair?life=https%3A%2F%2Flife.example.ts.net&code=ABC234"
    #expect(try mac("\(pair)&mac=\(id)") == nil)
    #expect(try mac("\(pair)&relay=\(https)") == nil)
    #expect(try mac("\(pair)&mac=\(id)&relay=http%3A%2F%2Frelay.example.test") == nil)
    // Not a key's shape at all: iroh is what would refuse it, so the phone keeps none rather than a broken one.
    #expect(try mac("\(pair)&mac=nope&relay=\(https)") == nil)
    let relay = try #require(URL(string: "https://relay.example.test"))
    #expect(try mac("\(pair)&mac=\(id)&relay=\(https)") == MacKey(id: id, relay: relay))
}
