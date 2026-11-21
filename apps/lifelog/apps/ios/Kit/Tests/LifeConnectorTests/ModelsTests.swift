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
        let list = try reply(MatterList.self, DesignReplies.matters(rows))
        #expect(list.matters.count == rows.count)
        // Life's picks, and none (the area's icon): every key one this build draws.
        #expect(list.matters.contains { $0.icon == nil })
        #expect(list.matters.compactMap(\.icon).allSatisfy { $0.by == .life && MatterIcons.symbol($0.key) != nil })
        let agents = try object("read_registered_agents")
        #expect(try !decoded(RegisteredAgents.self, designText("read_registered_agents")).agents.isEmpty)
        #expect(try decoded(ModelSpending.self, designText("read_spending")).sections.count == 5)
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
    #expect(inbox.total == 12)
    #expect(inbox.blocking == 6)
    #expect(inbox.badge == 6)
    #expect(inbox.counts.values.reduce(0, +) == 12)
    #expect(
        inbox.checks.map(\.urgency) == [
            .blocks, .blocks, .blocks, .blocks, .blocks, .blocks, .improves, .improves, .improves, .improves, .improves,
            .improves,
        ])
    let decision = try #require(inbox.checks.first)
    #expect(decision.group == .decision)
    #expect(decision.options.first?.outgoing == true)
    #expect(decision.matter?.name == "Mend Gran's watch")
    #expect(decision.draft?.file?.name == "quote.pdf")
    #expect(decision.draft?.quoted?.sender == "Kit")
    // The chat strip (decision 82): its head, and the chat's last messages as Life stamped them, oldest first.
    #expect(decision.head == Check.Head(network: "WhatsApp", name: "Kit"))
    // The plan card: the second decision is its assignment's first card; the first is not.
    #expect(inbox.checks.prefix(2).map(\.isPlan) == [false, true])
    #expect(inbox.checks.last?.isPlan == nil)
    // A plan with its steps: who does each, when, where, and what it rests on; an older plan card has none.
    let plan = try #require(inbox.checks.first { $0.ref == "dec_000000000003" })
    #expect(plan.planSteps.map(\.by) == [.agent, .owner, .agent])
    #expect(plan.planSteps.map(\.channel) == ["whatsapp", "payment", nil])
    #expect(plan.planSteps.last?.when == "once Kit answers, by Thu")
    #expect(plan.planSteps.last?.spoken == "The agent: \(plan.planSteps.last!.text), once Kit answers, by Thu")
    #expect(plan.planSteps[1].spoken == "You: \(plan.planSteps[1].text), payment")
    #expect(plan.gathered?.text == "From Kit's quote and two others")
    #expect(inbox.checks.first { $0.ref == "dec_000000000002" }?.planSteps.isEmpty == true)
    #expect(plan.optionsInOrder.map(\.role) == [.start, .decline] && plan.filled?.label == "Start the plan")
    #expect(decision.draft?.recent?.map(\.file?.kind) == [.photo, nil])
    #expect(decision.draft?.recent?.last?.text == "Can you send the quote?")
    #expect(decision.draft?.recent?.contains { $0.sender.isOwner } == false)
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
    #expect(decision.networkIdentity?.party?.ref == "person:inf_kit")
    #expect(inbox.parties.contains { $0.ref == "person:inf_kit" })
    #expect(decision.ridesOn?.matters == 1)
    // A transfer (the asks contract): its needs in the agent's order, each with Life's line; Life's look found nothing yet.
    let transfer = inbox.checks[1]
    #expect(transfer.needs?.map(\.kind) == [.account, .amount, .link, .text, .qr])
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
    #expect(list.parties.contains { $0.ref == "person:gran" })
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

    let chips = try decoded(ProjectChips.self, wireText("life/read_projects.json"))
    #expect(chips.all.needYou == 2)
    #expect(chips.chips.map(\.kind) == [.project])
    #expect(chips.chips.first?.status == .active)
    #expect(chips.chips.first?.area == "home")
    #expect(chips.chips.first?.agentAtWork == true)
    #expect(chips.underway == 1)
    // An area and a project can share an id: the chips' identity tells them apart.
    let sameText =
        #"{"all":{"needYou":0,"open":0},"chips":[{"kind":"area","id":"home","name":"Home","#
        + #""needYou":0,"agentAtWork":false,"matters":0},{"kind":"project","id":"home","#
        + #""name":"Home","needYou":0,"agentAtWork":false,"matters":0}],"version":"v"}"#
    let same = try decoded(ProjectChips.self, sameText)
    #expect(Set(same.chips.map(\.identity)).count == 2)
    let header = try decoded(ProjectHeader.self, wireText("life/read_project.json"))
    #expect(header.project.goal?.rank == 1)
    #expect(header.project.ask?.ref.hasPrefix("dec_") == true)
    #expect(header.project.ask?.matter?.name == "Mend Gran's watch")
    #expect(header.project.agents.map(\.status) == ["running"])
    #expect(header.project.repos.map(\.folder) == ["/Users/owner/Work/shop-site", nil])
    #expect(header.parties.map(\.name) == ["Robin"])

    let said = "The shop is quoting the watch repair; the call to them is done."
    #expect(header.project.situation.map(\.text) == [said])
    #expect(header.project.situation.first?.cites == ["obs_000000000005"])
    // A project chip's list is `read_matters` of the project; its head, if Life sends one, is not read.
    let project = try decoded(MatterList.self, wireText("life/read_matters_project.json"))
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

