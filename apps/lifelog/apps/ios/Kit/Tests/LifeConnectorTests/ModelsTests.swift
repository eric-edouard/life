import Foundation
import Testing

import Library

@testable import LifeConnector

private func decoded<V: Decodable>(_ type: V.Type, _ text: String) throws -> V {
    try LibraryStore.feedDecoder.decode(type, from: Data(text.utf8))
}

/// What Life's server tests wrote (`fixtures/wire/life/`) read with the phone's models: a read that changes shape fails
/// there first, then here, naming the model.


/// A plan's start is its filled answer whatever order its asker sent; a card with no roles keeps its order; its steps
/// draw whatever `isPlan` says.
@Test func aPlanStartsFirstAndDrawsItsStepsWhateverItsMarker() throws {
    let card = { (isPlan: Bool, options: String) in
        try decoded(
            Check.self,
            #"{"group":"decision","ref":"d","title":"Mend it","question":"Start?","asker":"a","isPlan":\#(isPlan),"options":\#(options),"plan":[{"text":"Ask","by":"agent"},{"text":"Pay","by":"someone"}],"clips":[],"likelyPeople":[],"links":[]}"#
        )
    }
    let reversed = try card(
        false,
        #"[{"id":"no","label":"Not this plan","role":"decline"},{"id":"go","label":"Start the plan","role":"start"}]"#)
    #expect(reversed.optionsInOrder.map(\.id) == ["go", "no"] && reversed.filled?.id == "go")
    #expect(reversed.planSteps.map(\.by) == [.agent, .unknown])
    #expect(reversed.planSteps.map(\.spoken) == ["The agent: Ask", "Pay"])
    let plain = try card(true, #"[{"id":"b","label":"B"},{"id":"a","label":"A"}]"#)
    #expect(plain.optionsInOrder.map(\.id) == ["b", "a"])
}

/// Decision 75: his words on a card go to whoever hears them, named by the card's holder (its standing role, as the
/// desk sends it), never "Send"; Life's own question, or one he asked through his own app, is told to Life.
@Test func aCardsAnswerNamesWhoHearsHisWords() throws {
    let inbox = try decoded(Inbox.self, wireText("life/read_inbox.json"))
    let agents = try decoded(RegisteredAgents.self, wireText("life/read_registered_agents.json")).agents
    #expect(agents.map(\.role) == [.personal, nil])
    let held = try #require(inbox.checks.first { $0.agent == agents[0].id })
    #expect(held.hearer(among: agents) == "the Personal agent")
    #expect(held.ownWordsTitle == "Tell the agent…")
    let lifes = try #require(inbox.checks.first { $0.isLifesOwn })
    #expect(lifes.hearer(among: agents) == "Life")
    #expect(lifes.ownWordsTitle == "Ask Life…")
    let other = try #require(inbox.checks.first { $0.agent == nil && !$0.isLifesOwn })
    #expect(other.hearer(among: agents) == "the agent")
    var fields = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    var first = try #require((fields["checks"] as? [[String: Any]])?.first)
    first["asker"] = "owner"
    fields["checks"] = [first]
    let owners = try decoded(
        Inbox.self, String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self))
    #expect(owners.checks[0].hearer(among: agents) == "Life")
}

/// An ask with no matter of its own is on the first matter it rides on; one from a Life that sends neither is on none.
@Test func anAskIsOnItsOwnMatterElseTheFirstItRidesOn() throws {
    var fields = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    var first = try #require((fields["checks"] as? [[String: Any]])?.first)
    first["matter"] = nil
    first["ridesOn"] = ["observations": 0, "matters": 2, "pages": 0, "matterIds": ["m1", "m2"]]
    var older = first
    older["ridesOn"] = ["observations": 0, "matters": 0, "pages": 0]
    fields["checks"] = [first, older]
    let inbox = try decoded(
        Inbox.self, String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self))
    #expect(inbox.checks.map(\.matterID) == ["m1", nil])
}

