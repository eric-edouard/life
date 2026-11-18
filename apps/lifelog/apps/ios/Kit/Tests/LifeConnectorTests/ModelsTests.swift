import Foundation
import Testing

import Library

@testable import LifeConnector

private func decoded<V: Decodable>(_ type: V.Type, _ text: String) throws -> V {
    try LibraryStore.feedDecoder.decode(type, from: Data(text.utf8))
}

/// What Life's server tests wrote (`fixtures/wire/life/`) read with the phone's models: a read that changes shape fails
/// there first, then here, naming the model.
@Test func everyReadOfLifeDecodes() throws {
    let inbox = try decoded(Inbox.self, wireText("life/read_inbox.json"))
    #expect(inbox.total == 3)
    #expect(inbox.counts == ["decision": 1, "voice": 1, "name": 1])
    let decision = try #require(inbox.checks.first)
    #expect(decision.group == .decision)
    #expect(decision.options.first?.outgoing == true)
    #expect(decision.matter?.name == "Mend Gran's watch")
    #expect(decision.draft?.file?.name == "quote.pdf")
    #expect(decision.draft?.quoted?.sender == "Kit")
    #expect(decision.deadline != nil)
    let voice = inbox.checks[1]
    #expect(voice.clips.first?.audio?.jobId == "job-1")
    #expect(voice.likelyPeople.first?.name == "Gran")
    #expect(inbox.checks[2].draft == nil)

    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matters.map(\.id) == ["matter_aaaaaaaaaaaa", "matter_bbbbbbbbbbbb"])
    let row = list.matters[0]
    #expect(row.status == .moving)
    #expect(row.goal?.by == .life)
    #expect(row.nextStep?.kind == .waitEvent)
    #expect(row.people?.owedTo == ["gran"])
    #expect(row.agent == "agt_000000000001")
    #expect(list.matters[1].goal == nil)

    let matter = try decoded(Matter.self, wireText("life/read_matter.json"))
    #expect(matter.row.name == "Mend Gran's watch")
    #expect(matter.steps.count == 2)
    #expect(matter.steps[1].ending?.by == .ticked)
    #expect(matter.agents.first?.runtime == "claude")

    let agents = try decoded(RegisteredAgents.self, wireText("life/read_registered_agents.json"))
    #expect(agents.desk == .ok)
    #expect(agents.helper == .running)
    #expect(agents.agents[0].matter?.status == .moving)
    #expect(agents.agents[1].wait?.reason == "his answer")
    #expect(agents.agents[1].link == nil)
}

@Test func aValueOrAFieldLifeAddsNeverBreaksARead() throws {
    let text = #"""
        {"matters":[{"id":"m","name":"New kind","status":"on_ice","something":{"new":true},
        "nextStep":{"kind":"wait_robot","text":"t"},"goal":{"by":"a_new_one","text":"g"}}]}
        """#
    let row = try #require(try decoded(MatterList.self, text).matters.first)
    #expect(row.status == .unknown)
    #expect(row.nextStep?.kind == .unknown)
    #expect(row.goal?.by == .unknown)
}

@Test func theListSearchesAndCountsOnThePhone() throws {
    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matching("watch").map(\.name) == ["Mend Gran's watch"])
    #expect(list.matching("QUOTE").count == 1)
    #expect(list.matching("  ").count == 2)
    #expect(list.matching("nothing like it").isEmpty)
    #expect(list.statusCounts == [.moving: 1, .waitingOnSomeone: 1])
}
