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
