import Foundation
import Testing

import Library

@testable import LifeConnector

private func decoded<V: Decodable>(_ type: V.Type, _ text: String) throws -> V {
    try LibraryStore.feedDecoder.decode(type, from: Data(text.utf8))
}

/// What Life's server tests wrote (`fixtures/wire/life/`) read with the phone's models: a read that changes shape fails
/// there first, then here, naming the model.
#if DEBUG
    /// The simulator's design data, put together as the fixture answers with it (`DesignReplies`), reads with the phone's own
    /// reply models: a reply that breaks a model (a field gone, a shape changed) fails here, not on screen.
    @Test func theDesignDataDecodes() throws {
        func object(_ name: String) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: Data(designText(name).utf8)) as? [String: Any])
        }
        func reply<V: Decodable>(_ type: V.Type, _ value: [String: Any]) throws -> V {
            try decoded(type, String(decoding: JSONSerialization.data(withJSONObject: value), as: UTF8.self))
        }
        let read = try object("read_inbox")
        let checks = try #require(read["checks"] as? [[String: Any]])
        let inbox = try reply(Inbox.self, DesignReplies.inbox(read, checks: checks))
        #expect(!inbox.checks.isEmpty && inbox.total == inbox.checks.count)
        let rows = try #require(try object("read_matters")["matters"] as? [[String: Any]])
        #expect(try reply(MatterList.self, DesignReplies.matters(rows)).matters.count == rows.count)
        let agents = try object("read_registered_agents")
        #expect(try !decoded(RegisteredAgents.self, designText("read_registered_agents")).agents.isEmpty)
        let matterRead = try object("read_matter")
        let allAgents = (agents["agents"] as? [[String: Any]] ?? []) + (matterRead["agents"] as? [[String: Any]] ?? [])
        for row in rows {
            let matter = try reply(
                Matter.self,
                DesignReplies.matter(
                    row, agents: allAgents, steps: matterRead["steps"] as? [String: Any] ?? [:], checks: checks))
            #expect(!matter.steps.isEmpty, "\(matter.row.id)")
        }
    }
#endif

