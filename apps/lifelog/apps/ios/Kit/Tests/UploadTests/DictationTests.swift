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
    /// What instant dictation heard of each run; nil: heard on the Mac.
    var heard: String?
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
            return DictationRun(
                level: { 0.1 },
                finish: {
                    self.finished += 1
                    return recording.bytes
                }, heard: { self.heard })
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
    #expect(LiveWordsMessage(#"{"message_type":"commit_throttled","error":"x"}"#) == .nothingToCommit)
    #expect(LiveWordsMessage(#"{"message_type":"session_started"}"#) == nil)
    let live = LiveWords()
    let text = { live.words.map(\.text).joined(separator: " ") }
    live.apply(.committed("one two"))
    live.apply(.partial("three"))
    #expect(text() == "one two three")
    live.apply(.committed("three"))
    #expect(text() == "one two three")
    live.apply(.failed)
    #expect(live.hasFailed)
    live.clear()
    #expect(live.words.isEmpty && !live.hasFailed)
}

/// A run's end never touches a run begun after it, and a run that never opened its stream is heard on the Mac.
@MainActor @Test func aRunsFinishLeavesALaterRunAloneAndOneNeverOpenedFails() async {
    let live = LiveWords()
    live.begin {
        try await Task.sleep(for: .seconds(3600)); return "never"
    }
    let first = live.run
    live.begin {
        try await Task.sleep(for: .seconds(3600)); return "never"
    }
    #expect(await live.finish(first) == nil)
    #expect(!live.hasFailed, "the later run's stream is untouched")
    #expect(await live.finish(live.run) == nil)
    #expect(live.hasFailed, "no token by the pause: the Mac hears it, and the line says so")
}

/// A partial corrected in place, or replaced by its final, keeps its word's time: it never fades in again or moves. New
/// words come after, one `stagger` apart, left to right.
@Test func aWordKeepsItsTimeWhenItsPartialIsReplacedAndNewWordsComeInLeftToRight() {
    let t0 = Date(timeIntervalSince1970: 0)
    let t1 = t0.addingTimeInterval(1)
    let first = LiveWords.merged([], with: "Hello, life. Please remind-", at: t0)
    #expect(first.map(\.text) == ["Hello,", "life.", "Please", "remind-"])
    #expect(first.map(\.at) == (0..<4).map { t0.addingTimeInterval(Double($0) * LiveWords.stagger) })
    let final = LiveWords.merged(first, with: "Hello, Life. Please remind me to call", at: t1)
    #expect(final.map(\.text) == ["Hello,", "Life.", "Please", "remind", "me", "to", "call"])
    #expect(Array(final.prefix(4).map(\.at)) == first.map(\.at), "the shown words keep their times")
    #expect(final[4].at == t1 && final[6].at == t1.addingTimeInterval(2 * LiveWords.stagger))
    let shorter = LiveWords.merged(final, with: "Hello, Life.", at: t1)
    #expect(shorter == Array(final.prefix(2)), "a partial that shrinks drops its tail, never moving the rest")
    #expect(LiveWords.merged(final, with: "  ", at: t1).isEmpty)
}

/// Each word sweeps in from the left: its first glyph starts at its time, each next one `perGlyph` later, each over
/// `fade`.
@Test func aWordFadesInGlyphByGlyphFromTheLeft() {
    let t0 = Date(timeIntervalSince1970: 0)
    let word = LiveWord(text: "keys", at: t0)
    #expect(LiveWords.opacity(of: word, glyph: 0, at: t0) == 0)
    #expect(LiveWords.opacity(of: word, glyph: 0, at: t0.addingTimeInterval(LiveWords.fade)) == 1)
    let mid = t0.addingTimeInterval(LiveWords.fade / 2)
    #expect(LiveWords.opacity(of: word, glyph: 0, at: mid) > LiveWords.opacity(of: word, glyph: 3, at: mid))
    #expect(LiveWords.opacity(of: word, glyph: 0, at: t0.addingTimeInterval(-1)) == 0, "never below 0")
    let settled = LiveWords.settledAt([word])
    #expect(settled == t0.addingTimeInterval(LiveWords.fade + 4 * LiveWords.perGlyph))
    #expect(LiveWords.opacity(of: word, glyph: 4, at: settled) == 1, "the last glyph is in")
    #expect(LiveWords.settledAt([]) == .distantPast)
}

