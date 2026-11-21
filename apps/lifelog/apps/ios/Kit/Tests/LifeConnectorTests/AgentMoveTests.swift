import Foundation
import Library
import Testing

@testable import LifeConnector

/// A wire read with `change` applied to its JSON, decoded as `T`.
private func read<T: Decodable>(_ type: T.Type, _ file: String, _ change: (inout [String: Any]) -> Void) throws -> T {
    var json = try #require(JSONSerialization.jsonObject(with: Data(wireText(file).utf8)) as? [String: Any])
    change(&json)
    return try LibraryStore.feedDecoder.decode(type, from: JSONSerialization.data(withJSONObject: json))
}

/// A matter held by the kitchen agent, moved from Halden house's, with `extra` on the read.
private func movedMatter(_ extra: [String: Any] = [:]) throws -> Matter {
    try read(Matter.self, "life/read_matter.json") { json in
        json["holder"] = [
            "id": "agt_new", "name": "Kitchen quote agent", "short": "Kitchen quote", "runtime": "codex",
            "movedFrom": ["id": "agt_old", "name": "Halden house agent", "short": "Halden house", "runtime": "claude"],
        ]
        json.merge(extra) { $1 }
    }
}

/// The registered agents with the first one's id, status and role set (Halden house's, by default).
private func agents(status: String = "waiting", role: String? = nil, extra: [String: Any] = [:]) throws
    -> RegisteredAgents
{
    try read(RegisteredAgents.self, "life/read_registered_agents.json") { json in
        var list = json["agents"] as? [[String: Any]] ?? []
        list[0].merge(["id": "agt_old", "status": status, "role": role ?? NSNull()].merging(extra) { $1 }) { $1 }
        json["agents"] = list
        json["refused"] = [["ask": "ask_refused", "agent": NSNull(), "error": "No agent holds this matter."]]
    }
}

@Test func aMatterReadsItsHolderWhereItCanMoveAndItsMove() throws {
    let matter = try movedMatter(["moveTo": "claude", "move": ["id": "ask_1", "phase": "starting"]])
    #expect(matter.holder?.agent.name == "Kitchen quote agent")
    #expect(matter.holder?.agent.runtimeName == .codex)
    #expect(matter.holder?.movedFrom?.short == "Halden house")
    #expect(matter.moveTo == "claude")
    #expect(matter.move == AgentMove(id: "ask_1", phase: .starting))
    // An older Life sends none of it.
    let old = try read(Matter.self, "life/read_matter.json") { $0["holder"] = nil }
    #expect(old.holder == nil && old.move == nil && old.moveBlocked == nil)
}

@Test func anAgentReadsItsNamesItsSwitchAndTheRefusals() throws {
    let read = try agents(extra: [
        "name": "Halden house agent", "short": "Halden house",
        "moveBlocked": ["runtime": "codex", "reason": "Codex can't run on your Mac right now."],
        "switch": ["id": "ask_2", "phase": "notes", "done": 1, "total": 3],
    ])
    let agent = try #require(read.agents.first)
    #expect(agent.name == "Halden house agent")
    #expect(agent.moveBlocked?.reason == "Codex can't run on your Mac right now.")
    #expect(agent.switch == AgentMove(id: "ask_2", phase: .notes, done: 1, total: 3))
    #expect(read.refused?.first?.error == "No agent holds this matter.")
    #expect(MoveWords.underWay(try #require(agent.switch), runtime: .codex) == "Writing notes, 2 of 3…")
}

@Test func theMoveOfferedIsBackToAnAgentAtWorkElseToTheOtherProgram() throws {
    let matter = try movedMatter(["moveTo": "claude"])
    #expect(try matter.moveChoice(among: agents().agents) == .back(agent: "agt_old", name: "Halden house agent"))
    // The desk takes no stopped or ended agent, nor the caretaker: the other program is offered instead.
    for (status, role) in [("stopped", nil), ("ended", nil), ("waiting", "caretaker")] {
        #expect(try matter.moveChoice(among: agents(status: status, role: role).agents) == .runtime(.claude))
    }
    #expect(matter.moveChoice(among: []) == .runtime(.claude))
    // Blocked, or held by no agent: nothing to offer.
    let blocked = try movedMatter(["moveBlocked": ["runtime": "claude", "reason": "Claude Code can't run."]])
    #expect(try blocked.moveChoice(among: agents().agents) == nil)
    let unheld = try read(Matter.self, "life/read_matter.json") { $0["moveTo"] = "codex" }
    #expect(unheld.moveChoice(among: []) == nil)
}