@Test func everyReadOfLifeDecodes() throws {
    let inbox = try decoded(Inbox.self, wireText("life/read_inbox.json"))
    #expect(inbox.total == 8)
    #expect(inbox.blocking == 5)
    #expect(inbox.badge == 5)
    #expect(inbox.counts.values.reduce(0, +) == 8)
    #expect(
        inbox.checks.map(\.urgency) == [.blocks, .blocks, .blocks, .blocks, .blocks, .improves, .improves, .improves])
    let decision = try #require(inbox.checks.first)
    #expect(decision.group == .decision)
    #expect(decision.options.first?.outgoing == true)
    #expect(decision.matter?.name == "Mend Gran's watch")
    #expect(decision.draft?.file?.name == "quote.pdf")
    #expect(decision.draft?.quoted?.sender == "Kit")
    #expect(decision.deadline != nil)
    #expect(decision.confirm?.first?.group == .guessedPerson)
    // The identity ask: who the guess is as WhatsApp shows them, with WhatsApp's own link to the chat.
    let onNetwork = try #require(decision.confirm?.first?.networkIdentity)
    #expect(onNetwork.network == "WhatsApp")
    #expect(onNetwork.handle == "+33600000001")
    #expect(onNetwork.openUrl == URL(string: "https://wa.me/33600000001"))
    #expect(onNetwork.newest?.text == "Kit here, from the shop")
    // The draft's own chat, as its network shows it: stored, so no newest message.
    #expect(decision.networkIdentity?.network == "WhatsApp")
    #expect(decision.networkIdentity?.newest == nil)
    #expect(decision.ridesOn?.matters == 1)
    // A transfer (the asks contract): its needs in the agent's order, each with Life's line; Life's look found nothing yet.
    let transfer = inbox.checks[1]
    #expect(transfer.needs?.map(\.kind) == [.account, .amount, .link, .text, .unknown])
    #expect(transfer.needs?.map { $0.rows.count } == [3, 1, 1, 1, 1])
    #expect(transfer.needs?.last?.rows == [NeedRow(glyph: .note, text: "QR code from Reef's WhatsApp of 14 Oct")])
    #expect(transfer.doneSeen == Check.DoneSeen(state: .notFound, line: "Not in your accounts yet"))
    #expect(transfer.options.map(\.takes) == [nil, .note, nil])

    #expect(inbox.checks.map(\.group).contains(.newMatter))
    let voice = try #require(inbox.checks.first { $0.group == .voice })
    #expect(voice.clips.first?.audio?.jobId == "job-1")
    let clip = try #require(voice.clips.first)
    let words = try #require(clip.words)
    #expect(words.spokenIndex(at: 400).flatMap { words.ranges(in: clip.text)?[$0] } == NSRange(location: 5, length: 3))
    #expect(voice.likelyPeople.first?.name == "Gran")
    #expect(voice.likelyPeople.first?.line == "Your grandmother")
    #expect(voice.likelyPeople.first?.kind == .person)
    #expect(voice.likelyPeople.first?.picture?.id == "00000000000000000000000000000a02")
    let name = try #require(inbox.checks.first { $0.group == .name })
    #expect(name.said?.by == "Gran")
    #expect(name.askedName == "Sam")
    #expect(inbox.checks.first { $0.group == .ending }?.ridesOn?.matters == 1)
    let found = try #require(
        try decoded(Matter.self, wireText("life/read_matter_found.json")).checks.first)
    #expect(found.group == .newMatter)
    #expect(found.options.map(\.id) == ["start", "edit-goal", "dismiss"])
    #expect(found.deadline == nil)
    #expect(found.options.map(\.label) == ["Start", "Edit goal", "No"])
    #expect(found.goal == "Gran's photo is framed.")
    #expect(inbox.checks.last?.draft == nil)

    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matters.map(\.id) == ["matter_aaaaaaaaaaaa", "matter_cccccccccccc", "matter_bbbbbbbbbbbb"])
    let row = list.matters[0]
    #expect(row.status == .moving)
    #expect(row.goal?.by == .life)
    #expect(row.nextStep?.kind == .waitEvent)
    #expect(row.people?.owedTo?.map(\.ref) == ["person:gran"])
    #expect(row.people?.with?.first?.picture == nil)
    #expect(row.agent == "agt_000000000001")
    #expect(row.blockingChecks == 1)
    #expect(row.important == true)
    #expect(row.project == MatterProject(id: "shop-fit-out", name: "Shop fit-out", status: .active))
    #expect(list.matters.map(\.isParked) == [false, false, false])
    #expect(list.matters[2].goal == nil)
    // His pick, Life's, and none (the phone shows the area's).
    #expect(list.matters.map(\.icon?.by) == [.owner, nil, .life])
    #expect(list.matters.map(\.icon?.key) == ["tools", nil, "key"])
    #expect(list.matters.compactMap(\.icon?.key).allSatisfy { MatterIcons.symbol($0) != nil })
    #expect(MatterIcons.symbol("a_new_key") == nil)
    #expect(list.matters[2].important == nil)
    #expect(list.project == nil)

    let project = try decoded(MatterList.self, wireText("life/read_matters_project.json"))
    #expect(project.project?.name == "Shop fit-out")
    #expect(project.project?.status == .active)
    #expect(project.project?.goal == "The shop opens in spring.")
    #expect(project.matters.map(\.id) == ["matter_aaaaaaaaaaaa"])

    let matter = try decoded(Matter.self, wireText("life/read_matter.json"))
    #expect(matter.row.name == "Mend Gran's watch")
    #expect(matter.row.icon == MatterRow.Icon(by: .owner, key: "tools"))
    #expect(matter.steps.count == 2)
    #expect(matter.steps[1].ending?.by == .ticked)
    #expect(matter.checks.map(\.group) == [.decision, .ending])
    #expect(matter.agents.first?.runtime == "claude")
    #expect(matter.agents.first?.notStarted == nil)

    let agents = try decoded(RegisteredAgents.self, wireText("life/read_registered_agents.json"))
    #expect(agents.desk == .ok)
    #expect(agents.helper == .running)
    #expect(agents.agents[0].matter?.status == .moving)
    #expect(agents.agents[1].wait?.reason == "his answer")
    #expect(agents.agents[1].link == nil)
}

