import Foundation
import Testing

@testable import Library

/// `MacLink`'s hook: a request for the paired origin's host goes to the bridge's loopback port (`MacRoute`).
@Test func thePairedOriginsRequestsGoToTheBridgeAndNoOther() throws {
    let life = try #require(URL(string: "https://life.example.ts.net/mcp?page=2"))
    let bridged = MacRoute.routed(life, pairedHost: "life.example.ts.net", bridgePort: 51_234)
    // Scheme, host and port are the bridge's; the request's own path and query are untouched.
    #expect(bridged.absoluteString == "http://127.0.0.1:51234/mcp?page=2")
    // Another host (the lifelog server, a page opened in a browser) is never taken to the Mac.
    let voice = try #require(URL(string: "https://mac.example.ts.net/voice/health"))
    #expect(MacRoute.routed(voice, pairedHost: "life.example.ts.net", bridgePort: 51_234) == voice)
}

@Test func theBridgeIsItsOwnSchemeHostAndPortWhateverTheOriginWas() throws {
    // A Life under a path keeps it, port or no port, http or https.
    for (link, expected) in [
        ("https://life.example.ts.net/voice", "http://127.0.0.1:8080/voice"),
        ("https://life.example.ts.net:8443/voice/mcp", "http://127.0.0.1:8080/voice/mcp"),
        ("http://127.0.0.1:46300/mcp", "http://127.0.0.1:8080/mcp"),
    ] {
        let url = try #require(URL(string: link), "\(link)")
        let host = try #require(url.host(), "\(link)")
        #expect(MacRoute.routed(url, pairedHost: host, bridgePort: 8080).absoluteString == expected, "\(link)")
    }
}

@Test func theHookRoutesOnlyWhileItIsSet() throws {
    // A host no other test's request names: the hook is the process's, and the suites run side by side.
    let host = "bridge-hook.example.test"
    defer { MacRoute.current = nil }
    let url = try #require(URL(string: "https://\(host)/mcp"))
    MacRoute.current = nil
    #expect(MacRoute.route(url) == url)
    MacRoute.current = MacRoute.Bridge(host: host, port: 51_234)
    #expect(MacRoute.route(url).absoluteString == "http://127.0.0.1:51234/mcp")
    // A bridge for another host carries nothing: the pairing moved, the URL is the old Mac's.
    MacRoute.current = MacRoute.Bridge(host: "other.example.test", port: 51_234)
    #expect(MacRoute.route(url) == url)
}
