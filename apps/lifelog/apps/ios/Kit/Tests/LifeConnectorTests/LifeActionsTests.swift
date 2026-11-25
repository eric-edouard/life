import Foundation
import Synchronization
import Testing

@testable import LifeConnector

let lifeA = testURL("https://life-a.example.test")

/// A Life whose answers a test scripts; progress messages are given as the real stream gives them.
final class FakeLife: LifeAPI, @unchecked Sendable {
    var answers: [@Sendable (@Sendable (Data) -> Void) throws -> String] = []
    let keys = Mutex<[String]>([])
    let requests = Mutex<[AnswerRequest]>([])
    /// The ids each `read_person_pictures` asked; while `picturesDown`, it fails.
    let pictureCalls = Mutex<[[String]]>([])
    let picturesDown = Mutex(false)
    /// Awaited before each `read_person_pictures` answers: a test holds a call there.
    var picturesHeld: @Sendable () async -> Void = {}

    func readInbox(pushId: String, at origin: URL?) async throws -> String { "{}" }
    func readThread(before: String?, ifNot: String?) async throws -> String { "{}" }
    /// What `fetch` answers: a test holds it, or fails it.
    var fetched: @Sendable () async throws -> String = { "" }
    func fetch(_ ref: String) async throws -> String { try await fetched() }
    func readPersonPictures(_ ids: [String]) async throws -> String {
        pictureCalls.withLock { $0.append(ids) }
        await picturesHeld()
        if picturesDown.withLock({ $0 }) { throw MCPError.unreachable }
        return try wireText("life/read_person_pictures.json")
    }
    func readPart(_ ref: String) async throws -> String { try wireText("life/read_people_and_organizations_now.json") }
    func readAppointment(_ key: AppointmentKey, at origin: URL?) async throws -> String {
        try wireText("life/read_appointments.json")
    }
    func changeAppointment(_ appointment: String, isOn: Bool, at origin: URL?) async throws -> String {
        try wireText("life/change_appointment_removed.json")
    }

    /// What Ask Life's call does: its lines to `onProgress`, then its answer; the key each call came with is kept.
    var asked: @Sendable (@Sendable (Data) -> Void) async throws -> String = { _ in "{}" }
    let askedKeys = Mutex<[String?]>([])
    let askedRequests = Mutex<[MainSessionRequest]>([])
    func askMainSession(
        _ request: MainSessionRequest, answerKey: String?, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        askedKeys.withLock { $0.append(answerKey) }
        askedRequests.withLock { $0.append(request) }
        return try await asked(onProgress)
    }

    func answerCheck(
        _ answer: AnswerRequest, answerKey: String, at origin: URL, onProgress: @escaping @Sendable (Data) -> Void
    ) async throws -> String {
        keys.withLock { $0.append(answerKey) }
        requests.withLock { $0.append(answer) }
        return try answers.removeFirst()(onProgress)
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
