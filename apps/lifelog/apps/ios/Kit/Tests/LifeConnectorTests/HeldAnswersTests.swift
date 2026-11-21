import Synchronization
import Testing

@testable import LifeConnector

@MainActor private final class Sent {
    var requests: [AnswerRequest] = []
    var wasCancelled = false
}

/// The timer's own task must not carry the send: a cancelled send fails and the answer is lost.
@MainActor @Test func aHeldAnswerIsSentWhenItsTimeIsUpAndNotCancelled() async throws {
    let sent = Sent()
    let holds = HeldAnswers(delay: .milliseconds(20)) { held in
        let request = held.request
        sent.wasCancelled = Task.isCancelled
        try? await Task.sleep(for: .milliseconds(5))
        sent.wasCancelled = sent.wasCancelled || Task.isCancelled
        sent.requests.append(request)
    }
    holds.hold(AnswerRequest(ref: "c1", options: ["yes"]), as: "Yes")
    #expect(holds.held["c1"]?.label == "Yes")
    try await Task.sleep(for: .milliseconds(150))
    #expect(sent.requests.map(\.ref) == ["c1"] && !sent.wasCancelled)
    #expect(holds.held.isEmpty)
}

@MainActor @Test func undoSendsNothingAndSendAllSendsEverythingHeld() async throws {
    let sent = Sent()
    let holds = HeldAnswers(delay: .seconds(60)) { sent.requests.append($0.request) }
    holds.hold(AnswerRequest(ref: "a", options: ["yes"]), as: "Yes")
    holds.hold(AnswerRequest(ref: "b", options: ["no"]), as: "No")
    holds.hold(AnswerRequest(ref: "c", options: ["no"]), as: "No")
    holds.undo("a")
    holds.clear()
    holds.hold(AnswerRequest(ref: "b", options: ["no"]), as: "No")
    holds.hold(AnswerRequest(ref: "d", options: ["yes"]), as: "Yes")
    await holds.sendAll()
    #expect(sent.requests.map(\.ref).sorted() == ["b", "d"])
}

@MainActor @Test func theLatestHeldIsTheOneHeldLastUntilItIsUndone() {
    let holds = HeldAnswers(delay: .seconds(60)) { _ in }
    holds.hold(AnswerRequest(ref: "z", options: ["yes"]), as: "Yes")
    holds.hold(AnswerRequest(ref: "a", options: ["no"]), as: "No")
    #expect(holds.latest == "a")
    holds.undo("a")
    #expect(holds.latest == "z")
}

/// A bulk ask's answers are held as one: one toast, and Undo of any brings back all of them, never others.
@MainActor @Test func answersHeldTogetherAreUndoneTogether() async {
    let sent = Sent()
    let holds = HeldAnswers(delay: .seconds(60)) { sent.requests.append($0.request) }
    holds.hold(AnswerRequest(ref: "alone", options: ["yes"]), as: "Yes")
    holds.hold(["a", "b", "c"].map { AnswerRequest(ref: $0, options: ["outdated"]) }, as: "3 answered")
    #expect(holds.held["a"]?.label == "3 answered" && holds.latest == "c")
    holds.undo("c")
    #expect(Set(holds.held.keys) == ["alone"] && holds.latest == "alone")
    await holds.sendAll()
    #expect(sent.requests.map(\.ref) == ["alone"])
}

/// A released answer is held or being sent at every step, until its send ended: no frame brings its card back.
@MainActor @Test func aReleasedAnswerIsUnderWayUntilItsSendEnded() async {
    var sent = false
    let holds = HeldAnswers(delay: .seconds(60)) { _ in
        try? await Task.sleep(for: .milliseconds(5))
        sent = true
    }
    holds.hold(AnswerRequest(ref: "c1", options: ["yes"]), as: "Yes")
    let all = Task { await holds.sendAll() }
    while !sent {
        #expect(holds.underWay == ["c1"])
        await Task.yield()
    }
    await all.value
    #expect(holds.held.isEmpty)
}

