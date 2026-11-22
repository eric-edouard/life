import Foundation
import Testing

@testable import LifeConnector

/// An answer running when the phone is paired again: the new Life's card under the same ref starts at rest, and the
/// old tap's late failure never lands on it.
@Test func aLateEndOfAnActionFromAnEarlierPairingNeverLandsOnTheNewOne() {
    var book = ActionBook<String>()
    let key = "name:alex"
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

/// An answer the Mac says nothing about: "Still working…" after 8 s, then not done after 20 s, its same tap allowed again;
/// a word from Life (its plan, a step) starts the silence over, the phone's own retry step does not.
@Test func anActionTheMacSaysNothingAboutEndsNotDoneAfterTwentySeconds() {
    var book = ActionBook<String>()
    let (key, start) = ("answer:obs_1", Date(timeIntervalSince1970: 0))
    _ = book.begin(key, at: start)
    _ = book.apply(.planned([], limitSeconds: 10, at: start), to: key, begunIn: 0, at: start.addingTimeInterval(1))
    #expect(book.silence(of: key, at: start.addingTimeInterval(8)) == 8)
    _ = book.apply(
        .planned(["recorded"], limitSeconds: 30, at: start), to: key, begunIn: 0, at: start.addingTimeInterval(9))
    _ = book.apply(
        .passed("connection_retry", at: start, detail: [:]), to: key, begunIn: 0, at: start.addingTimeInterval(12))
    let early = book.endIfSilent(key, at: start.addingTimeInterval(28))
    let due = book.endIfSilent(key, at: start.addingTimeInterval(29))
    #expect(!early && due)
    guard case .failed(let failure, _)? = book[key] else {
        Issue.record("not ended")
        return
    }
    #expect(failure.reason == MacSilence.noAnswer && failure.canTryAgain && failure.isSameTap)
    #expect(book.silence(of: key, at: start.addingTimeInterval(40)) == nil)
    let again = book.endIfSilent(key, at: start.addingTimeInterval(40))
    #expect(!again)
}