/// A plan's start is its filled answer whatever order its asker sent; a card with no roles keeps its order; its steps
/// draw even while `isPlan` is false (Life couldn't read its desk).
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
    #expect(held.tellTitle == "Tell the agent…")
    let lifes = try #require(inbox.checks.first { $0.isLifesOwn })
    #expect(lifes.hearer(among: agents) == "Life")
    #expect(lifes.tellTitle == "Tell Life…")
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

@Test func aNextStepCarriesItsContextAndAnEditSendsOnlyWhatItHas() throws {
    let text =
        #"{"matters":[{"id":"m","name":"M","status":"moving","nextStep":{"kind":"do","text":"t","context":"See [it](life:obs_1)"}}]}"#
    #expect(try decoded(MatterList.self, text).matters.first?.nextStep?.context == "See [it](life:obs_1)")
    let sent = { (step: NextStepRequest) in String(decoding: try JSONEncoder().encode(step), as: UTF8.self) }
    #expect(try sent(NextStepRequest(kind: "do", text: "t")).contains("context") == false)
    #expect(try sent(NextStepRequest(kind: "do", text: "t", context: "c")).contains(#""context":"c""#))
}

@Test func theListSearchesOnThePhone() throws {
    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matching("watch").map(\.name) == ["Mend Gran's watch"])
    #expect(list.matching("QUOTE").count == 1)
    #expect(list.matching("  ").count == 3)
    #expect(list.matching("nothing like it").isEmpty)
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

    let same = try card(.samePerson)
    #expect(same.options.compactMap(same.answer).map(\.options) == [["same-person"], ["not-this-person"]])
    #expect(same.options.compactMap(same.answer).allSatisfy { $0.ref == same.ref })

    let found = try card(.newMatter)
    let edit = try #require(found.options.first { $0.id == "edit-goal" })
    #expect(found.answer(edit) == nil)
    #expect(found.answer(words: "Framed") == AnswerRequest(ref: found.ref, options: ["edit-goal"], note: "Framed"))
    #expect(found.answer(found.options[0]) == AnswerRequest(ref: found.ref, options: ["start"], note: found.goal))

    // Mark as done is his word that the step is done; Hand to an agent hands over the goal shown, as Start does.
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
        [("b1", .blocks), ("v1", .blocks), ("v2", .blocks), ("e1", .improves), ("v3", .improves)],
        groups: ["v1": "voice", "v2": "voice", "v3": "voice", "e1": "ending"],
        preTicked: ["v1": "not-relevant", "v3": "is-them", "e1": "outdated"]
    ).ordered(deferred: [])
    let folded = order.folded()
    #expect(folded.checks.map(\.ref) == ["b1", "v1", "e1"] && folded.canWaitFrom == 2)
    #expect(folded.bulk.mapValues { $0.map(\.ref) } == ["v1": ["v1", "v2", "v3"]])
    #expect(folded.check(on: "v3")?.ref == "v1" && folded.checks.ref(after: "v1") == "e1")
    #expect(order.folded(except: [.voice]) == order)
    let groups = Check.bulkGroups(try #require(folded.bulk["v1"])).map { $0.map(\.ref) }
    #expect(groups == [["v1"], ["v3"], ["v2"]])
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
    #expect(one.folded(working: [.guessedPerson]).bulk.keys.contains("g1"))
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

/// "Wrong…" is on Life's own cards only, and his press sends the card's seal back exactly as `Misread`
/// (`host/complaints.ts`) takes it: his words as `note`, no option.
@Test func lifesOwnCardsCarryTheirSealAndAComplaintSendsItBack() throws {
    let checks = try decoded(Inbox.self, wireText("life/read_inbox.json")).checks
    #expect(checks.allSatisfy { ($0.misread != nil) == ($0.asker == "life") })
    let voice = try #require(checks.first { $0.group == .voice })
    #expect(voice.complaint(words: "  ", report: true) == nil)
    #expect(voice.complaint(words: String(repeating: "a", count: 4_001), report: true) == nil)
    let request = try #require(voice.complaint(words: " Not her. ", report: true))
    let sent = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
    #expect(sent["ref"] as? String == voice.ref)
    #expect((sent["options"] as? [String])?.isEmpty == true)
    #expect(sent["note"] as? String == "Not her.")
    let value = try #require(sent["value"] as? [String: Any])
    #expect(Set(value.keys) == ["kind", "cause", "shown", "seal", "report"])
    #expect(value["kind"] as? String == "misread" && value["report"] as? Bool == true)
    let misread = try #require(voice.misread)
    #expect(
        [value["cause"], value["shown"], value["seal"]].map { $0 as? String }
            == [misread.cause, misread.shown, misread.seal])
    let decision = try #require(checks.first { $0.group == .decision })
    #expect(decision.complaint(words: "Wrong", report: false) == nil)
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
@Test func aMattersIconFallsFromHisPickToTheFolder() throws {
    func row(icon: [String: String]?, areas: [String]? = ["Home"]) throws -> MatterRow {
        var object: [String: Any] = ["id": "matter_x", "name": "Renew the lease", "status": "moving"]
        (object["icon"], object["areas"]) = (icon, areas)
        return try decoded(
            MatterRow.self, String(decoding: JSONSerialization.data(withJSONObject: object), as: UTF8.self))
    }
    let owner = try row(icon: ["by": "owner", "key": "sign"])
    #expect((owner.symbol, owner.knownIcon?.by, owner.ownerIconKey) == ("signature", .owner, "sign"))
    let life = try row(icon: ["by": "life", "key": "key"])
    #expect((life.symbol, life.knownIcon?.by, life.ownerIconKey) == ("key", .life, nil))
    // None: the area's icon, unattributed; an area with no icon of its own, or none, gets the folder.
    let none = try row(icon: nil)
    #expect((none.symbol, none.knownIcon, none.ownerIconKey) == ("house", nil, nil))
    #expect(try row(icon: nil, areas: ["Garden"]).symbol == "folder")
    #expect(try row(icon: nil, areas: nil).symbol == "folder")
    // A key Life added since this build: drawn as none, yet his pick of it is still what Undo restores.
    let newer = try row(icon: ["by": "owner", "key": "a_new_key"], areas: ["Money"])
    #expect((newer.symbol, newer.knownIcon, newer.ownerIconKey) == ("banknote", nil, "a_new_key"))
}

/// Undo's earlier pick after a write whose read failed: Life's `key` on the row, he picks `sign`, the write goes and
/// the matter read fails, so the row still says `key`; his next pick's Undo must put back `sign`, never Life's pick.
/// A read loaded after the write is the row's word again.
@Test func undoPutsBackThePickLastWrittenUntilAReadShowsIt() throws {
    func row(_ by: String, _ key: String) throws -> MatterRow {
        let icon = #"{"by": "\#(by)", "key": "\#(key)"}"#
        let text = #"{"id": "matter_x", "name": "Renew the lease", "status": "moving", "icon": \#(icon)}"#
        return try decoded(MatterRow.self, text)
    }
    let read = Date(timeIntervalSince1970: 0)
    let (wrote, readAgain) = (read.addingTimeInterval(10), read.addingTimeInterval(20))
    var written = WrittenIcons()
    let lifes = try row("life", "key")
    #expect(written.earlierPick(of: lifes, loadedAt: read) == nil)
    written.wrote("sign", on: "matter_x", at: wrote)
    #expect(written.earlierPick(of: lifes, loadedAt: read) == "sign")
    #expect(written.earlierPick(of: lifes, loadedAt: nil) == "sign")
    // “Let Life pick” written, the row still his: Undo gives it back to Life.
    written.wrote(nil, on: "matter_x", at: wrote)
    #expect(written.earlierPick(of: try row("owner", "sign"), loadedAt: read) == nil)
    // A read after the write: the row says what Life holds now.
    #expect(written.earlierPick(of: try row("owner", "hammer"), loadedAt: readAgain) == "hammer")
}

/// His answer is confirmed while a read asked before it is still on its way: that read, landing after, still lists the
/// card, and the card stays out. A read asked after the answer wins, even one that lists it (Life kept it open).
@Test func anAnswerConfirmedAfterAReadWasAskedStaysOutOfIt() throws {
    let asked = Date(timeIntervalSince1970: 100)
    var answered = AnsweredCards()
    answered.answered("b1", at: asked.addingTimeInterval(1))
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
    answered.answered("a", at: at(10))
    cache.store("{}", key: "read_matter-m1", asked: at(5))
    cache.store("{}", key: "read_inbox", asked: at(20))
    cache.store("{}", key: "answered_cards", asked: at(30))
    // He answers B after a restart: A stays, the matter read kept from before it can still show A.
    answered.forget(confirmedBy: cache.oldest(except: "answered_cards"))
    answered.answered("b", at: at(40))
    #expect(answered.newer(than: at(5)) == ["a", "b"])
    // Once every kept read was asked after both, they go; with none kept, all go.
    cache.store("{}", key: "read_matter-m1", asked: at(50))
    cache.store("{}", key: "read_inbox", asked: at(50))
    answered.forget(confirmedBy: cache.oldest(except: "answered_cards"))
    #expect(answered.newer(than: nil).isEmpty)
    answered.answered("c", at: at(60))
    cache.clear()
    answered.forget(confirmedBy: cache.oldest(except: "answered_cards"))
    #expect(answered.newer(than: nil).isEmpty)
}

/// The answers a phone kept before an upgrade still leave their cards out after it: the kept shape is only the times.
@Test func answersKeptBeforeAnUpgradeStillDecode() throws {
    let kept = #"{"confirmed":{"c1":100}}"#
    let answered = try JSONDecoder().decode(AnsweredCards.self, from: Data(kept.utf8))
    #expect(answered.newer(than: Date(timeIntervalSinceReferenceDate: 50)) == ["c1"])
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

/// A tapped push shows its card from the first frame: the cached inbox's, else the notification's, first in what is in
/// hand. Only a read asked after the tap says whether it is still open.
@Test func aPushedCardIsShownFromWhatIsInHandUntilAReadAskedAfterTheTap() throws {
    let tapped = Date(timeIntervalSince1970: 100)
    let cached = try asks([("b1", .blocks), ("i1", .improves)])
    let notified = try asks([("n1", .blocks)]).checks[0]
    // In the cache: opened from there, the inbox as cached.
    let inCache = PushedCard(pushId: "push-i1", in: cached, notified: notified, at: tapped)
    #expect(inCache.opening?.check?.ref == "i1" && inCache.shown(in: cached, answeredSinceTap: []) == cached)
    // Not in the cache: the notification's card, first, counted.
    let fresh = PushedCard(pushId: "push-n1", in: cached, notified: notified, at: tapped)
    let shown = try #require(fresh.shown(in: cached, answeredSinceTap: []))
    #expect(shown.checks.map(\.ref) == ["n1", "b1", "i1"] && shown.badge == cached.badge + 1)
    // Nothing read at all: a one-card inbox.
    #expect(fresh.shown(in: nil, answeredSinceTap: [])?.checks.map(\.ref) == ["n1"])
    // A read asked before the tap still checks it; one asked after opens as it says.
    #expect(fresh.checked(by: cached, askedAt: tapped.addingTimeInterval(-1)) == nil)
    #expect(fresh.checked(by: cached, askedAt: tapped.addingTimeInterval(1))?.wasAnswered == true)
    // A read cut off by its limit before the card says nothing of it: still open as far as the phone knows.
    let cut = try asks([("b1", .blocks)])
    let partial = try decoded(
        Inbox.self, #"{"checks":[],"counts":{},"total":600,"deadlinesToday":0,"blocking":1}"#)
    #expect(cut.isWhole && !partial.isWhole)
    #expect(fresh.checked(by: partial, askedAt: tapped.addingTimeInterval(1)) == nil)
    // Nothing in hand: nothing to show until the read.
    #expect(PushedCard(pushId: "push-n1", in: nil, notified: nil, at: tapped).opening == nil)
    // How many wait is the read's word alone: none before a read (the one-card inbox counts only its card), the read's
    // total when the card is past its limit (never one more), less his answers.
    var read = ReadState<Inbox>()
    #expect(fresh.shown(in: nil, answeredSinceTap: [])?.total == 1 && read.waiting(less: []) == nil)
    read.apply(.succeeded(partial, tapped))
    #expect(fresh.shown(in: partial, answeredSinceTap: [])?.total == 601 && read.waiting(less: []) == 600)
    read.apply(.succeeded(cached, tapped))
    #expect(read.waiting(less: ["i1"]) == cached.total - 1)
}

/// A pushed card past the read's limit, answered: the read after the answer, cut off before it, never puts it back.
/// Held for Undo it is out too, and back once undone; an answer that keeps the card open is never confirmed, so stays.
@Test func aConfirmedAnswerRetiresThePushedCopyEvenWhenTheReadIsCutOff() throws {
    let tapped = Date(timeIntervalSince1970: 100)
    let notified = try asks([("n1", .blocks)]).checks[0]
    let cut = try decoded(Inbox.self, #"{"checks":[],"counts":{},"total":600,"deadlinesToday":0,"blocking":1}"#)
    let push = PushedCard(pushId: "push-n1", in: cut, notified: notified, at: tapped)
    var answered = AnsweredCards()
    #expect(push.shown(in: cut, answeredSinceTap: answered.newer(than: tapped))?.checks.map(\.ref) == ["n1"])
    answered.answered("n1", at: tapped.addingTimeInterval(5))
    // The read after his answer is cut off too: it says nothing of the card, and the card stays out.
    #expect(push.checked(by: cut, askedAt: tapped.addingTimeInterval(6)) == nil)
    #expect(push.shown(in: cut, answeredSinceTap: answered.newer(than: tapped))?.checks.isEmpty == true)
    // Held for Undo (the store adds held refs): out; undone: back.
    #expect(push.shown(in: cut, answeredSinceTap: ["n1"])?.checks.isEmpty == true)
    #expect(push.shown(in: cut, answeredSinceTap: [])?.checks.map(\.ref) == ["n1"])
}

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
@Test func anUnchangedAnswerKeepsTheReadHeld() throws {
    let inbox = try decoded(Inbox.self, wireText("life/read_inbox.json"))
    let version = try #require(inbox.version)
    let unchanged = #"{"unchanged":true,"version":"\#(version)"}"#
    #expect(inbox.isUnchanged(by: unchanged))
    #expect(!inbox.isUnchanged(by: #"{"unchanged":true,"version":"other"}"#))
    #expect(!inbox.isUnchanged(by: try wireText("life/read_inbox.json")))
    #expect(!inbox.without([inbox.checks[0].ref]).isUnchanged(by: unchanged))
    #expect(try decoded(MatterList.self, wireText("life/read_matters.json")).version != nil)
}