/// A flush that comes once the timer has released the answer (the app going while it is sent) waits for that send.
@MainActor @Test func aFlushAfterTheTimerWaitsForTheSendUnderWay() async throws {
    var sent = 0
    let holds = HeldAnswers(delay: .milliseconds(10)) { _ in
        try? await Task.sleep(for: .milliseconds(80))
        sent += 1
    }
    holds.hold(AnswerRequest(ref: "c1", options: ["yes"]), as: "Yes")
    while !holds.held.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    #expect(holds.underWay == ["c1"])
    await holds.sendAll()
    #expect(sent == 1)
}

/// An answer held again under the same ref while the first is still being sent has its own timer and its own send.
@MainActor @Test func anAnswerHeldAgainWhileTheFirstIsSentIsSentToo() async throws {
    var sent: [[String]] = []
    let holds = HeldAnswers(delay: .milliseconds(10)) { held in
        let request = held.request
        try? await Task.sleep(for: .milliseconds(40))
        sent.append(request.options)
    }
    holds.hold(AnswerRequest(ref: "c1", options: ["yes"]), as: "Yes")
    while !holds.held.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    holds.hold(AnswerRequest(ref: "c1", options: ["no"]), as: "No")
    try await Task.sleep(for: .milliseconds(30))
    await holds.sendAll()
    #expect(sent == [["yes"], ["no"]])
    #expect(holds.underWay.isEmpty)
}

/// Two flushes of the same held answer share its one send, and each waits for it.
@MainActor @Test func everyFlushWaitsForTheOneRealSend() async {
    var sent = 0
    let holds = HeldAnswers(delay: .seconds(60)) { _ in
        try? await Task.sleep(for: .milliseconds(30))
        sent += 1
    }
    holds.hold(AnswerRequest(ref: "c1", options: ["yes"]), as: "Yes")
    let first = Task { await holds.sendAll() }
    let second = Task { await holds.sendAll() }
    await second.value
    #expect(sent == 1)
    await first.value
    #expect(sent == 1 && holds.held.isEmpty)
}

/// A release waiting behind an earlier send of its card never starts once the phone is paired with another Life.
@MainActor @Test func aReleaseQueuedBehindASendNeverStartsAfterARepairing() async throws {
    var sent: [[String]] = []
    let holds = HeldAnswers(delay: .milliseconds(10)) { held in
        try? await Task.sleep(for: .milliseconds(60))
        sent.append(held.request.options)
    }
    holds.hold(AnswerRequest(ref: "c1", options: ["yes"]), as: "Yes")
    while !holds.held.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    holds.hold(AnswerRequest(ref: "c1", options: ["no"]), as: "No")
    // Released, and waiting behind the first send.
    while !holds.held.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    holds.clear()
    await holds.sendAll()
    #expect(!sent.contains(["no"]))
    #expect(holds.underWay.isEmpty)
}

/// His Done held for Undo, then released: Life recorded it but did not end its step. Its end says so in Life's words,
/// and the answer stands, never offered again (#753).
@MainActor @Test func aReleasedDoneThatLifeCouldNotEndSaysLifesReason() async throws {
    let life = FakeLife()
    life.answers = [
        { _ in
            #"{"ref":"dec_000000000002","kind":"decision","send":null,"start":null,"changed":"#
                + #"{"decision":"dec_000000000002","options":["done"],"state":"answered","ended":"#
                + #"{"at":"2026-11-18T10:00:01.000Z","error":"Reminders did not take the change."}}}"#
        }
    ]
    let actions = LifeActions(api: life, pause: { _ in })
    let state = Mutex(ActionState<ActionProof>.idle)
    let holds = HeldAnswers(delay: .seconds(60)) { held in
        await actions.answer(held.request, key: "tap-1", at: lifeA) { event in state.withLock { $0.apply(event) } }
    }
    holds.hold(AnswerRequest(ref: "dec_000000000002", options: ["done"]), as: "Done")
    await holds.sendAll()
    let ended = state.withLock { $0 }
    let said = try #require(ended.heldAnswerWords)
    #expect(said.words == "Your answer was recorded. Reminders did not take the change." && !said.isDone)
    guard case .succeeded = ended else {
        Issue.record("expected it answered, got \(ended)")
        return
    }
    #expect(life.keys.withLock { $0 } == ["tap-1"])
    #expect(ActionState<ActionProof>.succeeded(.recorded, steps: []).heldAnswerWords == nil)
}
