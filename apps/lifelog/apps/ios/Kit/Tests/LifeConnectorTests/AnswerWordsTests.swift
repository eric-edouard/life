import Synchronization
import Testing

@testable import LifeConnector

/// His Done on a row, Life recorded it but did not end its step. Its end says so in Life's words,
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
    await actions.answer(AnswerRequest(ref: "dec_000000000002", options: ["done"]), key: "tap-1", at: lifeA) { event in
        state.withLock { $0.apply(event) }
    }
    let ended = state.withLock { $0 }
    let said = try #require(ended.heldAnswerWords(as: "Done"))
    #expect(said.words == "Your answer was recorded. Reminders did not take the change." && !said.isDone)
    guard case .succeeded = ended else {
        Issue.record("expected it answered, got \(ended)")
        return
    }
    #expect(life.keys.withLock { $0 } == ["tap-1"])
    #expect(ActionState<ActionProof>.succeeded(.recorded, steps: []).heldAnswerWords(as: "Done")?.words == "Done")
    let failure = ActionFailure(reason: "Life is out of reach.", retry: .no)
    #expect(ActionState<ActionProof>.failed(failure, steps: []).heldAnswerWords(as: "Done")?.isDone == false)
}