/// Instant dictation's words land at the pause and the Mac is never asked; without them (heard on the Mac, or the
/// stream failed) the Mac hears the same recording.
@MainActor @Test func instantWordsLandWithoutTheMacAndAFailedStreamFallsBackToIt() async {
    let rig = Rig()
    rig.heard = "the keys"
    rig.dictation.tap()
    await rig.until { rig.begins.count == 1 }
    rig.begins[0].resume()
    await rig.until { rig.dictation.phase == .listening }
    rig.dictation.tap()
    await rig.until { rig.dictation.landed != nil }
    #expect(rig.dictation.landed?.words == "the keys" && rig.asks.isEmpty && rig.dictation.phase == .rest)

    rig.heard = nil
    rig.dictation.tap()
    await rig.until { rig.begins.count == 2 }
    rig.begins[1].resume()
    await rig.until { rig.dictation.phase == .listening }
    rig.dictation.tap()
    await rig.until { rig.asks.count == 1 }
    #expect(rig.asks[0].ogg == Data("run 2".utf8))
    rig.asks[0].answer.resume(returning: .success("on the Mac"))
    await rig.until { rig.dictation.landed?.words == "on the Mac" }
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

/// A fake realtime socket: the test says what ElevenLabs answers, and sees what the phone sent.
@MainActor private final class FakeLiveSocket {
    var sent: [String] = []
    var opened = false
    private var lines: [String] = []
    private var waiter: CheckedContinuation<String?, Never>?
    private var isClosed = false

    func make(_: URL) -> LiveWordsSocket {
        opened = true
        return LiveWordsSocket(
            send: { self.sent.append($0) }, receive: { await self.next() },
            close: { _ in
                self.isClosed = true
                self.waiter?.resume(returning: nil)
                self.waiter = nil
            })
    }

    private func next() async -> String? {
        if !lines.isEmpty { return lines.removeFirst() }
        if isClosed { return nil }
        return await withCheckedContinuation { waiter = $0 }
    }

    func says(_ type: String, _ text: String = "") {
        let line = #"{"message_type":"\#(type)","text":"\#(text)"}"#
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: line)
        } else {
            lines.append(line)
        }
    }

    func until(_ condition: () -> Bool) async {
        for _ in 0..<10_000 where !condition() { await Task.yield() }
        #expect(condition())
    }
}

/// His words after a commit voice detection made just before the pause are kept: the pause's own commit comes after it.
@MainActor @Test func aCommitInFlightAtThePauseNeverEndsItsWordsEarly() async {
    let fake = FakeLiveSocket()
    let live = LiveWords(socket: fake.make, settleAfter: .milliseconds(50))
    live.begin { "token" }
    await fake.until { fake.opened }
    fake.says("partial_transcript", "keys under")
    let run = live.run
    let words = Task { await live.finish(run) }
    await fake.until { fake.sent.contains { $0.contains(#""commit":true"#) } }
    fake.says("committed_transcript", "keys under")
    fake.says("partial_transcript", "the mat")
    fake.says("committed_transcript", "the mat")
    #expect(await words.value == "keys under the mat")
    #expect(!live.hasFailed)
}

/// ElevenLabs saying nothing is left to commit while words were still changing would lose them: the Mac hears the run.
@MainActor @Test func nothingLeftToCommitWhileWordsAreChangingFallsBackToTheMac() async {
    let fake = FakeLiveSocket()
    let live = LiveWords(socket: fake.make, settleAfter: .milliseconds(50))
    live.begin { "token" }
    await fake.until { fake.opened }
    fake.says("committed_transcript", "call Nora")
    fake.says("partial_transcript", "about the")
    let run = live.run
    let words = Task { await live.finish(run) }
    await fake.until { fake.sent.contains { $0.contains(#""commit":true"#) } }
    fake.says("commit_throttled")
    #expect(await words.value == nil)
    #expect(live.hasFailed)
}

/// A run that heard nothing live is heard on the Mac; one with nothing changing settles on what was committed.
@MainActor @Test func nothingHeardLiveIsHeardOnTheMacAndAQuietRunSettlesAtOnce() async {
    let fake = FakeLiveSocket()
    let live = LiveWords(socket: fake.make, settleAfter: .milliseconds(50))
    live.begin { "token" }
    await fake.until { fake.opened }
    let run = live.run
    let words = Task { await live.finish(run) }
    await fake.until { fake.sent.contains { $0.contains(#""commit":true"#) } }
    fake.says("committed_transcript", "")
    #expect(await words.value == nil)
    #expect(live.hasFailed)

    let quiet = FakeLiveSocket()
    let second = LiveWords(socket: quiet.make, settleAfter: .milliseconds(50))
    second.begin { "token" }
    await quiet.until { quiet.opened }
    quiet.says("committed_transcript", "see you at eight")
    let secondRun = second.run
    let settled = Task { await second.finish(secondRun) }
    await quiet.until { quiet.sent.contains { $0.contains(#""commit":true"#) } }
    quiet.says("insufficient_audio_activity")
    #expect(await settled.value == "see you at eight")

/// Send pressed while the microphone opens, and it never opens: nothing is left to send, and the next run never sends.
@MainActor @Test func aSendWhoseMicrophoneNeverOpenedLeavesTheNextRunUnsent() async {
    var opens = 0
    let dictation = Dictation(
        begin: { _ in
            opens += 1
            if opens == 1 { throw Dictation.StartFailure.busy }
            return DictationRun(level: { 0 }, finish: { Data() }, heard: { "later words" })
        },
        words: { _ in "" }, refused: { false })
    dictation.start()
    dictation.send()
    #expect(dictation.isSending)
    for _ in 0..<10_000 where dictation.phase != .rest { await Task.yield() }
    #expect(dictation.problem == .busy && !dictation.isSending)
    dictation.start()
    for _ in 0..<10_000 where dictation.phase != .listening { await Task.yield() }
    dictation.pause()
    for _ in 0..<10_000 where dictation.landed == nil { await Task.yield() }
    #expect(dictation.landed?.words == "later words" && dictation.landed?.sends == false)
}
