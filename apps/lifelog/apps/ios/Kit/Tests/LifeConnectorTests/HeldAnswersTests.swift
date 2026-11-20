import Testing

@testable import LifeConnector

@MainActor private final class Sent {
    var requests: [AnswerRequest] = []
    var wasCancelled = false
}

/// The timer's own task must not carry the send: a cancelled send fails and the answer is lost.
@MainActor @Test func aHeldAnswerIsSentWhenItsTimeIsUpAndNotCancelled() async throws {
    let sent = Sent()
    let holds = HeldAnswers(delay: .milliseconds(20)) { request in
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
    let holds = HeldAnswers(delay: .seconds(60)) { sent.requests.append($0) }
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

/// A released answer stays held until its send has begun, in the same step: no frame shows it neither held nor on its way.
@MainActor @Test func aReleasedAnswerIsHeldOrOnItsWayAtEveryStep() async {
    var sending: Set<String> = []
    var holds: HeldAnswers!
    holds = HeldAnswers(delay: .seconds(60)) { request in
        sending.insert(request.ref)
        try? await Task.sleep(for: .milliseconds(5))
    }
    holds.hold(AnswerRequest(ref: "c1", options: ["yes"]), as: "Yes")
    let all = Task { await holds.sendAll() }
    for _ in 0..<20 {
        #expect(holds.held["c1"] != nil || sending.contains("c1"))
        await Task.yield()
    }
    await all.value
    #expect(holds.held.isEmpty && sending == ["c1"])
}
