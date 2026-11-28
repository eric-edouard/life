import Testing

@testable import LifeConnector

@Test func aReleaseNearATurnsTopSettlesThereAndNothingSnapsMidAnswer() {
    let tops = [0.0, 900, 2400]
    #expect(ThreadTurns.settled(860, tops: tops, reach: 120) == 900)
    #expect(ThreadTurns.settled(2510, tops: tops, reach: 120) == 2400)
    // Deep inside a long answer: left where it was going.
    #expect(ThreadTurns.settled(1600, tops: tops, reach: 120) == 1600)
    #expect(ThreadTurns.settled(50, tops: [], reach: 120) == 50)
}

@Test func hisQuestionStepsDownBySize() {
    #expect(ThreadTurns.size(of: "Did Jade answer?") == .short)
    #expect(ThreadTurns.size(of: String(repeating: "word ", count: 15)) == .medium)
    #expect(ThreadTurns.size(of: String(repeating: "word ", count: 40)) == .long)
}
