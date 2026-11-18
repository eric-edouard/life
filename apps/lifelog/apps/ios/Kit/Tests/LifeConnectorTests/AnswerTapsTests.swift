import Testing

@testable import LifeConnector

private let yes = AnswerRequest(ref: "c1", options: ["yes"])

@Test func aDroppedTapKeepsItsKeyAndAnyResultRenewsIt() {
    var taps = AnswerTaps()
    var made = 0
    let make = {
        made += 1
        return "k\(made)"
    }
    #expect(taps.key(for: yes, make: make) == "k1")
    taps.ended(yes, as: .failed(ActionFailure(.streamDropped), steps: []))
    #expect(taps.key(for: yes, make: make) == "k1")
    taps.ended(yes, as: .failed(ActionFailure(reason: "not sent", retry: .allowed), steps: []))
    #expect(taps.key(for: yes, make: make) == "k2")
    taps.ended(yes, as: .idle)
    #expect(taps.key(for: yes, make: make) == "k3")
    #expect(taps.key(for: AnswerRequest(ref: "c2", options: ["yes"]), make: make) == "k4")
}

/// A dropped "yes" that he leaves for "no" on the same card: "no" never carries the key Life may hold for "yes".
@Test func anotherAnswerToTheSameCardIsANewKey() {
    var taps = AnswerTaps()
    var made = 0
    let make = {
        made += 1
        return "k\(made)"
    }
    #expect(taps.key(for: yes, make: make) == "k1")
    taps.ended(yes, as: .failed(ActionFailure(.unreachable), steps: []))
    let no = AnswerRequest(ref: "c1", options: ["no"])
    #expect(taps.key(for: no, make: make) == "k2")
    #expect(taps.key(for: AnswerRequest(ref: "c1", options: ["no"], note: "later"), make: make) == "k3")
}