/// His words go with the option he picked that takes them, and with none when he answered in general ("Tell the
/// agent…"): a general reply never submits an option's meaning ("Paid another way").
@Test func hisWordsGoWithThePickedOptionOrNone() throws {
    let inbox = try decoded(Inbox.self, wireText("life/read_inbox.json"))
    let card = try #require(inbox.checks.first { $0.options.contains { $0.takes == .note } })
    let note = try #require(card.options.first { $0.takes == .note })
    #expect(card.answer(words: "Not yet") == AnswerRequest(ref: card.ref, options: [], note: "Not yet"))
    #expect(
        card.answer(words: "By bank", option: note.id)
            == AnswerRequest(ref: card.ref, options: [note.id], note: "By bank"))
    #expect(card.answer(words: "x", option: "no such") == AnswerRequest(ref: card.ref, options: [], note: "x"))
    let two =
        #"{"ref":"dec_2","group":"decision","title":"t","question":"q","asker":"a","options":[{"id":"cash","label":"Paid in cash","takes":"note"},{"id":"bank","label":"Paid by bank","takes":"note"},{"id":"step","label":"It’s done","ends":"step"},{"id":"all","label":"Drop it","ends":"matter"}],"clips":[],"likelyPeople":[],"links":[]}"#
    let check = try JSONDecoder().decode(Check.self, from: Data(two.utf8))
    #expect(check.answer(words: "On Tuesday", option: "bank")?.options == ["bank"])
    #expect(check.options.map(\.label) == ["Paid in cash", "Paid by bank", "It’s done", "Drop it"])
    #expect(check.options.compactMap(\.ends) == [.step, .matter])
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


@Test func aParkedOrDoneProjectsMattersAreParked() throws {
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
}

@Test func aRowCarriesLifesWordThatItNeedsHim() throws {
    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matters.map(\.needsYou) == [true, false, true])
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

/// A card's context is behind one link whose words are the code's, by what the card asks; the context's `life:` links come
/// with their kinds; a card with no context has no link. Read from the server's own inbox.
@Test func aCardsContextLinkIsWordedByWhatItAsks() throws {
    let all = try everyKindOfCheck()
    let draft = try #require(all.first { $0.draft != nil })
    #expect(draft.contextLinkTitle == "Why this reply?")
    #expect(draft.lifeLinks == [.init(ref: "msg:whatsapp|whatsapp:155@s.whatsapp.net/M1", kind: .message)])
    #expect(all.filter { ($0.context ?? "").isEmpty }.allSatisfy { $0.contextLinkTitle == nil })
    let guess = try #require(draft.confirm?.first)
    #expect(guess.contextLinkTitle?.hasPrefix("Why ") == true && guess.contextLinkTitle != "Why it asks")
    for check in all where check.contextLinkTitle != nil && check.draft == nil {
        switch check.group {
        case .ending: #expect(check.contextLinkTitle == "Why done?")
        case .newMatter, .yourMove: #expect(check.contextLinkTitle == "What Life saw")
        case .decision: #expect(check.contextLinkTitle == "Why it asks")
        default: #expect(check.contextLinkTitle?.hasSuffix("?") == true)
        }
    }
}

/// A `life:` link's page: a person's read by name and line, else Life's text less its data heading.
@Test func aLifeLinksReadIsAPersonOrLifesText() {
    #expect(
        LifeLinkRead(#"{"kind":"person","name":"Test Ana","line":"baker","ref":"person:test-ana"}"#)
            == .person(name: "Test Ana", line: "baker"))
    #expect(LifeLinkRead(LifeLinkRead.heading + "\n\nMessage M1 in Kit\nhello") == .text("Message M1 in Kit\nhello"))
}

/// Every kind of check the server makes: his inbox, and the new matter's check again on its matter's page.
private func everyKindOfCheck() throws -> [Check] {
    try decoded(Inbox.self, wireText("life/read_inbox.json")).checks
        + decoded(Matter.self, wireText("life/read_matter_found.json")).checks
        + decoded(Matter.self, wireText("life/read_matter.json")).checks.filter { $0.group == .ending }
}

