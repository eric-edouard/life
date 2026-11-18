import Testing

@testable import LifeConnector

@Test func aDroppedTapKeepsItsKeyAndAnyResultRenewsIt() {
    var taps = AnswerTaps()
    var made = 0
    let make = {
        made += 1
        return "k\(made)"
    }
    #expect(taps.key(for: "c1", make: make) == "k1")
    taps.ended("c1", as: .failed(ActionFailure(.streamDropped), steps: []))
    #expect(taps.key(for: "c1", make: make) == "k1")
    taps.ended("c1", as: .failed(ActionFailure(reason: "not sent", retry: .allowed), steps: []))
    #expect(taps.key(for: "c1", make: make) == "k2")
    taps.ended("c1", as: .idle)
    #expect(taps.key(for: "c1", make: make) == "k3")
    #expect(taps.key(for: "c2", make: make) == "k4")
}
