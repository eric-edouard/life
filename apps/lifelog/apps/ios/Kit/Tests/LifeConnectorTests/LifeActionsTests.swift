import Foundation
import Synchronization
import Testing

@testable import LifeConnector

/// A Life whose answers a test scripts; progress messages are given as the real stream gives them.
final class FakeLife: LifeAPI, @unchecked Sendable {
    var answers: [@Sendable (@Sendable (Data) -> Void) throws -> String] = []
    var changes: [@Sendable (@Sendable (Data) -> Void) throws -> String] = []
    var matter = "{}"
    var corrections = 0
    let keys = Mutex<[String]>([])
    let starts = Mutex<[AgentRequest]>([])

    func readInbox() async throws -> String { "{}" }
    func readMatters() async throws -> String { "{}" }
    func readMatter(_ id: String) async throws -> String { matter }
    func readRegisteredAgents() async throws -> String { "{}" }

    func answerCheck(_ answer: AnswerRequest, answerKey: String, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    {
        keys.withLock { $0.append(answerKey) }
        return try answers.removeFirst()(onProgress)
    }
    func changeAgent(_ change: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String {
        starts.withLock { $0.append(change) }
        return try changes.removeFirst()(onProgress)
    }
    func setMatterDirection(
        matter: String, goal: String?, nextStep: NextStepRequest?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        "Done: memory."
    }
    func markDone(matter: String, note: String, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String {
        onProgress(Data(#"{"plan":["todo_items_ticked","recorded"],"limitSeconds":65}"#.utf8))
        return "Done: memory."
    }
}

private let at = Date(timeIntervalSince1970: 1_800_000_000)
private let noPause: @Sendable (Duration) async -> Void = { _ in }

/// Runs one action and gives the state its events add up to, and how many events came.
private func run(_ body: (@escaping LifeActions.Emit) async -> Void) async -> ActionState<ActionProof> {
    let state = Mutex(ActionState<ActionProof>.idle)
    await body { event in state.withLock { $0.apply(event) } }
    return state.withLock { $0 }
}

private func progress(_ text: String) -> Data { Data(text.utf8) }
private let request = AnswerRequest(ref: "dec_000000000001", options: ["send"])

@Test func aSentAnswerSucceedsWithItsStepsAsTheyStreamed() async throws {
    let life = FakeLife()
    let sent = try wireText("life/answer_check_sent.json")
    life.answers = [
        { report in
            report(progress(#"{"plan":["recorded","handed","confirmed"],"limitSeconds":45}"#))
            report(progress(#"{"step":"recorded","at":"2026-11-18T10:00:01.000Z"}"#))
            report(progress(#"{"step":"handed","at":"2026-11-18T10:00:02.000Z"}"#))
            return sent
        }
    ]
    let state = await run { await LifeActions(api: life, now: { at }).answer(request, key: "tap-1", emit: $0) }
    guard case .succeeded(.answered(let result), let steps) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(result.send?.state == .sent)
    #expect(steps.map(\.id) == ["recorded", "handed", "confirmed"])
    #expect(steps.map { $0.passedAt != nil } == [true, true, false])
}

@Test func aNotSentAnswerFailsAndItsNextTapIsAFreshOne() async throws {
    let life = FakeLife()
    let text = try wireText("life/answer_check_not_sent.json")
    life.answers = [{ _ in text }]
    let state = await run { await LifeActions(api: life).answer(request, key: "tap-1", emit: $0) }
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.reason.hasPrefix("not sent: someone wrote"))
    #expect(failure.retry == .allowed)
    // Life decided: the next tap is a new one, so a new key.
    #expect(!failure.isSameTap)
    #expect(!failure.mayHaveHappened)
}

@Test func aSendThatMayHaveGoneIsNeverRetried() async throws {
    let life = FakeLife()
    let text = try wireText("life/answer_check_sent.json")
        .replacingOccurrences(of: #""state": "sent""#, with: #""state": "may_have_gone""#)
    life.answers = [{ _ in text }]
    let state = await run { await LifeActions(api: life).answer(request, key: "k", emit: $0) }
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.retry == .no)
    #expect(failure.mayHaveHappened)
}

@Test func aSendStateThisAppDoesNotKnowIsNeverShownAsSuccess() async throws {
    let life = FakeLife()
    let text = try wireText("life/answer_check_sent.json")
        .replacingOccurrences(of: #""state": "sent""#, with: #""state": "a_new_state""#)
    life.answers = [{ _ in text }]
    let state = await run { await LifeActions(api: life).answer(request, key: "k", emit: $0) }
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.mayHaveHappened)
}

@Test func aDroppedStreamIsRepeatedWithTheSameKeyAndSucceeds() async throws {
    let life = FakeLife()
    let sent = try wireText("life/answer_check_sent.json")
    life.answers = [{ _ in throw MCPError.streamDropped }, { _ in throw MCPError.unreachable }, { _ in sent }]
    let state = await run {
        await LifeActions(api: life, pause: noPause).answer(request, key: "tap-9", emit: $0)
    }
    guard case .succeeded(.answered, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(life.keys.withLock { $0 } == ["tap-9", "tap-9", "tap-9"])
}

// 19 Nov 2026: a send went out, the phone showed it failed, and the second tap was refused.
@Test func aRepeatOfAnAnsweredCardGetsItsStoredSentResultAsASuccess() async throws {
    let life = FakeLife()
    let sent = try wireText("life/answer_check_sent.json")
    life.answers = [{ _ in throw MCPError.streamDropped }, { _ in sent }]
    let state = await run { await LifeActions(api: life, pause: noPause).answer(request, key: "tap-1", emit: $0) }
    guard case .succeeded(.answered(let result), _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(result.send?.state == .sent)
}

@Test func aDroppedStreamThenSuccessShowsAConnectionRetryStepAndKeepsTheKey() async throws {
    let life = FakeLife()
    let sent = try wireText("life/answer_check_sent.json")
    life.answers = [{ _ in throw MCPError.streamDropped }, { _ in sent }]
    let state = await run { await LifeActions(api: life, pause: noPause).answer(request, key: "tap-5", emit: $0) }
    let retry = state.steps.first { $0.id == "connection_retry" }
    #expect(retry?.passedAt != nil)
    #expect(retry?.detail["try"] == "2")
    #expect(retry?.detail["of"] == "3")
    #expect(life.keys.withLock { $0 } == ["tap-5", "tap-5"])
}

@Test func anEditWithAPlanAndALimitIsLatePastItAndNeverFailed() async {
    let life = FakeLife()
    let state = await run { emit in
        await LifeActions(api: life, now: { at }).record(emit: emit) { onProgress in
            try await life.markDone(matter: "m", note: "n", onProgress: onProgress)
        }
    }
    guard case .succeeded(.recorded, let steps) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(steps.map(\.id) == ["todo_items_ticked", "recorded"])
    // The default limit is 10 seconds before Life's own plan; running past it is late, not failed.
    var running = ActionState<ActionProof>.idle
    running.apply(.started)
    running.apply(.planned(["recorded"], limitSeconds: 10, at: at))
    #expect(running.isLate(at: at.addingTimeInterval(11)))
    #expect(running.isRunning)
}

@Test func aMacThatStaysUnreachableFailsAsTheSameTapToTryAgain() async {
    let life = FakeLife()
    life.answers = Array(repeating: { _ in throw MCPError.unreachable }, count: 3)
    let state = await run { await LifeActions(api: life, pause: noPause).answer(request, key: "k", emit: $0) }
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.retry == .allowed)
    #expect(failure.isSameTap)
    #expect(life.keys.withLock { $0.count } == 3)
}

@Test func whatLifeRefusesIsFinalAndNotRepeated() async {
    let life = FakeLife()
    life.answers = [{ _ in throw MCPError.refused("Not done: no open check dec_x.") }]
    let state = await run { await LifeActions(api: life, pause: noPause).answer(request, key: "k", emit: $0) }
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.retry == .no)
    #expect(failure.reason == "Not done: no open check dec_x.")
    #expect(life.keys.withLock { $0.count } == 1)
}

// MARK: Agents

private func start(_ life: FakeLife) async -> ActionState<ActionProof> {
    await run {
        await LifeActions(api: life, now: { at }).startAgent(
            matter: "matter_aaaaaaaaaaaa", goal: "Get it mended", runtime: nil, model: nil, emit: $0)
    }
}

/// One call: Life saves the goal he saw (`goal_saved`), then the desk's stages, all in Life's own plan.
@Test func aStartSavesTheGoalThenShowsTheDesksStages() async throws {
    let life = FakeLife()
    let started = try wireText("life/change_registered_agent_started.json")
    life.changes = [
        { report in
            report(progress(#"{"plan":["goal_saved","desk_accepted","session_open","turn_begun"],"limitSeconds":20}"#))
            report(progress(#"{"step":"goal_saved","at":"2026-11-18T10:00:02.000Z"}"#))
            report(progress(#"{"step":"desk_accepted","at":"2026-11-18T10:00:03.000Z"}"#))
            return started
        }
    ]
    let state = await start(life)
    guard case .succeeded(.agent(let result), let steps) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(result.state == .started)
    #expect(result.stages?[1].link == "fake://agt_000000000001-1")
    #expect(steps.map(\.id) == ["goal_saved", "desk_accepted", "session_open", "turn_begun"])
    #expect(steps.first?.passedAt != nil)
    #expect(
        life.starts.withLock { $0 }
            == [AgentRequest(action: .start, step: "matter_aaaaaaaaaaaa", said: "Get it mended")])
}

@Test func aStartThatDidNotStartFailsAtItsStageAndMayBeTriedAgain() async throws {
    let life = FakeLife()
    let text = try wireText("life/change_registered_agent_not_started.json")
    life.changes = [{ _ in text }]
    let state = await start(life)
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.step == "desk_accepted")
    #expect(failure.reason.contains("does not answer"))
    #expect(failure.retry == .allowed)
}

@Test func aStartLifeDidNotConfirmIsDecidedByTheMatter() async throws {
    let unconfirmed = #"{"action":"start","state":"unconfirmed","agent":null,"stages":[],"nothingRunning":false}"#
    let life = FakeLife()
    life.changes = [{ _ in unconfirmed }]
    life.matter = try wireText("life/read_matter.json")
    guard case .succeeded(.agent(let found), _) = await start(life) else {
        Issue.record("no agent found")
        return
    }
    #expect(found.agent == "agt_000000000001")

    // The connection dropped as well, and the matter shows no agent: it may have started, so never start blind again.
    let dropped = FakeLife()
    dropped.changes = [{ _ in throw MCPError.streamDropped }]
    var bare = try #require(
        try JSONSerialization.jsonObject(with: Data(wireText("life/read_matter.json").utf8)) as? [String: Any])
    bare["agent"] = nil
    bare["agents"] = [Any]()
    dropped.matter = String(decoding: try JSONSerialization.data(withJSONObject: bare), as: UTF8.self)
    let unseen = await start(dropped)
    guard case .failed(let failure, _) = unseen else {
        Issue.record("\(unseen)")
        return
    }
    #expect(failure.retry == .no)
    #expect(failure.mayHaveHappened)
}

/// A matter whose last start ended (not started, or finished) holds no proof of a new one: only an agent that has not
/// ended, the one the desk named when it named one, is.
@Test func anEndedAgentIsNoProofOfAStart() async throws {
    var matter = try #require(
        try JSONSerialization.jsonObject(with: Data(wireText("life/read_matter.json").utf8)) as? [String: Any])
    var agent = try #require((matter["agents"] as? [[String: Any]])?.first)
    agent["status"] = "ended"
    agent["notStarted"] = "claude does not answer"
    matter["agent"] = nil
    matter["agents"] = [agent]
    let ended = String(decoding: try JSONSerialization.data(withJSONObject: matter), as: UTF8.self)
    let life = FakeLife()
    life.changes = [{ _ in throw MCPError.streamDropped }]
    life.matter = ended
    guard case .failed(let failure, _) = await start(life) else {
        Issue.record("an ended agent proved the start")
        return
    }
    #expect(failure.mayHaveHappened)

    // Unconfirmed, naming a new agent: the running one that is not it proves nothing either.
    let named = FakeLife()
    named.changes = [{ _ in #"{"action":"start","state":"unconfirmed","agent":"agt_new","stages":[]}"# }]
    named.matter = try wireText("life/read_matter.json")
    guard case .failed = await start(named) else {
        Issue.record("another agent proved the start")
        return
    }
}

@Test func stoppingAnAgentIsDoneOrNotConfirmed() async {
    let life = FakeLife()
    life.changes = [
        { _ in #"{"action":"stop","agent":"agt_1","state":"done"}"# },
        { _ in #"{"action":"stop","agent":"agt_1","state":"unconfirmed"}"# },
    ]
    let stop = AgentRequest(action: .stop, agent: "agt_1", said: "Stop it")
    let done = await run { await LifeActions(api: life).changeAgent(stop, emit: $0) }
    guard case .succeeded(.agent(let result), _) = done else {
        Issue.record("\(done)")
        return
    }
    #expect(result.state == .done)
    let late = await run { await LifeActions(api: life).changeAgent(stop, emit: $0) }
    guard case .failed(let failure, _) = late else {
        Issue.record("\(late)")
        return
    }
    #expect(failure.mayHaveHappened)
}

@Test func anEditIsOneStep() async {
    let life = FakeLife()
    let state = await run { emit in
        await LifeActions(api: life, now: { at }).record(emit: emit) { _ in "Done: memory." }
    }
    guard case .succeeded(.recorded, let steps) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(steps.map(\.id) == ["recorded"])
    let refused = await run { emit in
        await LifeActions(api: life).record(emit: emit) { _ in throw MCPError.refused("no") }
    }
    guard case .failed(let failure, _) = refused else {
        Issue.record("\(refused)")
        return
    }
    #expect(failure.step == "recorded")
    #expect(failure.retry == .no)
}

@Test func aNewMattersStartSucceedsWhenTheDeskStartedItAndFailsAtItsStageWhenNot() async throws {
    let found = AnswerRequest(ref: "matter_000000000007", options: ["start"])
    let life = FakeLife()
    let started = try wireText("life/answer_check_new_matter_started.json")
    let refused = #"""
        {"ref":"matter_000000000007","kind":"new matter","send":null,"start":{"action":"start","state":"not_started",
        "failed":{"stage":"desk_accepted","reason":"claude does not answer"},"nothingRunning":true}}
        """#
    life.answers = [{ _ in started }, { _ in refused }]
    let actions = LifeActions(api: life, now: { at })
    let first = await run { await actions.answer(found, key: "tap-1", emit: $0) }
    guard case .succeeded(.answered(let result), _) = first else {
        Issue.record("\(first)")
        return
    }
    #expect(result.start?.state == .started)
    let second = await run { await actions.answer(found, key: "tap-2", emit: $0) }
    guard case .failed(let failure, _) = second else {
        Issue.record("\(second)")
        return
    }
    #expect(failure.step == "desk_accepted")
    #expect(failure.reason.contains("does not answer"))
    #expect(failure.retry == .allowed)
}

@Test func anEditToAnOlderServerThatSendsNoPlanStillShowsItsRecordedStep() async {
    let state = await run { emit in
        await LifeActions(api: FakeLife(), now: { at }).record(emit: emit) { _ in "ok" }
    }
    #expect(state.steps.map(\.id) == ["recorded"])
}
