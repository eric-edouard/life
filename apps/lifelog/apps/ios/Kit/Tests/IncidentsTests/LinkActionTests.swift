import Foundation
import Testing

@testable import Incidents

@Test func aPairingLinkIsAskedAndASecondOneWaitsForTheFirst() {
    let pair = URL(string: "lifelog://pair?url=https://a.test&token=t")!
    #expect(LinkAction(url: pair, isPairLink: true, isPairing: false) == .pair)
    #expect(LinkAction(url: pair, isPairLink: true, isPairing: true) == .ignore)
}

@Test func anOpenLinkNamesItsRefAndOtherLinksDoNothing() {
    let open = URL(string: "lifelog://open?ref=person:ana")!
    #expect(LinkAction(url: open, isPairLink: false, isPairing: true) == .open("person:ana"))
    #expect(LinkAction(url: URL(string: "lifelog://open")!, isPairLink: false, isPairing: false) == .ignore)
    #expect(LinkAction(url: URL(string: "lifelog://other")!, isPairLink: false, isPairing: false) == .ignore)
}
