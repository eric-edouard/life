import Testing

@testable import LifeConnector

/// His "Wrong…" running when the phone is paired again: the new Life's card under the same ref starts at rest, and the
/// old press's late failure never lands on it.
@Test func aLateEndOfAnActionFromAnEarlierPairingNeverLandsOnTheNewOne() {
    var book = ActionBook<String>()
    let key = "complaint name:alex"
    let (began, again) = (book.begin(key), book.begin(key))
    #expect(began && !again)
    let begun = book.pairing
    book.startOver(pairing: 1)
    #expect(book[key] == nil)
    let fresh = book.begin(key)
    let late = book.apply(.failed(ActionFailure(.unreachable)), to: key, begunIn: begun)
    #expect(fresh && !late)
    #expect(book[key]?.isRunning == true)
    let own = book.apply(.succeeded(.recorded), to: key, begunIn: book.pairing)
    #expect(own && book[key] == .succeeded(.recorded, steps: []))
    book.forget(key)
    #expect(book[key] == nil)
}
