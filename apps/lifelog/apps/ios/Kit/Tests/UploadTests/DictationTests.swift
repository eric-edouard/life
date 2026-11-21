import Foundation
import ServerAPI
import Testing

@Test func onlyWhatNeverReachedThePaidStepMayGoAgain() {
    let server = { (status: Int) in ServerClient.ClientError.server(status: status, code: nil, message: "") }
    #expect(DictationFailure(server(503)) == .notReached, "busy: nothing billed")
    #expect(DictationFailure(ServerClient.ClientError.notPaired) == .notReached)
    #expect(DictationFailure(URLError(.cannotConnectToHost)) == .notReached, "it never left the phone")
    #expect(DictationFailure(server(502)) == .notWritten, "Thai words missing")
    #expect(DictationFailure(server(400)) == .notWritten)
    #expect(DictationFailure(URLError(.timedOut)) == .notWritten, "it may have been heard")
    #expect(DictationFailure(URLError(.networkConnectionLost)) == .notWritten)
}

@Test func dictatedWordsGoWhereTheCaretIsWithASpaceWhereAWordWouldTouch() {
    func insert(_ words: String, _ text: String, _ from: Int, _ to: Int? = nil) -> (String, Int) {
        let start = text.index(text.startIndex, offsetBy: from)
        let end = text.index(text.startIndex, offsetBy: to ?? from)
        let (result, caret) = DictatedText.inserting(words, into: text, at: start..<end)
        return (result, result.distance(from: result.startIndex, to: caret))
    }
    #expect(DictatedText.inserting(" the keys ", into: "", at: nil).text == "the keys")
    #expect(DictatedText.inserting("are here.", into: "The keys", at: nil).text == "The keys are here.")
    #expect(insert("keys", "The are here.", 4) == ("The keys are here.", 8))
    #expect(insert("Keys", "the keys", 0) == ("Keys the keys", 4))
    #expect(insert("door", "the keys, please", 4, 8) == ("the door, please", 8), "a selection is replaced")
    #expect(insert("", "same", 2) == ("same", 2))
}

/// A fake microphone and Mac: each `begin` and each ask waits until the test lets it go.
@MainActor private final class Rig {
    var begins: [CheckedContinuation<Void, Never>] = []
    var asks: [(ogg: Data, answer: CheckedContinuation<Result<String, any Error>, Never>)] = []
    var finished = 0
    var recordings = 0
    var ended: (@MainActor () -> Void)?
    var refused = false

    lazy var dictation = Dictation(
        begin: { ended in
            self.ended = ended
            await withCheckedContinuation { self.begins.append($0) }
            self.recordings += 1
            let bytes = Data("run \(self.recordings)".utf8)
            return DictationRun(level: { 0.1 }) {
                self.finished += 1
                return bytes
            }
        },
        words: { ogg in
            try await withCheckedContinuation { continuation in
                Task { @MainActor in self.asks.append((ogg, continuation)) }
            }.get()
        },
        refused: { self.refused })

    func until(_ condition: () -> Bool) async {
        for _ in 0..<10_000 where !condition() { await Task.yield() }
        #expect(condition())
    }
}

@MainActor @Test func aRunPausedWhileTheMicrophoneIsAskedForClosesOnceAndItsWordsLand() async {
    let rig = Rig()
    rig.dictation.tap()
    #expect(rig.dictation.phase == .starting)
    rig.dictation.tap()  // let go during the permission sheet
    #expect(rig.dictation.phase == .writing)
    await rig.until { rig.begins.count == 1 }
    rig.begins[0].resume()
    await rig.until { rig.asks.count == 1 }
    #expect(rig.finished == 1)
    rig.asks[0].answer.resume(returning: .success("the keys"))
    await rig.until { rig.dictation.phase == .rest }
    #expect(rig.dictation.landed?.words == "the keys")
}

@MainActor @Test func aCancelledRunsWordsNeverLandAndTheNextRunsDo() async {
    let rig = Rig()
    rig.dictation.tap()
    await rig.until { rig.begins.count == 1 }
    rig.begins[0].resume()
    await rig.until { rig.dictation.phase == .listening }
    rig.dictation.tap()
    await rig.until { rig.asks.count == 1 }
    rig.dictation.cancel()
    rig.dictation.tap()
    await rig.until { rig.begins.count == 2 }
    rig.begins[1].resume()
    await rig.until { rig.dictation.phase == .listening }
    rig.dictation.tap()
    await rig.until { rig.asks.count == 2 }
    rig.asks[0].answer.resume(returning: .success("old words"))
    rig.asks[1].answer.resume(returning: .success("new words"))
    await rig.until { rig.dictation.landed != nil }
    #expect(rig.dictation.landed?.words == "new words")
}

@MainActor @Test func onlyARecordingThatNeverReachedTheMacGoesAgain() async {
    let rig = Rig()
    rig.dictation.tap()
    await rig.until { rig.begins.count == 1 }
    rig.begins[0].resume()
    rig.ended?()  // the cap, a call: the run pauses on its own
    await rig.until { rig.asks.count == 1 }
    rig.asks[0].answer.resume(returning: .failure(URLError(.cannotConnectToHost)))
    await rig.until { rig.dictation.problem != nil }
    #expect(rig.dictation.problem?.fix?.title == "Try again")
    rig.dictation.fix {}
    await rig.until { rig.asks.count == 2 }
    #expect(rig.asks[1].ogg == rig.asks[0].ogg, "the same bytes")
    rig.asks[1].answer.resume(returning: .failure(URLError(.timedOut)))
    await rig.until { rig.dictation.problem == .notWritten }
    rig.dictation.fix {}
    #expect(rig.dictation.phase == .starting, "Speak again opens the microphone; those bytes never go again")
    #expect(rig.finished == 1)
}

@MainActor @Test func aRefusedMicrophoneSaysSoAndOpensNothing() {
    let rig = Rig()
    rig.refused = true
    rig.dictation.tap()
    #expect(rig.dictation.problem == .refused && rig.dictation.phase == .rest && rig.begins.isEmpty)
}
