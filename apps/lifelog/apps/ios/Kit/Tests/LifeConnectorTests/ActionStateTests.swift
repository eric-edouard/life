import Foundation
import Testing

@testable import LifeConnector

private typealias State = ActionState<ActionProof>
private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func ids(_ state: State) -> [String] { state.steps.map(\.id) }

@Test func aPlanThenItsStepsPassInOrder() {
    var state = State.idle
    state.apply(.started)
    state.apply(.planned(["recorded", "handed", "confirmed"], limitSeconds: 30, at: t0))
    state.apply(.passed("recorded", at: t0.addingTimeInterval(1), detail: [:]))
    state.apply(.passed("handed", at: t0.addingTimeInterval(2), detail: ["eventId": "$e"]))
    #expect(ids(state) == ["recorded", "handed", "confirmed"])
    #expect(state.steps.map { $0.passedAt != nil } == [true, true, false])
    #expect(state.steps[1].detail == ["eventId": "$e"])
    guard case .running(_, let limit) = state else {
        Issue.record("not running")
        return
    }
    #expect(limit == t0.addingTimeInterval(30))
}

@Test func stepsOutOfOrderAndStepsNotInThePlanAreKept() {
    var state = State.idle
    state.apply(.started)
    state.apply(.planned(["a", "b", "c"], limitSeconds: nil, at: t0))
    state.apply(.passed("c", at: t0, detail: [:]))
    state.apply(.passed("brand_new", at: t0, detail: [:]))
    #expect(ids(state) == ["a", "b", "c", "brand_new"])
    #expect(state.steps.map { $0.passedAt != nil } == [false, false, true, true])
}

@Test func aSecondPlanAddsItsStepsAndKeepsThePassedOnes() {
    var state = State.idle
    state.apply(.started)
    state.apply(.planned(["goal_saved"], limitSeconds: nil, at: t0))
    state.apply(.passed("goal_saved", at: t0, detail: [:]))
    state.apply(.planned(["desk_accepted", "session_open"], limitSeconds: 20, at: t0))
    #expect(ids(state) == ["goal_saved", "desk_accepted", "session_open"])
    #expect(state.steps[0].passedAt != nil)
}

@Test func eachEnding() {
    var done = State.idle
    done.apply(.started)
    done.apply(.planned(["a", "b"], limitSeconds: nil, at: t0))
    done.apply(.passed("a", at: t0, detail: [:]))
    done.apply(.succeeded(.recorded))
    #expect(done == .succeeded(.recorded, steps: done.steps))
    var failed = State.idle
    failed.apply(.started)
    failed.apply(.planned(["a", "b"], limitSeconds: nil, at: t0))
    failed.apply(.passed("a", at: t0, detail: [:]))
    failed.apply(.failed(ActionFailure(reason: "no", retry: .allowed)))
    guard case .failed(let failure, _) = failed else {
        Issue.record("not failed")
        return
    }
    // It stopped where the plan had not got to.
    #expect(failure.step == "b")
    #expect(!failed.isRunning)
}

@Test func pastTheLimitItIsLateButStillRunning() {
    var state = State.idle
    state.apply(.started)
    state.apply(.planned(["a"], limitSeconds: 10, at: t0))
    #expect(!state.isLate(at: t0.addingTimeInterval(9)))
    #expect(state.isLate(at: t0.addingTimeInterval(10)))
    #expect(state.isRunning)
    var open = State.idle
    open.apply(.started)
    #expect(!open.isLate(at: t0.addingTimeInterval(1000)))
}

@Test func progressMessagesAreTheirPlanOrAStepWithItsDetail() throws {
    let plan = try #require(ActionProgress(Data(#"{"plan":["recorded","todo_items_ticked"],"limitSeconds":30}"#.utf8)))
    #expect(plan == .plan(["recorded", "todo_items_ticked"], limitSeconds: 30))
    let step = try #require(
        ActionProgress(Data(#"{"step":"todo_items_ticked","at":"2026-11-18T10:00:01.500Z","done":1,"of":2}"#.utf8)))
    guard case .step("todo_items_ticked", let at?, let detail) = step else {
        Issue.record("not a step")
        return
    }
    #expect(detail == ["done": "1", "of": "2"])
    #expect(at.timeIntervalSince1970 > 1_700_000_000)
    #expect(ActionProgress(Data("not json".utf8)) == nil)
    #expect(ActionProgress(Data(#"{"other":1}"#.utf8)) == nil)
}

@Test func aConnectionThatFailedIsTheSameTapAndALifeRefusalIsFinal() {
    #expect(ActionFailure(.unreachable).isSameTap)
    #expect(ActionFailure(.streamDropped).retry == .allowed)
    #expect(ActionFailure(.streamDropped).canTryAgain)
    #expect(!ActionFailure(reason: "?", retry: .allowed, mayHaveHappened: true).canTryAgain)
    #expect(ActionFailure(.refused("Not done: no open check")).retry == .no)
    #expect(!ActionFailure(.refused("x")).isSameTap)
    #expect(ActionFailure(.notPaired).retry == .no)
}
