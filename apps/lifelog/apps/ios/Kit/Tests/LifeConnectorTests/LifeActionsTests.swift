import Foundation
import Synchronization
import Testing

@testable import LifeConnector

let lifeA = testURL("https://life-a.example.test")

/// A Life whose answers a test scripts; progress messages are given as the real stream gives them.
final class FakeLife: LifeAPI, @unchecked Sendable {
    var answers: [@Sendable (@Sendable (Data) -> Void) throws -> String] = []
    var changes: [@Sendable (@Sendable (Data) -> Void) throws -> String] = []
    var matter = "{}"
    var corrections = 0
    let keys = Mutex<[String]>([])
    let requests = Mutex<[AnswerRequest]>([])
    let starts = Mutex<[AgentRequest]>([])
    /// The ids each `read_person_pictures` asked; while `picturesDown`, it fails.
    let pictureCalls = Mutex<[[String]]>([])
    let picturesDown = Mutex(false)
    /// Awaited before each `read_person_pictures` answers: a test holds a call there.
    var picturesHeld: @Sendable () async -> Void = {}

    func readInbox() async throws -> String { "{}" }
    func readInbox(pushId: String, at origin: URL?) async throws -> String { "{}" }
    func readMatters() async throws -> String { "{}" }
    func readMatters(project: String) async throws -> String { "{}" }
    func readMatters(person: String) async throws -> String { "{}" }
    func readMatter(_ id: String) async throws -> String { matter }
    func readRegisteredAgents() async throws -> String { "{}" }
    /// What `fetch` answers: a test holds it, or fails it.
    var fetched: @Sendable () async throws -> String = { "" }
    func fetch(_ ref: String) async throws -> String { try await fetched() }
    func readPersonPictures(_ ids: [String]) async throws -> String {
        pictureCalls.withLock { $0.append(ids) }
        await picturesHeld()
        if picturesDown.withLock({ $0 }) { throw MCPError.unreachable }
        return try wireText("life/read_person_pictures.json")
    }
    func readPeopleAndOrganizations(query: String?) async throws -> String {
        try wireText("life/read_people_and_organizations.json")
    }
    func readPart(_ ref: String) async throws -> String { try wireText("life/read_people_and_organizations_now.json") }
    func readAppointment(_ key: AppointmentKey, at origin: URL?) async throws -> String {
        try wireText("life/read_appointments.json")
    }
    func changeAppointment(_ appointment: String, isOn: Bool, at origin: URL?) async throws -> String {
        try wireText("life/change_appointment_removed.json")
    }

