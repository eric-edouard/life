import Foundation
@testable import ServerAPI
import Testing

@Test func onlyWhatNeverReachedThePaidStepMayGoAgain() {
    let server = { (status: Int) in ServerClient.ClientError.server(status: status, code: nil, message: "") }
    let busy = ServerClient.ClientError.server(status: 503, code: "identity_busy", message: "")
    #expect(DictationFailure(busy) == .notReached, "the route said busy: nothing billed")
    #expect(DictationFailure(server(503)) == .notWritten, "a bare 503 may come from anything in between")
    #expect(DictationFailure(ServerClient.ClientError.notPaired) == .notReached)
    #expect(DictationFailure(URLError(.cannotConnectToHost)) == .notReached, "it never left the phone")
    #expect(DictationFailure(server(502)) == .notWritten, "Thai words missing")
    #expect(DictationFailure(server(400)) == .notWritten)
    #expect(DictationFailure(URLError(.timedOut)) == .notWritten, "it may have been heard")
    #expect(DictationFailure(URLError(.networkConnectionLost)) == .notWritten)
}

@Test func theAnswerOutwaitsTheServersSlotWaitAndItsHearing() throws {
    let client = ServerClient(server: { URL(string: "https://wire.test") }) { "t" }
    let request = try client.dictationRequest()
    #expect(request.url?.path() == "/dictation/transcript" && request.httpMethod == "POST")
    #expect(request.timeoutInterval > 60 + 120)
}

@Test func dictatedWordsGoWhereTheCaretIsWithASpaceWhereAWordWouldTouch() {
    func insert(_ words: String, _ text: String, _ from: Int, _ to: Int? = nil, now: String? = nil) -> (String, Int)? {
        let start = text.index(text.startIndex, offsetBy: from)
        let end = text.index(text.startIndex, offsetBy: to ?? from)
        let now = now ?? text
        return DictatedText.inserting(words, into: now, at: (text, start..<end)).map {
            ($0.text, $0.text.distance(from: $0.text.startIndex, to: $0.caret))
        }
    }
    #expect(DictatedText.inserting(" the keys ", into: "", at: nil)?.text == "the keys")
    #expect(DictatedText.inserting("are here.", into: "The keys", at: nil)?.text == "The keys are here.")
    #expect(insert("keys", "The are here.", 4)! == ("The keys are here.", 8))
    #expect(insert("Keys", "the keys", 0)! == ("Keys the keys", 4))
    #expect(insert("door", "the keys, please", 4, 8)! == ("the door, please", 8), "a selection is replaced")
    #expect(insert("keys", "the keys", 4, 8)! == ("the keys", 8), "the same words over their selection still land")
    #expect(insert("  ", "same", 2) == nil, "no words, nothing lands, nothing sends")
    #expect(insert("here", "The keys", 4, now: "The kays")! == ("The kays here", 13), "changed text: at the end")
    let composed = "caf\u{E9} now"
    #expect(
        insert("today", composed, 6, now: "cafe\u{301} now")! == ("cafe\u{301} now today", 14),
        "a text equal as Swift compares it but not byte for byte takes nothing of the kept indices")
}

/// The crash of 21 Nov: Send empties the text, the field's caret stays where the last words ended, and the next run
/// kept that caret with the empty text. A caret outside its text, or inside a character, lands at the end.
@Test func aCaretLeftFromAnEarlierTextLandsAtTheEnd() {
    let earlier = "The keys are here."
    let stale = earlier.endIndex..<earlier.endIndex
    #expect(DictatedText.inserting("Hello", into: "", at: ("", stale))?.text == "Hello")
    #expect(DictatedText.inserting("there", into: "Hi", at: ("Hi", stale))?.text == "Hi there")
    let accent = "caf\u{E9}"
    let inside = accent.utf8.index(accent.utf8.startIndex, offsetBy: 4)
    #expect(DictatedText.inserting("now", into: accent, at: (accent, inside..<inside))?.text == "caf\u{E9} now")
}

/// A fake microphone and Mac: each `begin` and each ask waits until the test lets it go.
@MainActor private final class Rig {
    var begins: [CheckedContinuation<Void, Never>] = []
    var asks: [(ogg: Data, answer: CheckedContinuation<Result<String, any Error>, Never>)] = []
    var finished = 0
    var recordings = 0
    var ended: (@MainActor () -> Void)?
    var refused = false
    /// The last run's recording, alive only while something keeps the run.
    weak var recording: Recording?