/// Every kind Life sends answers with its own options, as `answer_check` takes them: one tap for an option that takes
/// nothing more, the person or the name for one that names someone, his words for one that takes a note, and his own
/// words only where an agent reads them (a decision). Read from the server's own inbox, never a hand-made one.
@Test func everyKindOfCardAnswersAsLifeTakesIt() throws {
    let all = try everyKindOfCheck()
    func card(_ group: CheckGroup) throws -> Check { try #require(all.first { $0.group == group }) }
    #expect(Set(all.map(\.group)) == Set(CheckGroup.allCases).subtracting([.unknown, .fix])  // no `fix` card in the fixtures yet)

    let decision = try card(.decision)
    #expect(decision.answer(decision.options[0]) == AnswerRequest(ref: decision.ref, options: ["yes"]))
    #expect(decision.answer(words: "Later") == AnswerRequest(ref: decision.ref, options: [], note: "Later"))
    #expect(decision.takesOwnWords && decision.namingOption == nil)

    let ending = try card(.ending)
    #expect(ending.options.compactMap(ending.answer).map(\.options) == [["outdated"], ["false"]])
    #expect(ending.answer(words: "x") == nil && !ending.takesOwnWords)

    let same = try card(.samePerson)
    #expect(same.options.compactMap(same.answer).map(\.options) == [["same-person"], ["not-this-person"]])
    #expect(same.options.compactMap(same.answer).allSatisfy { $0.ref == same.ref })

    let found = try card(.newMatter)
    let edit = try #require(found.options.first { $0.id == "edit-goal" })
    #expect(found.answer(edit) == nil)
    #expect(found.answer(words: "Framed") == AnswerRequest(ref: found.ref, options: ["edit-goal"], note: "Framed"))
    #expect(found.answer(found.options[0]) == AnswerRequest(ref: found.ref, options: ["start"], note: found.goal))

    // Mark as done is his word that the step is done; Hand over hands over the goal shown, as Start does.
    let move = try card(.yourMove)
    #expect(move.options.map(\.id) == ["done", "start", "not-now", "drop"] && move.filled?.id == "done")
    #expect(move.isEnding(try #require(move.answer(move.options[0]))))
    #expect(move.answer(move.options[1]) == AnswerRequest(ref: move.ref, options: ["start"], note: move.goal))
    #expect(move.isHandOver(move.options[1]) && !move.isHandOver(move.options[2]))
    #expect(move.answer(move.options[2]) == AnswerRequest(ref: move.ref, options: ["not-now"]) && !move.takesOwnWords)
    #expect(move.answer(move.options[3]) == AnswerRequest(ref: move.ref, options: ["drop"]))
    // A hand-over hands the goal only the card shows: never a notification's button.
    for check in [move, found] {
        #expect(!CardNotification.actions(check).map(\.identifier).contains("option:start"))
    }

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
    // "TV or video" and "Don't name" answer on their own.
    #expect(voice.options.dropFirst().compactMap(voice.answer).count == 2)

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
    // Its "Open in" opens the session the server names (`session`), not a link it was asked with.
    #expect(unnamed.session == "https://agents.example.test/s/1")
    let lifes = try #require(inbox.checks.first { $0.agentName(runtime: nil) == nil })
    #expect(lifes.askingRuntime(among: agents) == nil)
}

/// A whole inbox made from the server's own read: one ask per ref (its push `push-<ref>`), with the urgency given.
private func asks(
    _ urgencies: [(String, Urgency)], groups: [String: String] = [:], preTicked: [String: String] = [:]
) throws -> Inbox {
    let wire = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    let first = try #require((wire["checks"] as? [[String: Any]])?.first)
    let checks = urgencies.map { ref, urgency in
        first.merging([
            "ref": ref, "pushId": "push-\(ref)", "urgency": urgency.rawValue,
            "group": groups[ref] ?? first["group"] ?? "",
            "preTicked": preTicked[ref] ?? NSNull(),
        ]) { $1 }
    }
    let body = wire.merging(["checks": checks, "total": checks.count]) { $1 }
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

/// A kind with 2 or more pre-ticked asks folds into its first, which holds every ask of the kind (pre-ticked or not),
/// unless he goes one by one; a lone pre-ticked ask stays a card. A ref folded away opens its bulk ask.
@Test func aKindLifePreTicksFoldsIntoOneBulkAsk() throws {
    let order = try asks(
        [("b1", .blocks), ("e1", .blocks), ("e2", .blocks), ("e3", .improves)],
        groups: ["e1": "ending", "e2": "ending", "e3": "ending"],
        preTicked: ["e1": "outdated", "e3": "outdated"]
    ).ordered(deferred: [])
    let folded = order.folded()
    #expect(folded.checks.map(\.ref) == ["b1", "e1"] && folded.canWaitFrom == nil)
    #expect(folded.bulk.mapValues { $0.map(\.ref) } == ["e1": ["e1", "e2", "e3"]])
    #expect(folded.check(on: "e3")?.ref == "e1")
    #expect(order.folded(except: [.ending]) == order)
    let groups = Check.bulkGroups(try #require(folded.bulk["e1"])).map { $0.map(\.ref) }
    #expect(groups == [["e2"], ["e1", "e3"]])
}

/// The voices to name are one way into the run, even one alone and with nothing guessed or pre-ticked: never a bulk list.
@Test func theVoicesToNameFoldIntoOneRunEntry() throws {
    let order = try asks(
        [("b1", .blocks), ("v1", .blocks), ("v2", .blocks)], groups: ["v1": "voice", "v2": "voice"]
    ).ordered(deferred: [])
    #expect(order.folded().bulk.mapValues { $0.map(\.ref) } == ["v1": ["v1", "v2"]])
    let one = try asks([("v1", .blocks)], groups: ["v1": "voice"], preTicked: ["v1": "not-relevant"]).ordered(
        deferred: [])
    #expect(one.folded().bulk.keys.contains("v1"))
}

/// A same person ask folds with the guessed people's (one screen of Yes or No rows); a kind he is answering row by row
/// stays one card down to its last row.
@Test func guessedPeopleAndSamePersonAsksShareOneBulkAsk() throws {
    let order = try asks(
        [("g1", .improves), ("s1", .improves), ("g2", .improves)],
        groups: ["g1": "guessed person", "s1": "same person", "g2": "guessed person"],
        preTicked: ["g1": "this-is", "s1": "same-person", "g2": "this-is"]
    ).ordered(deferred: [])
    #expect(order.folded().bulk.mapValues { $0.map(\.ref) } == ["g1": ["g1", "s1", "g2"]])
    let one = try asks([("g1", .improves)], groups: ["g1": "guessed person"], preTicked: ["g1": "this-is"])
        .ordered(deferred: [])
    #expect(one.folded().bulk.isEmpty)
    #expect(one.folded(working: [.guessedPerson: one.checks[0]]).bulk.keys.contains("g1"))
    // Same person has no filter chip of its own: it is the guessed people's.
    #expect(order.kinds == [.guessedPerson] && order.only(.guessedPerson).checks.count == 3)
}

/// His "Same person" on the guesses' card (22 Nov): the row he answered was the card's first, and the fold took a
/// guess's own row with it. The card keeps its page (no leave and come back under a new ref), and the row the fold took
/// leaves instead of offering answers Life would refuse.
@Test func theGuessesCardKeepsItsPageWhenItsFirstRowIsAnswered() throws {
    let before = try asks(
        [("b1", .blocks), ("s1", .improves), ("g1", .improves), ("g2", .improves)],
        groups: ["s1": "same person", "g1": "guessed person", "g2": "guessed person"],
        preTicked: ["s1": "same-person", "g1": "this-is", "g2": "this-is"]
    ).ordered(deferred: [])
    let head = before.checks[1]
    #expect(before.folded().bulk.keys.sorted() == ["s1"])
    // After the fold: s1 answered, g1 folded away with it.
    let after = try asks(
        [("b1", .blocks), ("g2", .improves)], groups: ["g2": "guessed person"], preTicked: ["g2": "this-is"]
    ).ordered(deferred: [])
    let folded = after.folded(working: [.guessedPerson: head])
    #expect(folded.checks.map(\.ref) == ["b1", "s1"])
    #expect(folded.bulk.mapValues { $0.map(\.ref) } == ["s1": ["g2"]])
    #expect(folded.check(on: "s1")?.ref == "s1")
    let rows = [Check].guessRows(
        met: before.checks.dropFirst().map(\.self), open: try #require(folded.bulk["s1"]), answered: ["s1"])
    #expect(rows.map(\.ref) == ["s1", "g2"])
}

/// A row he answered is answered as soon as Life confirms it, never back at Yes or No while the read that drops it is
/// on its way (22 Nov: "Saving…", then Yes and No again, then "Yes").
@Test func aGuessRowIsAnsweredOnLifesWordNotOnTheNextRead() {
    let running = ActionState<ActionProof>.running(steps: [], limit: nil)
    #expect(running.guessState(words: "Yes", isOpen: true) == .sending(yes: true))
    let done = ActionState<ActionProof>.succeeded(.recorded, steps: [])
    #expect(done.guessState(words: "Yes", isOpen: true) == .answered(yes: true))
    let refused = ActionState<ActionProof>.failed(ActionFailure(reason: "No", retry: .allowed), steps: [])
    #expect(refused.guessState(words: "No", isOpen: true) == .rest)
    #expect(ActionState<ActionProof>.idle.guessState(words: "No", isOpen: false) == .answered(yes: false))
    #expect(ActionState<ActionProof>.idle.guessState(words: nil, isOpen: true) == .rest)
}

/// His answer leaves him on the first ask after it that is still there, passing over one his answer took away too.
@Test func anAnswerLeadsToTheFirstAskStillThere() throws {
    let order = try asks([("b1", .blocks), ("b3", .blocks)]).ordered(deferred: [])
    #expect(order.next(of: ["b2", "b3"]) == "b3")
    #expect(order.next(of: ["gone"]) == nil)
}

/// His Mark as done moved him to the next ask, then the inbox read came back reordered (22 Nov: "an automatic swipe
/// back"). A read in the background keeps him on his ask whatever came or moved around it; only his ask gone moves him,
/// to the next still there, never back to the first.
@Test func aReadInTheBackgroundKeepsHimOnHisAsk() throws {
    let was = ["b1", "b2", "b3", "b4"]
    let reordered = try asks([("b0", .blocks), ("b3", .blocks), ("b1", .blocks), ("b2", .blocks)]).ordered(deferred: [])
    #expect(reordered.staying(on: "b2", was: was) == "b2")
    let gone = try asks([("b1", .blocks), ("b4", .blocks)]).ordered(deferred: [])
    #expect(gone.staying(on: "b2", was: was) == "b4")
    #expect(gone.staying(on: "b3", was: ["b1", "b3"]) == "b1")
    #expect(try asks([]).ordered(deferred: []).staying(on: "b2", was: was) == nil)
}

/// A group's heading on the bulk card follows the answer Life pre-ticks on it.
@Test func theBulkCardHeadsEachGroupByItsPreTickedAnswer() {
    #expect(CheckGroup.ending.bulkHeading(nil) == "Needs you")
    #expect(CheckGroup.ending.bulkHeading("outdated") == "Look done" && CheckGroup.ending.bulkHeading("x") == nil)
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

/// "Wrong…" is on Life's own cards only (it opens Ask Life on the card).
@Test func wrongIsOnLifesOwnCardsOnly() throws {
    let checks = try decoded(Inbox.self, wireText("life/read_inbox.json")).checks
    #expect(checks.allSatisfy { ($0.misread != nil) == ($0.asker == "life") })
}

/// A card the caretaker is fixing says so, with the caretaker's open question and its context when it has one.
@Test func aCardBeingFixedDecodes() throws {
    let plain = try decoded(
        Check.BeingFixed.self, #"{"ask":"ask_1","since":"2026-11-20T09:00:00.000Z","line":null,"context":null}"#)
    #expect(plain.ask == "ask_1" && plain.line == nil && plain.context == nil && plain.since != nil)
    let asked = try decoded(
        Check.BeingFixed.self,
        #"{"ask":"ask_1","since":"2026-11-20T09:00:00.000Z","line":"Is this Ana?","context":"See [her](life:unit_1)."}"#
    )
    #expect(asked.line == "Is this Ana?" && asked.context == "See [her](life:unit_1).")
}

/// The caretaker's context he opened is copied at his tap: a refresh that drops it never empties the open sheet.
@Test func anOpenedCaretakerContextOutlivesARefresh() throws {
    let inbox = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    func card(context: Any) throws -> Check {
        var (read, checks) = (inbox, try #require(inbox["checks"] as? [[String: Any]]))
        checks[2]["beingFixed"] = ["ask": "ask_1", "line": "Is this Ana?", "context": context]
        read["checks"] = checks
        let text = String(decoding: try JSONSerialization.data(withJSONObject: read), as: UTF8.self)
        return try decoded(Inbox.self, text).checks[2]
    }
    let opened = try #require(try card(context: "See [her](life:unit_1).").fixContext)
    let refreshed = try card(context: NSNull())
    #expect(refreshed.fixContext == nil)
    #expect(opened.title == "Is this Ana?" && opened.markdown == "See [her](life:unit_1).")
    #expect(opened.lifeLinks.isEmpty && opened.session == nil)
}

/// A matter's icon, down the chain: his pick, Life's, the first area's icon, the folder. Only a key this app knows is
/// drawn, chosen in the grid and attributed; his own pick is what Undo puts back, known or not.

/// Undo's earlier pick after a write whose read failed: Life's `key` on the row, he picks `sign`, the write goes and
/// the matter read fails, so the row still says `key`; his next pick's Undo must put back `sign`, never Life's pick.
/// A read loaded after the write is the row's word again.

/// His answer is confirmed while a read asked before it is still on its way: that read, landing after, still lists the
/// card, and the card stays out. A read asked after the answer wins, even one that lists it (Life kept it open).

/// After a restart, a matter read kept from before an answer can still be opened offline: the answer is kept until
/// every kept read was asked after it, and only then forgotten (at launch, when no read is under way).

/// The answers a phone kept before an upgrade still leave their cards out after it: the kept shape is only the times.

/// Only a new matter's `edit-goal` keeps its card open; another kind's option of that id closes it.
@Test func onlyANewMattersGoalEditKeepsItsCardOpen() throws {
    let all = try everyKindOfCheck()
    let newMatter = try #require(all.first { $0.group == .newMatter })
    let decision = try #require(all.first { $0.group == .decision })
    #expect(newMatter.keepsOpen(after: AnswerRequest(ref: newMatter.ref, options: ["edit-goal"], note: "A goal")))
    #expect(!decision.keepsOpen(after: AnswerRequest(ref: decision.ref, options: ["edit-goal"])))
    #expect(!newMatter.keepsOpen(after: AnswerRequest(ref: newMatter.ref, options: ["start"])))
}


/// A tapped push shows its card from the first frame: the cached inbox's, else the notification's, first in what is in
/// hand. Only a read asked after the tap says whether it is still open.

/// A pushed card past the read's limit, answered: the read after the answer, cut off before it, never puts it back.
/// Held for Undo it is out too, and back once undone; an answer that keeps the card open is never confirmed, so stays.

/// A notification's card counts only for its own push, read from the Life the phone is paired with now.
@Test func aKeptCardCountsOnlyUnderThePairingItWasReadFrom() throws {
    let check = try asks([("n1", .blocks)]).checks[0]
    let wire = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    let first = try #require((wire["checks"] as? [[String: Any]])?.first)
    let kept = String(
        decoding: try JSONSerialization.data(withJSONObject: first.merging(["ref": "n1", "pushId": "push-n1"]) { $1 }),
        as: UTF8.self)
    let a = URL(string: "https://life-a.example.test")!
    let b = URL(string: "https://life-b.example.test")!
    // Delivered under A, opened under A: the card.
    #expect(CardNotification.check(kept, pushId: "push-n1", life: a.absoluteString, pairedWith: a)?.ref == check.ref)
    // Delivered under A, opened under B: nothing; the read under B opens it.
    #expect(CardNotification.check(kept, pushId: "push-n1", life: a.absoluteString, pairedWith: b) == nil)
    // An older notification that names no Life, or another push's card: nothing.
    #expect(CardNotification.check(kept, pushId: "push-n1", life: nil, pairedWith: a) == nil)
    #expect(CardNotification.check(kept, pushId: "push-x", life: a.absoluteString, pairedWith: a) == nil)
}

/// Every answer from a notification goes through one door (`CardNotification.card`): a card kept under A, answered from
/// its button after the phone paired with B, is B's only if B's own read of its pushId holds it, and B's pushIds are not
/// A's; a notification older than the binding is read by its pushId, past any whole read's limit.
@Test func aNotificationsCardIsOnlyTheOneTheLifePairedNowHolds() async throws {
    let wire = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_inbox.json").utf8)) as? [String: Any])
    let first = try #require((wire["checks"] as? [[String: Any]])?.first)
    let card = first.merging(["ref": "name:alex", "pushId": "push-a"]) { $1 }
    let kept = String(decoding: try JSONSerialization.data(withJSONObject: card), as: UTF8.self)
    func inbox(_ checks: [[String: Any]], total: Int) throws -> String {
        let body = wire.merging(["checks": checks, "total": total]) { $1 }
        return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
    }
    let a = URL(string: "https://life-a.example.test")!
    let b = URL(string: "https://life-b.example.test")!
    // Kept under A, its button tapped under B: B's read holds its own card of that ref, under B's pushId, never A's.
    let bHolds = try inbox([first.merging(["ref": "name:alex", "pushId": "push-b"]) { $1 }], total: 1)
    let crossed = await CardNotification.card(
        pushId: "push-a", kept: kept, life: a.absoluteString, pairedWith: b
    ) { _ in bHolds }
    #expect(crossed == nil)
    // Kept under A, answered under A: the kept card, with no read.
    let bound = await CardNotification.card(pushId: "push-a", kept: kept, life: a.absoluteString, pairedWith: a) { _ in
        Issue.record("a bound card needs no read")
        return ""
    }
    #expect(bound?.ref == "name:alex")
    // A notification from before the binding, its card the 600th open: Life's read of its pushId holds it.
    let legacyRead = try inbox([card], total: 600)
    let legacy = await CardNotification.card(pushId: "push-a", kept: kept, life: nil, pairedWith: a) { _ in legacyRead }
    #expect(legacy?.ref == "name:alex")
    // Not paired: nothing, and nothing read.
    let unpaired = await CardNotification.card(pushId: "push-a", kept: kept, life: nil, pairedWith: nil) { _ in
        Issue.record("no read without a pairing")
        return ""
    }
    #expect(unpaired == nil)
}

/// Asked `ifNot` its version, Life's "nothing changed" keeps the read held; any other answer is a new read, and an
/// inbox changed on the phone is no longer Life's version.

/// "Someone else…" on a voice offers everyone he knows, not only the card's guesses again (his report, 22 Nov): the
/// guesses first, then the People list, never him, no organization; a name with a slash is answered as typed.
@Test func someoneElseOffersEveryoneHeKnows() throws {
    let voice = try JSONDecoder().decode(
        Check.self,
        from: Data(
            #"{"ref":"voice:v1","group":"voice","title":"t","question":"Who is this?","asker":"Life","options":[{"id":"is-them","label":"Yes"},{"id":"this-is","label":"Someone else…","takes":"person or name"}],"clips":[],"likelyPeople":[{"ref":"person:test-ana","name":"Test Ana","kind":"person"}],"links":[]}"#
                .utf8))
    let everyone = try JSONDecoder().decode(
        [Party].self,
        from: Data(
            #"[{"ref":"person:me","name":"Me","kind":"person"},{"ref":"person:test-ana","name":"Test Ana","kind":"person"},{"ref":"person:test-bo","name":"Test Bo","kind":"person"},{"ref":"person:test-co","name":"Test Co","kind":"organization"}]"#
                .utf8))
    #expect(voice.peopleToPick(among: everyone).map(\.ref) == ["person:test-ana", "person:test-bo"])
    #expect(
        voice.answer(naming: .name("Zed/Zeda"))
            == AnswerRequest(ref: "voice:v1", options: ["this-is"], name: "Zed/Zeda"))
}

/// The voice run's answers (his direction of 22 Nov): "Me" is his own person through the naming option, "TV or video" is
/// `media`, and the guesses never hold him and put the people named in the run first.
@Test func theVoiceRunAnswersMeMediaAndNamedPeopleFirst() throws {
    let voice = try JSONDecoder().decode(
        Check.self,
        from: Data(
            #"{"ref":"voice:v1","group":"voice","title":"t","question":"Who is this?","asker":"Life","options":[{"id":"is-them","label":"Yes"},{"id":"this-is","label":"Someone else…","takes":"person or name"},{"id":"not-relevant","label":"Don't name"}],"clips":[],"likelyPeople":[{"ref":"person:me","name":"Me","kind":"person"},{"ref":"person:test-ana","name":"Test Ana","kind":"person"}],"links":[]}"#
                .utf8))
    #expect(voice.answerMe == AnswerRequest(ref: "voice:v1", options: ["this-is"], person: "person:me"))
    #expect(voice.answerMedia == AnswerRequest(ref: "voice:v1", options: ["media"]))
    let bo = Party(ref: "person:test-bo", name: "Test Bo", kind: .person, line: nil, picture: nil)
    #expect(voice.voiceGuesses(recent: [bo]).map(\.ref) == ["person:test-bo", "person:test-ana"])
}
