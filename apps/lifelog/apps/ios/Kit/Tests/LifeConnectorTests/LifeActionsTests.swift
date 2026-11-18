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
    let directions = Mutex<[[String]]>([])

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
        try changes.removeFirst()(onProgress)
    }
    func setMatterDirection(steps: [String], goal: String?, nextStep: NextStepRequest?) async throws -> String {
        directions.withLock { $0.append(steps) }
        return "Done: memory."
    }
    func markDone(observations: [String], note: String) async throws -> String { "Done: memory." }
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
            report(progress(#"{"plan":["recorded","handed","confirmed","left_inbox"],"limitSeconds":50}"#))
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
    #expect(result.send?.eventId == "$ev1")
    #expect(result.inbox?.left == true)
    #expect(steps.map(\.id) == ["recorded", "handed", "confirmed", "left_inbox"])
    #expect(steps.map { $0.passedAt != nil } == [true, true, false, false])
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
            matter: "matter_aaaaaaaaaaaa", steps: ["obs_000000000005"], goal: "Get it mended", runtime: nil, model: nil,
            emit: $0)
    }
}

@Test func aStartSavesTheGoalThenShowsTheDesksStages() async throws {
    let life = FakeLife()
    let started = try wireText("life/change_registered_agent_started.json")
    life.changes = [
        { report in
            report(progress(#"{"plan":["runtime_answers","session_open","turn_begun"],"limitSeconds":20}"#))
            report(progress(#"{"step":"runtime_answers","at":"2026-11-18T10:00:03.000Z"}"#))
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
    #expect(steps.map(\.id) == ["goal_saved", "runtime_answers", "session_open", "turn_begun"])
    #expect(steps.first?.passedAt == at)
    #expect(life.directions.withLock { $0 } == [["obs_000000000005"]])
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
    #expect(failure.step == "runtime_answers")
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

@Test func aGoalThatCannotBeSavedStopsTheStartWithATryAgain() async {
    final class Failing: LifeAPI, @unchecked Sendable {
        func readInbox() async throws -> String { "" }
        func readMatters() async throws -> String { "" }
        func readMatter(_ id: String) async throws -> String { "" }
        func readRegisteredAgents() async throws -> String { "" }
        func answerCheck(_ a: AnswerRequest, answerKey: String, onProgress: @escaping @Sendable (Data) -> Void)
            async throws -> String
        { "" }
        func changeAgent(_ c: AgentRequest, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String {
            Issue.record("the agent must not start")
            return ""
        }
        func setMatterDirection(steps: [String], goal: String?, nextStep: NextStepRequest?) async throws -> String {
            throw MCPError.refused("Not done: no matter")
        }
        func markDone(observations: [String], note: String) async throws -> String { "" }
    }
    let state = await run {
        await LifeActions(api: Failing()).startAgent(
            matter: "m", steps: ["s"], goal: "g", runtime: nil, model: nil, emit: $0)
    }
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.step == "goal_saved")
    #expect(failure.retry == .allowed)
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
        await LifeActions(api: life, now: { at }).record(emit: emit) {
            try await life.markDone(observations: ["o"], note: "n")
        }
    }
    guard case .succeeded(.recorded, let steps) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(steps.map(\.id) == ["recorded"])
    let refused = await run { emit in
        await LifeActions(api: life).record(emit: emit) { throw MCPError.refused("no") }
    }
    guard case .failed(let failure, _) = refused else {
        Issue.record("\(refused)")
        return
    }
    #expect(failure.step == "recorded")
    #expect(failure.retry == .no)
}