    lazy var dictation = Dictation(
        begin: { ended in
            self.ended = ended
            await withCheckedContinuation { self.begins.append($0) }
            try Task.checkCancellation()
            self.recordings += 1
            let recording = Recording(Data("run \(self.recordings)".utf8))
            self.recording = recording
            return DictationRun(level: { 0.1 }) {
                self.finished += 1
                return recording.bytes
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

private final class Recording: Sendable {
    let bytes: Data
    init(_ bytes: Data) { self.bytes = bytes }
}

@MainActor @Test func nothingKeepsARunsRecordingOnceItLandedOrWasCancelled() async {
    let rig = Rig()
    rig.dictation.tap()
    await rig.until { rig.begins.count == 1 }
    rig.begins[0].resume()
    await rig.until { rig.dictation.phase == .listening }
    rig.dictation.tap()
    await rig.until { rig.asks.count == 1 }
    rig.asks[0].answer.resume(returning: .success("the keys"))
    await rig.until { rig.dictation.landed != nil && rig.recording == nil }

    rig.dictation.tap()
    await rig.until { rig.begins.count == 2 }
    rig.begins[1].resume()
    await rig.until { rig.dictation.phase == .listening }
    rig.dictation.tap()
    await rig.until { rig.asks.count == 2 }
    rig.dictation.cancel()  // while the Mac's answer is pending
    await rig.until { rig.recording == nil }

    rig.dictation.tap()
    await rig.until { rig.begins.count == 3 }
    rig.begins[2].resume()
    await rig.until { rig.dictation.phase == .listening }
    rig.dictation.cancel()  // while listening: this closes it
    await rig.until { rig.recording == nil && rig.finished == 3 }
    rig.asks[1].answer.resume(returning: .success("dropped"))
    #expect(rig.finished == 3, "each run closed once")
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

@MainActor @Test func aRunPausedThenCancelledWhileTheMicrophoneIsAskedForNeverOpensIt() async {
    let rig = Rig()
    rig.dictation.tap()
    rig.dictation.tap()
    rig.dictation.cancel()
    await rig.until { rig.begins.count == 1 }
    rig.begins[0].resume()
    for _ in 0..<100 { await Task.yield() }
    #expect(rig.recordings == 0 && rig.dictation.phase == .rest && rig.dictation.problem == nil)
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

@MainActor @Test func liveWordsReadTheMessagesAndShowStableThenChanging() {
    #expect(LiveWordsMessage(#"{"message_type":"partial_transcript","text":"hello wor"}"#) == .partial("hello wor"))
    #expect(
        LiveWordsMessage(#"{"message_type":"committed_transcript","text":"hello world"}"#) == .committed("hello world"))
    #expect(LiveWordsMessage(#"{"message_type":"quota_exceeded","error":"x"}"#) == .failed)
    #expect(LiveWordsMessage(#"{"message_type":"session_started"}"#) == nil)
    let live = LiveWords()
    live.apply(.committed("one two"))
    live.apply(.partial("three"))
    #expect(live.text == "one two three")
    live.apply(.committed("three"))
    #expect(live.text == "one two three")
}

@Test func anAudioChunkIsLittleEndianPcmInTheSocketsMessage() throws {
    let message = LiveWords.chunk([0, 1, -1], commit: true)
    let o = try #require(try JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any])
    #expect(o["message_type"] as? String == "input_audio_chunk" && o["commit"] as? Bool == true)
    #expect(o["sample_rate"] as? Int == 16_000)
    let pcm = try #require(Data(base64Encoded: o["audio_base_64"] as? String ?? ""))
    #expect([UInt8](pcm) == [0, 0, 0xFF, 0x7F, 0x01, 0x80])
}

/// The stream follows his voice: a quiet room is flat, close speech fills the bar, a syllable rises at once and a pause
/// falls away by halves.
@Test func aBarFollowsTheLoudnessOfItsMoment() {
    #expect(Dictation.bar(0, after: 0) == 0)
    #expect(Dictation.bar(0.001, after: 0) < 1e-6, "-60 dB: the room")
    #expect(abs(Dictation.bar(0.01, after: 0) - 0.5) < 1e-6, "-40 dB: soft speech, half a bar")
    #expect(Dictation.bar(0.1, after: 0) == 1, "-20 dB: close speech, a full bar at once")
    #expect(Dictation.bar(0, after: 1) == 0.5, "a pause falls by half")
    #expect(Dictation.bar(0, after: 0.5) == 0.25)
}

@MainActor @Test func aListeningRunSamplesItsMicrophoneIntoTheStream() async {
    let rig = Rig()  // its microphone hears 0.1: a full bar
    rig.dictation.tap()
    await rig.until { rig.begins.count == 1 }
    rig.begins[0].resume()
    await rig.until { rig.dictation.levels.last == 1 }
    rig.dictation.cancel()
}

/// The long spinner of 21 Nov: an answer that never comes ends in "Not written" after a bounded time, never a spinner.
@MainActor @Test func anAnswerThatNeverComesEndsInAFailureAfterABoundedTime() async {
    let dictation = Dictation(
        begin: { _ in DictationRun(level: { 0.1 }) { Data("ogg".utf8) } },
        words: { _ in
            try await Task.sleep(for: .seconds(3600))
            return "never"
        },
        refused: { false })
    dictation.answerWithin = .milliseconds(50)
    dictation.tap()
    for _ in 0..<10_000 where dictation.phase != .listening { await Task.yield() }
    dictation.tap()
    #expect(dictation.phase == .writing)
    for _ in 0..<2_000 where dictation.problem == nil { try? await Task.sleep(for: .milliseconds(5)) }
    #expect(dictation.problem == .notWritten && dictation.phase == .rest)
}