@Test func aValueOrAFieldLifeAddsNeverBreaksARead() throws {
    let text = #"""
        {"matters":[{"id":"m","name":"New kind","status":"on_ice","needsYou":false,"something":{"new":true},
        "nextStep":{"kind":"wait_robot","text":"t"},"goal":{"by":"a_new_one","text":"g"}}]}
        """#
    let row = try #require(try decoded(MatterList.self, text).matters.first)
    #expect(row.status == .unknown)
    #expect(row.nextStep?.kind == .unknown)
    #expect(row.goal?.by == .unknown)
}

@Test func theListSearchesOnThePhone() throws {
    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matching("watch").map(\.name) == ["Mend Gran's watch"])
    #expect(list.matching("QUOTE").count == 1)
    #expect(list.matching("  ").count == 3)
    #expect(list.matching("nothing like it").isEmpty)
}

@Test func theFiltersNarrowTheListAndAreasComeMostFirst() throws {
    let text = #"""
        {"matters":[
        {"id":"a","name":"A","status":"moving","needsYou":true,"areas":["Home","Money"],"agent":"agt_1","nextStep":{"kind":"wait_decision","text":"x"}},
        {"id":"b","name":"B","status":"stuck","needsYou":false,"areas":["Home"],"nextStep":{"kind":"do","text":"y"}},
        {"id":"c","name":"C","status":"moving","needsYou":false,"areas":["Work"],"nextStep":{"kind":"do","text":"z"}},
        {"id":"d","name":"D","status":"dormant","needsYou":false}]}
        """#
    let list = try decoded(MatterList.self, text)
    #expect(list.areasByCount == ["Home", "Money", "Work"])
    func ids(_ filter: MatterFilter) -> [String] { list.shown(filter: filter) { _ in false }.map(\.id) }
    #expect(ids(.everything) == ["a", "b", "c", "d"])
    #expect(ids(.area("Home")) == ["a", "b"])
    #expect(ids(.needsYou) == ["a"])
    #expect(ids(.agentWorking) == ["a"])
}

@Test func aParkedOrDoneProjectsMattersAreParkedAndTheMarkFilters() throws {
    let text = #"""
        {"matters":[
        {"id":"a","name":"A","status":"moving","important":true,"project":{"id":"p","name":"P","status":"waiting"}},
        {"id":"b","name":"B","status":"moving","project":{"id":"q","name":"Q","status":"parked"}},
        {"id":"c","name":"C","status":"moving","project":{"id":"r","name":"R","status":"done"}},
        {"id":"d","name":"D","status":"moving","project":{"id":"s","name":"S","status":"on_ice"}}]}
        """#
    let list = try decoded(MatterList.self, text)
    #expect(list.matters.map(\.isParked) == [false, true, true, false])
    #expect(list.matters[0].project?.status.isUnderway == true)
    #expect(list.matters[3].project?.status == .unknown)
    // His mark as shown filters: a tap that unmarks "a" and marks "b" moves both.
    #expect(list.shown(filter: .important) { $0.important == true }.map(\.id) == ["a"])
    #expect(list.shown(filter: .important) { $0.id == "b" }.map(\.id) == ["b"])
}

@Test func aRowCarriesLifesWordThatItNeedsHim() throws {
    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matters.map(\.needsYou) == [true, false, false])
}

@Test func theActionsResultsDecode() throws {
    let sent = try decoded(AnswerResult.self, wireText("life/answer_check_sent.json"))
    #expect(sent.send?.state == .sent)
    #expect(sent.send?.to == "Kit Moreau")
    #expect(sent.asker?.told == "on_its_next_poll")
    let notSent = try decoded(AnswerResult.self, wireText("life/answer_check_not_sent.json"))
    #expect(notSent.send?.state == .notSent)
    #expect(notSent.send?.canRetry == true)
    let found = try decoded(AnswerResult.self, wireText("life/answer_check_new_matter_started.json"))
    #expect(found.start?.state == .started)
    #expect(found.start?.stages?.count == 3)
    // "I've paid": Life's look, seen or not found yet, beside the answer.
    let looks: [(String, Check.DoneSeen.State)] = [
        ("answer_check_done_seen", .seen), ("answer_check_not_found", .notFound),
    ]
    for (file, state) in looks {
        let text = try wireText("life/\(file).json")
        #expect(try decoded(AnswerResult.self, text).send == nil)
        #expect(try decoded(AnswerResult.self, text).doneSeen?.state == state)
    }
    let edited = try decoded(AnswerResult.self, wireText("life/answer_check_new_matter_goal_edited.json"))
    #expect(edited.start == nil)
    let started = try decoded(AgentChangeResult.self, wireText("life/change_registered_agent_started.json"))
    #expect(started.state == .started)
    #expect(started.stages?.map(\.stage) == ["desk_accepted", "session_open", "turn_begun"])
    let refused = try decoded(AgentChangeResult.self, wireText("life/change_registered_agent_not_started.json"))
    #expect(refused.state == .notStarted)
    #expect(refused.failed?.stage == "desk_accepted")
    #expect(refused.runtime == "claude")
    #expect(refused.nothingRunning == true)
    let named = #"{"ref":"voice:v1","kind":"voice","changed":{"voices":3,"conversations":2}}"#
    #expect(try decoded(AnswerResult.self, named).changed?.voices == 3)
    #expect(try decoded(AnswerResult.self, named).changed?.conversations == 2)
    let future = #"{"action":"x","state":"a_new_state","stages":[{"stage":"s","extra":1}]}"#
    #expect(try decoded(AgentChangeResult.self, future).state == .unknown)
}

@Test func aPushOpensTheCardWithItsIdOrTheFirstOneWhenItIsGone() throws {
    let inbox = try decoded(Inbox.self, wireText("life/read_inbox.json"))
    let wanted = try #require(inbox.checks[0].pushId)
    #expect(inbox.opening(pushId: wanted) == InboxOpening(check: inbox.checks[0], wasAnswered: false))
    let gone = inbox.opening(pushId: "ffffffffffffffff")
    #expect(gone.check == inbox.checks.first)
    #expect(gone.wasAnswered)
}

/// Every kind of check the server makes: his inbox, and the new matter's check again on its matter's page.
private func everyKindOfCheck() throws -> [Check] {
    try decoded(Inbox.self, wireText("life/read_inbox.json")).checks
        + decoded(Matter.self, wireText("life/read_matter_found.json")).checks
}

/// Every kind Life sends answers with its own options, as `answer_check` takes them: one tap for an option that takes
/// nothing more, the person or the name for one that names someone, his words for one that takes a note, and his own
/// words only where an agent reads them (a decision). Read from the server's own inbox, never a hand-made one.
@Test func everyKindOfCardAnswersAsLifeTakesIt() throws {
    let all = try everyKindOfCheck()
    func card(_ group: CheckGroup) throws -> Check { try #require(all.first { $0.group == group }) }
    #expect(Set(all.map(\.group)) == Set(CheckGroup.allCases).subtracting([.unknown]))

    let decision = try card(.decision)
    #expect(decision.answer(decision.options[0]) == AnswerRequest(ref: decision.ref, options: ["yes"]))
    #expect(decision.answer(words: "Later") == AnswerRequest(ref: decision.ref, options: [], note: "Later"))
    #expect(decision.takesOwnWords && decision.namingOption == nil)

    let ending = try card(.ending)
    #expect(ending.options.compactMap(ending.answer).map(\.options) == [["outdated"], ["false"]])
    #expect(ending.answer(words: "x") == nil && !ending.takesOwnWords)

    let found = try card(.newMatter)
    let edit = try #require(found.options.first { $0.id == "edit-goal" })
    #expect(found.answer(edit) == nil)
    #expect(found.answer(words: "Framed") == AnswerRequest(ref: found.ref, options: ["edit-goal"], note: "Framed"))
    #expect(found.answer(found.options[0]) == AnswerRequest(ref: found.ref, options: ["start"]))

    for group in [CheckGroup.name, .contactsCard] {
        let check = try card(group)
        let only = try #require(check.namingOption)
        #expect(check.answer(only) == nil, "\(group): its one option needs who it is")
        #expect(
            check.answer(naming: .person("person:gran"))
                == AnswerRequest(ref: check.ref, options: [only.id], person: "person:gran"))
        // A name he types is a new person's name (the create sheet's): the one person Life holds by it, else added (life#721).
        #expect(
            check.answer(naming: .name("Gran")) == AnswerRequest(ref: check.ref, options: [only.id], name: "Gran"))
        #expect(!check.takesOwnWords)
    }
    // The create sheet: the person through the naming option, his words only when given; the organization by its own.
    let name = try card(.name)
    #expect(!name.createsByName, "Life has people to suggest")
    #expect(
        name.answer(creating: "Sam Vale", note: nil, asOrganization: false)
            == AnswerRequest(ref: name.ref, options: ["this-is"], name: "Sam Vale"))
    #expect(
        name.answer(creating: "Sam Vale", note: "A shop", asOrganization: true)
            == AnswerRequest(ref: name.ref, options: ["organization"], note: "A shop", name: "Sam Vale"))
    #expect(decision.answer(creating: "Lou", note: nil, asOrganization: false) == nil)
    #expect(try card(.voice).organizationOption == nil)
    #expect(try card(.contactsCard).likelyPeople.map(\.ref) == ["person:gran", "person:partner"])
    #expect(try card(.contactsCard).networkIdentity == nil)
    #expect(try card(.contactsCard).contactsCard?.name == "Lou")
    #expect(try card(.contactsCard).contactsCard?.handles == ["+33600000009"])

    let guess = try card(.guessedPerson)
    #expect(guess.answer(guess.options[0]) == AnswerRequest(ref: guess.ref, options: ["this-is"]))
    #expect(guess.namingOption?.id == "same-person")

    let voice = try card(.voice)
    #expect(voice.namingOption?.id == "this-is")
    #expect(voice.isNamingFilled && !guess.isNamingFilled && !found.isNamingFilled)
    #expect(voice.answer(voice.options[0]) == nil)
    #expect(
        voice.answer(naming: .person("person:gran"))
            == AnswerRequest(ref: voice.ref, options: ["this-is"], person: "person:gran"))
    #expect(voice.answer(naming: .name("Sam")) == AnswerRequest(ref: voice.ref, options: ["this-is"], name: "Sam"))
    #expect(voice.options.dropFirst().compactMap(voice.answer).count == 1)

    // No button reads like the words a model is given.
    #expect(all.flatMap(\.options).allSatisfy { !$0.label.contains("`") && $0.label.count < 30 })
}

/// Only a name card opens the create sheet: a voice's new name goes to lifelog alone, and a Contacts card's `about` holds
/// its handles, never a name to create. Its note is his words only: trimmed, and never Life's guess (life#737).
@Test func onlyANameCardCreatesBySheet() throws {
    let all = try everyKindOfCheck()
    func card(_ group: CheckGroup) throws -> Check { try #require(all.first { $0.group == group }) }
    let name = try card(.name)
    #expect(name.createsBySheet && name.askedName != nil)
    let organization = try #require(name.organizationOption)
    #expect(name.createsOrganizationBySheet(organization), "\"Organization\" opens the sheet, never answers at once")
    #expect(name.options.filter(name.createsOrganizationBySheet).map(\.id) == ["organization"])
    for group in [CheckGroup.voice, .contactsCard] {
        let check = try card(group)
        #expect(!check.createsBySheet && !check.createsByName && check.askedName == nil, "\(group)")
        #expect(check.answer(creating: "Lou", note: "Gran's friend", asOrganization: false) == nil, "\(group)")
    }
    let guess = "Mentioned by Nora Keller, about “Quote”"
    let create = { (note: String) in
        name.answer(creating: " Sam Vale ", note: note, guess: guess, asOrganization: false)
    }
    #expect(create(guess + " ")?.note == nil, "a whitespace edit of Life's guess is not his words")
    #expect(
        create(guess.replacing(" by ", with: "  by "))?.note == nil, "nor is a space doubled between its words")
    #expect(create("  ")?.note == nil)
    #expect(create(" Nora's architect ")?.note == "Nora's architect")
    #expect(create("x")?.name == "Sam Vale")
}

@Test func theAskerIsNamedOnce() throws {
    let all = try everyKindOfCheck()
    let voice = try #require(all.first { $0.group == .voice })
    #expect(voice.agentName(runtime: nil) == nil)
    #expect(all[0].agentName(runtime: .claude) == "Claude Code")
    #expect(all[0].agentName(runtime: nil) == "Orbit")
    let name = try #require(all.first { $0.group == .name })
    #expect(name.agentName(runtime: nil) == nil)
}

/// An ask names the agent that asked it, so its program shows even once that agent is over; an ask naming none shows
/// no program, never the program of another agent on its matter.
@Test func theAskingAgentsProgramIsTheOneItNames() throws {
    func edited(_ path: String, _ change: (inout [String: Any]) -> Void) throws -> Data {
        var json = try #require(JSONSerialization.jsonObject(with: Data(wireText(path).utf8)) as? [String: Any])
        change(&json)
        return try JSONSerialization.data(withJSONObject: json)
    }
    let decoder = LibraryStore.feedDecoder
    let agents = try decoder.decode(
        RegisteredAgents.self,
        from: edited("life/read_registered_agents.json") { json in
            var list = json["agents"] as? [[String: Any]] ?? []
            list[0]["id"] = "agt_over"
            list[0]["runtime"] = "codex"
            list[0]["status"] = "ended"
            json["agents"] = list
        }
    ).agents
    let inbox = try decoder.decode(
        Inbox.self,
        from: edited("life/read_inbox.json") { json in
            var checks = json["checks"] as? [[String: Any]] ?? []
            let at = checks.firstIndex { $0["group"] as? String == "decision" } ?? 0
            checks[at]["agent"] = "agt_over"
            json["checks"] = checks
        })
    let decision = try #require(inbox.checks.first { $0.group == .decision })
    #expect(decision.askingRuntime(among: agents) == .codex)
    #expect(decision.askingRuntime(among: []) == nil)
    let unnamed = try #require(
        decoded(Inbox.self, wireText("life/read_inbox.json")).checks.first { $0.group == .decision })
    #expect(unnamed.agent == nil && unnamed.askingRuntime(among: agents) == nil)
    let lifes = try #require(inbox.checks.first { $0.agentName(runtime: nil) == nil })
    #expect(lifes.askingRuntime(among: agents) == nil)
}

/// The inbox's checks, made from the server's own read: one ask per ref, with the urgency given.
private func asks(_ urgencies: [(String, Urgency)], groups: [String: String] = [:]) throws -> Inbox {
    let wire = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    let first = try #require((wire["checks"] as? [[String: Any]])?.first)
    let checks = urgencies.map { ref, urgency in
        first.merging(["ref": ref, "urgency": urgency.rawValue, "group": groups[ref] ?? first["group"] ?? ""]) { $1 }
    }
    let body = wire.merging(["checks": checks]) { $1 }
    return try decoded(Inbox.self, String(decoding: JSONSerialization.data(withJSONObject: body), as: UTF8.self))
}

@Test func theInboxRunsWhatBlocksThenWhatCanWait() throws {
    let inbox = try asks([("i1", .improves), ("b1", .blocks), ("i2", .improves), ("b2", .blocks)])
    let order = inbox.ordered(deferred: [])
    #expect(order.checks.map(\.ref) == ["b1", "b2", "i1", "i2"])
    #expect(order.canWaitFrom == 2)
    // His answer to the last blocking ask leads to the first that can wait.
    #expect(order.checks.ref(after: "b2") == "i1" && order.checks.ref(after: "i2") == nil)
    #expect(order.check(on: nil)?.ref == "b1" && order.check(on: "gone")?.ref == "b1")
}

@Test func withNothingBlockingWhatCanWaitStartsFirstAndWithNothingImprovingThereIsNoHeading() throws {
    #expect(try asks([("i1", .improves)]).ordered(deferred: []).canWaitFrom == 0)
    #expect(try asks([("b1", .blocks)]).ordered(deferred: []).canWaitFrom == nil)
    #expect(try asks([]).ordered(deferred: []).checks.isEmpty)
}

@Test func anAskKeptForLaterStaysInsideItsOwnKind() throws {
    let inbox = try asks([("b1", .blocks), ("b2", .blocks), ("i1", .improves), ("i2", .improves)])
    #expect(inbox.ordered(deferred: ["b1", "i1"]).checks.map(\.ref) == ["b2", "b1", "i2", "i1"])
}

@Test func anAnswerHeldOrInFlightIsLeftOutSoTheListNeverFlashesItBack() throws {
    let order = try asks([("b1", .blocks), ("b2", .blocks), ("i1", .improves)]).ordered(
        deferred: [], except: ["b1", "i1"])
    #expect(order.checks.map(\.ref) == ["b2"] && order.canWaitFrom == nil)
}

@Test func theFilledOptionIsTheFirst() throws {
    #expect(
        try asks([("b1", .blocks)]).checks[0].filled?.id == #require(asks([("b1", .blocks)]).checks[0].options.first).id
    )
}

@Test func theListsFilterKeepsTheOrderAndNeverEmptiesIt() throws {
    let order = try asks(
        [("b1", .blocks), ("v1", .blocks), ("i1", .improves), ("v2", .improves)],
        groups: ["v1": "voice", "v2": "voice"]
    ).ordered(deferred: [])
    #expect(order.kinds.count == 2 && order.kinds.contains(.voice))
    let voices = order.only(.voice)
    #expect(voices.checks.map(\.ref) == ["v1", "v2"] && voices.canWaitFrom == 1)
    #expect(order.only(nil) == order)
    // A kind with none waiting is no filter at all.
    #expect(order.only(.newMatter) == order)
}

/// A name card with no one to suggest offers "Create <name>", the longest name it asks about.
@Test func aNameWithNoOneToSuggestIsCreatedByItsWholeName() throws {
    let inbox = try JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any]
    var name = try #require((inbox?["checks"] as? [[String: Any]])?.first { $0["group"] as? String == "name" })
    (name["likelyPeople"], name["about"]) = ([], ["Sam", "Sam Vale"])
    let check = try decoded(Check.self, String(decoding: JSONSerialization.data(withJSONObject: name), as: UTF8.self))
    #expect(check.createsByName)
    #expect(check.askedName == "Sam Vale")
}

/// His answer is confirmed while a read asked before it is still on its way: that read, landing after, still lists the
/// card, and the card stays out. A read asked after the answer wins, even one that lists it (Life kept it open).
@Test func anAnswerConfirmedAfterAReadWasAskedStaysOutOfIt() throws {
    let asked = Date(timeIntervalSince1970: 100)
    var answered = AnsweredCards()
    answered.answered("b1", at: asked.addingTimeInterval(1), pairing: answered.pairing)
    let read = try asks([("b1", .blocks), ("b2", .blocks), ("i1", .improves)])
    let shown = read.without(answered.newer(than: asked))
    #expect(shown.checks.map(\.ref) == ["b2", "i1"])
    #expect(shown.badge == read.badge - 1 && shown.total == read.total - 1)
    #expect(answered.newer(than: asked.addingTimeInterval(2)).isEmpty)
    // Nothing read yet (a cold start with no cache): it stays out too.
    #expect(answered.newer(than: nil) == ["b1"])
    // Kept for a cold start.
    let kept = try JSONDecoder().decode(AnsweredCards.self, from: JSONEncoder().encode(answered))
    #expect(kept == answered)
}

/// After a restart, a matter read kept from before an answer can still be opened offline: the answer is kept until
/// every kept read was asked after it, and only then forgotten (at launch, when no read is under way).
@Test func anAnswerIsKeptWhileAnOlderKeptReadCanStillShowItsCard() throws {
    let at = { Date(timeIntervalSince1970: $0) }
    let cache = ReadCache(directory: FileManager.default.temporaryDirectory.appending(path: "reads-\(UUID())"))
    defer { cache.clear() }
    var answered = AnsweredCards()
    answered.answered("a", at: at(10), pairing: answered.pairing)
    cache.store("{}", key: "read_matter-m1", asked: at(5))
    cache.store("{}", key: "read_inbox", asked: at(20))
    cache.store("{}", key: "answered_cards", asked: at(30))
    // He answers B after a restart: A stays, the matter read kept from before it can still show A.
    answered.forget(confirmedBy: cache.oldest(except: "answered_cards"))
    answered.answered("b", at: at(40), pairing: answered.pairing)
    #expect(answered.newer(than: at(5)) == ["a", "b"])
    // Once every kept read was asked after both, they go; with none kept, all go.
    cache.store("{}", key: "read_matter-m1", asked: at(50))
    cache.store("{}", key: "read_inbox", asked: at(50))
    answered.forget(confirmedBy: cache.oldest(except: "answered_cards"))
    #expect(answered.newer(than: nil).isEmpty)
    answered.answered("c", at: at(60), pairing: answered.pairing)
    cache.clear()
    answered.forget(confirmedBy: cache.oldest(except: "answered_cards"))
    #expect(answered.newer(than: nil).isEmpty)
}

/// An answer begun under one pairing that Life confirms after a new pairing adds nothing to the new one.
@Test func anAnswerBegunBeforeARepairingAddsNothingAfterIt() {
    let old = AnsweredCards()
    var new = AnsweredCards()
    let late = new.answered("a", at: Date(), pairing: old.pairing)
    #expect(!late && new.newer(than: nil).isEmpty)
    let current = new.answered("b", at: Date(), pairing: new.pairing)
    #expect(current && new.newer(than: nil) == ["b"])
}

/// Only a new matter's `edit-goal` keeps its card open; another kind's option of that id closes it.
@Test func onlyANewMattersGoalEditKeepsItsCardOpen() throws {
    let all = try everyKindOfCheck()
    let newMatter = try #require(all.first { $0.group == .newMatter })
    let decision = try #require(all.first { $0.group == .decision })
    #expect(newMatter.keepsOpen(after: AnswerRequest(ref: newMatter.ref, options: ["edit-goal"], note: "A goal")))
    #expect(!decision.keepsOpen(after: AnswerRequest(ref: decision.ref, options: ["edit-goal"])))
    #expect(!newMatter.keepsOpen(after: AnswerRequest(ref: newMatter.ref, options: ["start"])))
}

@Test func anInboxLessItsAnsweredCardsLowersOnlyWhatTheyCounted() throws {
    let read = try asks([("b1", .blocks), ("i1", .improves)], groups: ["i1": "ending"])
    let shown = read.without(["i1"])
    #expect(shown.blocking == read.blocking && shown.total == read.total - 1)
    #expect(shown.counts["ending"] == read.counts["ending"].map { $0 - 1 })
    #expect(read.without([]) == read)
}
