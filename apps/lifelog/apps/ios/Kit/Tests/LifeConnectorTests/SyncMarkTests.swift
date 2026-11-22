import Foundation
import Library
import Testing

@testable import LifeConnector

private let read = Date(timeIntervalSince1970: 10_000)
private let soon = read.addingTimeInterval(60)
private let late = read.addingTimeInterval(SyncMark.oldAfter + 1)

private func mark(
    _ shown: ReadState<Int>.Shown = .loaded(1), reading: Bool = false, hasPath: Bool = true, lost: MCPError? = nil,
    agents: SyncMark.AgentsTrouble? = nil, now: Date = soon
) -> SyncMark? {
    SyncMark.of(
        shown, stamp: ReadStamp(at: read, isReading: reading), hasPath: hasPath, lost: lost, agents: agents, now: now)
}

@Test func allWellShowsNoMark() {
    #expect(mark() == nil)
    #expect(mark(.empty) == nil)
}

@Test func aPageWithNoValueLeavesItToItsNotice() {
    for shown: ReadState<Int>.Shown in [.loading, .unreachable, .failed("no"), .notPaired] {
        #expect(mark(shown, hasPath: false, lost: .offline) == nil)
    }
}

@Test func theConnectionComesFirstAndSaysWhenWhatShowsWasRead() {
    #expect(mark(hasPath: false, agents: .off) == .offline(since: read))
    #expect(mark(lost: .unreachable, agents: .off) == .macAway(since: read))
    #expect(mark(lost: .offline) == .offline(since: read))
    // The way back: reach lost, a read running.
    #expect(mark(reading: true, lost: .unreachable) == .reconnecting)
    #expect(mark(reading: true, hasPath: false) == .offline(since: read))
    // A stale value says when it was read, not when the stamp was.
    let stale = ReadState<Int>.Shown.stale(1, since: read.addingTimeInterval(-5), why: .unreachable)
    #expect(mark(stale) == .macAway(since: read.addingTimeInterval(-5)))
}

@Test func lifesReasonShowsUntilTheNextReadRuns() {
    let stale = ReadState<Int>.Shown.stale(1, since: read, why: .failed("Life's answer was not what this app reads."))
    #expect(mark(stale) == .failed("Life's answer was not what this app reads.", since: read))
    #expect(mark(stale, reading: true) == .updating)
}

@Test func aValueNotReadForTenMinutesIsOutOfDate() {
    #expect(mark(now: late) == .old(since: read))
    #expect(mark(reading: true, now: late) == .updating)
    #expect(mark(now: read.addingTimeInterval(SyncMark.oldAfter)) == nil)
}

@Test func theAgentsTroubleShowsOnlyWhenTheReadIsWell() {
    #expect(mark(agents: .notRunning) == .agents(.notRunning))
    #expect(mark(reading: true, agents: .notRunning) == .updating)
    #expect(mark(now: late, agents: .notRunning) == .old(since: read))
}

/// The registered agents with the desk, its helper and the first agent's status and amber set.
private func agents(desk: String = "ok", helper: String = "running", status: String = "running", amber: [String])
    throws -> RegisteredAgents
{
    var json = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_registered_agents.json").utf8)) as? [String: Any])
    var list = json["agents"] as? [[String: Any]] ?? []
    list[0].merge(["status": status, "amber": amber]) { $1 }
    (json["agents"], json["desk"], json["helper"]) = (list, desk, helper)
    return try LibraryStore.feedDecoder.decode(
        RegisteredAgents.self, from: JSONSerialization.data(withJSONObject: json))
}

@Test func theDeskSaysWhatKeepsTheAgentsFromRunning() throws {
    #expect(try agents(amber: []).trouble == nil)
    #expect(try agents(amber: ["default wait"]).trouble == nil)
    #expect(try agents(amber: ["last turn failed"]).trouble == .stalled(1))
    #expect(try agents(status: "ended", amber: ["last turn failed"]).trouble == nil)
    #expect(try agents(helper: "not running", amber: ["last turn failed"]).trouble == .notRunning)
    #expect(try agents(desk: "off", helper: "not running", amber: []).trouble == .off)
    #expect(try agents(desk: "unreadable", amber: []).trouble == .unreadable)
}

@Test func theStampIsWhenTheReadWasAskedAndWhetherItRuns() {
    var state = ReadState<Int>()
    state.apply(.succeeded(1, read))
    #expect(state.stamp == ReadStamp(at: read, isReading: false))
    state.apply(.started)
    #expect(state.stamp == ReadStamp(at: read, isReading: true))
}