    func answerCheck(
        _ answer: AnswerRequest, answerKey: String, at origin: URL, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        keys.withLock { $0.append(answerKey) }
        requests.withLock { $0.append(answer) }
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
    func setMatterIcon(matter: String, icon: String?, onProgress: @escaping @Sendable (Data) -> Void) async throws
        -> String
    {
        "Done: memory."
    }
    func markDone(matter: String, note: String, onProgress: @escaping @Sendable (Data) -> Void) async throws -> String {
        onProgress(Data(#"{"plan":["todo_items_ticked","recorded"],"limitSeconds":65}"#.utf8))
        return "Done: memory."
    }
    func setImportant(matter: String, _ important: Bool, onProgress: @escaping @Sendable (Data) -> Void)
        async throws -> String
    { "Done: memory." }
    func setProjectStatus(
        _ project: String, _ status: ProjectStatus, said: String, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String { "{}" }
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
    let state = await run {
        await LifeActions(api: life, now: { at }).answer(request, key: "tap-1", at: lifeA, emit: $0)
    }
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
    let state = await run { await LifeActions(api: life).answer(request, key: "tap-1", at: lifeA, emit: $0) }
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

@Test func aNotSentBecauseSomeoneWroteCarriesTheMessageLifeNamed() async throws {
    let life = FakeLife()
    let text = try wireText("life/answer_check_not_sent.json").replacingOccurrences(
        of: #""wrote": null"#,
        with: #""wrote": {"at": "2026-11-18T09:52:00.000Z", "by": "Kit Moreau", "text": "Can you post it instead?"}"#)
    life.answers = [{ _ in text }]
    let state = await run { await LifeActions(api: life).answer(request, key: "tap-1", at: lifeA, emit: $0) }
    guard case .failed(let failure, _) = state else {
        Issue.record("\(state)")
        return
    }
    #expect(failure.wrote?.by == "Kit Moreau")
    #expect(failure.wrote?.text == "Can you post it instead?")
}

@Test func aSendThatMayHaveGoneIsNeverRetried() async throws {
    let life = FakeLife()
    let text = try wireText("life/answer_check_sent.json")
        .replacingOccurrences(of: #""state": "sent""#, with: #""state": "may_have_gone""#)
    life.answers = [{ _ in text }]
    let state = await run { await LifeActions(api: life).answer(request, key: "k", at: lifeA, emit: $0) }
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
    let state = await run { await LifeActions(api: life).answer(request, key: "k", at: lifeA, emit: $0) }
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
        await LifeActions(api: life, pause: noPause).answer(request, key: "tap-9", at: lifeA, emit: $0)
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
    let state = await run {
        await LifeActions(api: life, pause: noPause).answer(request, key: "tap-1", at: lifeA, emit: $0)
    }
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
    let state = await run {
        await LifeActions(api: life, pause: noPause).answer(request, key: "tap-5", at: lifeA, emit: $0)
    }
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
    let state = await run {
        await LifeActions(api: life, pause: noPause).answer(request, key: "k", at: lifeA, emit: $0)
    }
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
    let state = await run {
        await LifeActions(api: life, pause: noPause).answer(request, key: "k", at: lifeA, emit: $0)
    }
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
    let first = await run { await actions.answer(found, key: "tap-1", at: lifeA, emit: $0) }
    guard case .succeeded(.answered(let result), _) = first else {
        Issue.record("\(first)")
        return
    }
    #expect(result.start?.state == .started)
    let second = await run { await actions.answer(found, key: "tap-2", at: lifeA, emit: $0) }
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

/// The real client under the answer runner, over a stub that answers `reply`; how many requests it saw, and the end.
private func answered(_ reply: @escaping @Sendable () -> Reply) async -> (Int, ActionState<ActionProof>) {
    let host = newHost()
    let calls = Mutex(0)
    let session = Stub.session(host: host) { _ in
        calls.withLock { $0 += 1 }
        return reply()
    }
    let life = LifeSession(
        store: MemoryStore(credentials(host: host)), oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    let api = MCPLifeAPI(client: MCPClient(session: life, urlSession: session))
    let actions = LifeActions(api: api, pause: noPause)
    let state = await run { await actions.answer(request, key: "tap-1", at: testURL("https://\(host)"), emit: $0) }
    return (calls.withLock { $0 }, state)
}

@Test func anAnswerThatTimesOutMayHaveGoneAndIsNeverRepeated() async {
    let progress =
        #"data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"x","progress":1,"message":"{}"}}"#
        + "\n\n"
    // No answer before the headers, and none after progress.
    for reply in [Reply(failure: .timedOut), Reply.stream(progress, failure: .timedOut)] {
        let (calls, state) = await answered { reply }
        #expect(calls == 1)
        guard case .failed(let failure, _) = state else { Issue.record("not failed: \(state)"); continue }
        #expect(failure.mayHaveHappened && failure.isSameTap && !failure.canTryAgain)
        #expect(failure.kind == "timedOut")
    }
}

@Test func anAnswerWithNoInternetEndsAtTheFirstTry() async {
    let (calls, state) = await answered { Reply(failure: .notConnectedToInternet) }
    #expect(calls == 1)
    guard case .failed(let failure, _) = state else { Issue.record("not failed"); return }
    #expect(failure.kind == "offline" && !failure.mayHaveHappened)
}

/// His "Wrong…" succeeds only on Life's word that the caretaker has it; any other answer fails, to be tried again.
@Test func aComplaintSucceedsOnlyOnceTheCaretakerHasIt() async {
    let origin = testURL("https://life.example.test")
    let wrong = AnswerRequest(
        ref: "voice:v1", options: [], note: "Not her.",
        value: Complaint(cause: "c", shown: "s", seal: "x", report: false))
    let life = FakeLife()
    life.answers = [
        { _ in #"{"ask":"ask_1","reached":"caretaker"}"# },
        { _ in #"{"ref":"voice:v1","kind":"voice"}"# },
        { _ in throw MCPError.refused("Not done: the desk has not received it in 60 s.") },
    ]
    let actions = LifeActions(api: life, now: { at }, pause: noPause)
    let reached = await run { await actions.answer(wrong, key: "tap-1", at: origin, emit: $0) }
    #expect(reached == .succeeded(.complaintReceipt(ask: "ask_1"), steps: []))
    for _ in 0..<2 {
        let state = await run { await actions.answer(wrong, key: "tap-2", at: origin, emit: $0) }
        guard case .failed = state else { Issue.record("\(state)"); continue }
    }
}

/// His "Wrong…" repeated after a dropped connection says it is a repeat, under the same key: Life counts only his own
/// Try again as a press again (a caretaker that never started tries once more), never the app's repeat.
@Test func aComplaintsRepeatOfADroppedCallSaysItIsARepeat() async {
    let wrong = AnswerRequest(
        ref: "voice:v1", options: [], note: "Not her.",
        value: Complaint(cause: "c", shown: "s", seal: "x", report: false))
    let life = FakeLife()
    life.answers = [{ _ in throw MCPError.streamDropped }, { _ in #"{"ask":"ask_1","reached":"caretaker"}"# }]
    let state = await run {
        await LifeActions(api: life, now: { at }, pause: noPause).answer(wrong, key: "tap-1", at: lifeA, emit: $0)
    }
    #expect(state == .succeeded(.complaintReceipt(ask: "ask_1"), steps: state.steps))
    #expect(life.requests.withLock { $0.map { $0.value?.repeated } } == [nil, true])
    #expect(life.keys.withLock { $0 } == ["tap-1", "tap-1"])
}

/// Life A on `a`, which drops every call after re-pairing the phone with Life B on `b`, as a pairing done while an
/// answer was on its way; `b` records whether anything reached it.
private func repairedDuringTheCall() -> (actions: LifeActions, a: URL, reachedB: @Sendable () -> Bool) {
    let (a, b) = (newHost(), newHost())
    let store = MemoryStore(credentials(host: a))
    let reached = Mutex(false)
    _ = Stub.session(host: b) { _ in
        reached.withLock { $0 = true }
        return .json(resultMessage(#"{"ref":"name:alex"}"#))
    }
    let session = Stub.session(host: a) { _ in
        store.save(credentials(host: b, access: "access-b"))
        return .stream(failure: .networkConnectionLost)
    }
    let life = LifeSession(store: store, oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    let api = MCPLifeAPI(client: MCPClient(session: life, urlSession: session))
    return (LifeActions(api: api, pause: { _ in }), testURL("https://\(a)"), { reached.withLock { $0 } })
}

/// An answer decided for Life A, its connection dropped while the phone was paired with Life B: its repeats go to A or
/// nowhere, a one-tap answer and a draft's Send alike, and it ends refused, never sent to B.
@Test(arguments: [["dismiss"], ["send"]]) func aRepeatAfterARepairingNeverReachesTheNewLife(options: [String]) async {
    let (actions, a, reachedB) = repairedDuringTheCall()
    let state = await run {
        await actions.answer(AnswerRequest(ref: "name:alex", options: options), key: "tap-1", at: a, emit: $0)
    }
    // It was repeated, and the repeat was refused before leaving the phone.
    #expect(state.steps.contains { $0.id == "connection_retry" })
    #expect(!reachedB())
    guard case .failed = state else {
        Issue.record("expected a refusal, got \(state)")
        return
    }
}

/// His "Wrong…" decided for Life A, its connection dropped while the phone was paired with Life B: its repeat goes to A
/// or nowhere, so B never hears his words.
@Test func aComplaintsRepeatAfterARepairingNeverReachesTheNewLife() async {
    let (actions, a, reachedB) = repairedDuringTheCall()
    let wrong = AnswerRequest(
        ref: "name:alex", options: [], note: "Not her.",
        value: Complaint(cause: "c", shown: "s", seal: "x", report: false))
    let state = await run { await actions.answer(wrong, key: "tap-1", at: a, emit: $0) }
    #expect(state.steps.contains { $0.id == "connection_retry" })
    #expect(!reachedB())
    guard case .failed = state else {
        Issue.record("expected a refusal, got \(state)")
        return
    }
}

/// His "Wrong…" decided for one pairing, its connection dropped while the phone was paired again with a Life at the same
/// address: its repeat is refused before it leaves the phone, so the new pairing's bearer never carries it.
@Test func aComplaintsRepeatAfterARepairingAtTheSameAddressIsRefused() async {
    let host = newHost()
    let store = MemoryStore(credentials(host: host))
    let generation = Mutex(0)
    let bearers = Mutex<[String]>([])
    let session = Stub.session(host: host) { seen in
        bearers.withLock { $0.append(seen.headers.first { $0.key.lowercased() == "authorization" }?.value ?? "") }
        store.save(credentials(host: host, access: "access-new"))
        generation.withLock { $0 += 1 }
        return .stream(failure: .networkConnectionLost)
    }
    let life = LifeSession(store: store, oauth: LifeOAuth(session: session, now: { epoch }), now: { epoch })
    let actions = LifeActions(api: MCPLifeAPI(client: MCPClient(session: life, urlSession: session)), pause: noPause)
    let wrong = AnswerRequest(
        ref: "name:alex", options: [], note: "Not her.",
        value: Complaint(cause: "c", shown: "s", seal: "x", report: false))
    let state = await run {
        await actions.answer(
            wrong, key: "tap-1", at: testURL("https://\(host)"), whilePaired: { generation.withLock { $0 } == 0 },
            emit: $0)
    }
    #expect(bearers.withLock { $0 } == ["Bearer access-1"])
    guard case .failed(let failure, _) = state else {
        Issue.record("expected a refusal, got \(state)")
        return
    }
    #expect(failure.kind == ActionFailure(.notPaired).kind)
}