@Test func theMoveShownFollowsHisReceiptThenTheRead() {
    let at = Date(timeIntervalSince1970: 1_800_000_000)
    let receipt = MoveReceipt(id: "ask_1", at: at)
    let older = AgentMove(id: "ask_0", phase: .done)
    let refused = [RegisteredAgents.Refusal(ask: "ask_1", agent: nil, error: "No agent holds this matter.")]
    // No receipt: the read's own move.
    #expect(AgentMove.shown(receipt: nil, read: older, refused: [], now: at) == older)
    // The read shows his move.
    let read = AgentMove(id: "ask_1", phase: .starting)
    #expect(AgentMove.shown(receipt: receipt, read: read, refused: [], now: at) == read)
    // Refused before the desk wrote a move: failed with its words.
    #expect(
        AgentMove.shown(receipt: receipt, read: older, refused: refused, now: at)
            == AgentMove(id: "ask_1", phase: .failed, reason: "No agent holds this matter."))
    // Asked, not applied yet: its notes, then, past its patience, the read again (never a spinner for good).
    #expect(
        AgentMove.shown(receipt: receipt, read: older, refused: [], now: at) == AgentMove(id: "ask_1", phase: .notes))
    let late = at.addingTimeInterval(MoveReceipt.patience)
    #expect(AgentMove.shown(receipt: receipt, read: older, refused: [], now: late) == older)
    #expect(AgentMove.shown(receipt: receipt, read: nil, refused: [], now: late) == nil)
}

@Test func aReceiptSettlesOnceByWhatTheReadShows() {
    let at = Date(timeIntervalSince1970: 1_800_000_000)
    let receipt = MoveReceipt(id: "ask_1", at: at)
    #expect(receipt.settled(by: AgentMove(id: "ask_1", phase: .notes), read: nil) == .kept)
    #expect(receipt.settled(by: AgentMove(id: "ask_1", phase: .done), read: nil) == .done)
    // A failed move the read holds stays the read's; one only a refusal holds is said.
    let failed = AgentMove(id: "ask_1", phase: .failed, reason: "The agent is stopped.")
    #expect(receipt.settled(by: failed, read: failed) == .failed(say: nil))
    #expect(receipt.settled(by: failed, read: nil) == .failed(say: "The agent is stopped."))
    // Past its patience the read shows another move, or none.
    #expect(receipt.settled(by: AgentMove(id: "ask_0", phase: .done), read: nil) == .gone)
    #expect(receipt.settled(by: nil, read: nil) == .gone)
}

@Test func anAskWhoseAnswerWasLostTakesTheMoveTheReadShowsUnderWay() {
    let at = Date(timeIntervalSince1970: 1_800_000_000)
    let lost = MoveReceipt(id: nil, at: at)
    let earlier = AgentMove(id: "ask_0", phase: .done)
    // Before the desk applies it: its notes, kept, within its patience; then the read's again.
    let pending = AgentMove.shown(receipt: lost, read: earlier, refused: [], now: at)
    #expect(pending?.phase == .notes)
    #expect(lost.settled(by: pending, read: earlier) == .kept)
    let late = at.addingTimeInterval(MoveReceipt.patience)
    #expect(AgentMove.shown(receipt: lost, read: earlier, refused: [], now: late) == earlier)
    #expect(lost.settled(by: earlier, read: earlier) == .gone)
    // A first move: no read move yet, it still waits.
    #expect(AgentMove.shown(receipt: lost, read: nil, refused: [], now: at)?.phase == .notes)
    // The desk applied it: the move under way is his.
    let applied = AgentMove(id: "ask_1", phase: .notes)
    let shown = AgentMove.shown(receipt: lost, read: applied, refused: [], now: at)
    #expect(shown == applied)
    #expect(lost.settled(by: shown, read: applied) == .found(MoveReceipt(id: "ask_1", at: at)))
}

@Test func tryAgainRepeatsOnlyTheMoveHeAskedWhileItIsStillOffered() {
    let back = MoveChoice.back(agent: "agt_old", name: "Halden house agent")
    let failed = AgentMove(id: "ask_1", phase: .failed, reason: "The Halden house agent has ended.")
    // Moving back failed because that agent ended: the other program is offered now, never sent by Try again.
    let ended = MoveReceipt.failure(call: nil, shown: failed, tried: back, offered: .runtime(.claude))
    #expect(ended?.reason == "The Halden house agent has ended." && ended?.retry == nil)
    #expect(MoveReceipt.failure(call: nil, shown: failed, tried: back, offered: back)?.retry == back)
    // Asked elsewhere: he picks afresh.
    #expect(MoveReceipt.failure(call: nil, shown: failed, tried: nil, offered: back)?.retry == nil)
    // A call that may have gone is never sent again blind.
    let mayHaveGone = ActionFailure(reason: "The connection dropped.", retry: .allowed, mayHaveHappened: true)
    #expect(MoveReceipt.failure(call: mayHaveGone, shown: nil, tried: back, offered: back)?.retry == nil)
    #expect(
        MoveReceipt.failure(call: nil, shown: AgentMove(id: "ask_1", phase: .notes), tried: back, offered: back) == nil)
}
