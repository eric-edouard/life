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
    #expect(inbox.total == 7)
    #expect(inbox.blocking == 4)
    #expect(inbox.badge == 4)
    #expect(inbox.counts.values.reduce(0, +) == 7)
    #expect(inbox.checks.map(\.urgency) == [.blocks, .blocks, .blocks, .blocks, .improves, .improves, .improves])
    let decision = try #require(inbox.checks.first)
    #expect(decision.group == .decision)
    #expect(decision.options.first?.outgoing == true)
    #expect(decision.matter?.name == "Mend Gran's watch")
    #expect(decision.draft?.file?.name == "quote.pdf")
    #expect(decision.draft?.quoted?.sender == "Kit")
    #expect(decision.deadline != nil)
    #expect(decision.confirm?.first?.group == .guessedPerson)
    #expect(decision.ridesOn?.matters == 1)

    #expect(inbox.checks.map(\.group).contains(.newMatter))
    let voice = try #require(inbox.checks.first { $0.group == .voice })
    #expect(voice.clips.first?.audio?.jobId == "job-1")
    let clip = try #require(voice.clips.first)
    #expect(clip.words?.spoken(at: 400, in: clip.text) == NSRange(location: 5, length: 3))
    #expect(voice.likelyPeople.first?.name == "Gran")
    #expect(inbox.checks.first { $0.group == .ending }?.ridesOn?.matters == 1)
    let found = try #require(
        try decoded(Matter.self, wireText("life/read_matter_found.json")).checks.first)
    #expect(found.group == .newMatter)
    #expect(found.options.map(\.id) == ["start", "edit-goal", "dismiss"])
    #expect(found.deadline == nil)
    #expect(found.options.map(\.label) == ["Start", "Edit goal", "Dismiss"])
    #expect(found.goal == "Gran's photo is framed.")
    #expect(inbox.checks.last?.draft == nil)

    let list = try decoded(MatterList.self, wireText("life/read_matters.json"))
    #expect(list.matters.map(\.id) == ["matter_aaaaaaaaaaaa", "matter_cccccccccccc", "matter_bbbbbbbbbbbb"])
    let row = list.matters[0]
    #expect(row.status == .moving)
    #expect(row.goal?.by == .life)
    #expect(row.nextStep?.kind == .waitEvent)
    #expect(row.people?.owedTo == ["gran"])
    #expect(row.agent == "agt_000000000001")
    #expect(row.blockingChecks == 1)
    #expect(list.matters[2].goal == nil)

    let matter = try decoded(Matter.self, wireText("life/read_matter.json"))
    #expect(matter.row.name == "Mend Gran's watch")
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
        {"matters":[{"id":"m","name":"New kind","status":"on_ice","something":{"new":true},
        "nextStep":{"kind":"wait_robot","text":"t"},"goal":{"by":"a_new_one","text":"g"}}]}
        """#
    let row = try #require(try decoded(MatterList.self, text).matters.first)
    #expect(row.status == .unknown)
    #expect(row.nextStep?.kind == .unknown)
    #expect(row.goal?.by == .unknown)
}

@Test func theFiltersNarrowTheListAndAreasComeMostFirst() throws {
    let text = #"""
        {"matters":[
        {"id":"a","name":"A","status":"moving","areas":["Home","Money"],"agent":"agt_1","nextStep":{"kind":"wait_decision","text":"x"}},
        {"id":"b","name":"B","status":"stuck","areas":["Home"],"nextStep":{"kind":"do","text":"y"}},
        {"id":"c","name":"C","status":"moving","areas":["Work"],"nextStep":{"kind":"do","text":"z"}},
        {"id":"d","name":"D","status":"dormant"}]}
        """#
    let list = try decoded(MatterList.self, text)
    #expect(list.areasByCount == ["Home", "Money", "Work"])
    func ids(_ filter: MatterFilter) -> [String] { list.shown(filter: filter).map(\.id) }
    #expect(ids(.everything) == ["a", "b", "c", "d"])
    #expect(ids(.area("Home")) == ["a", "b"])
    #expect(ids(.needsYou) == ["a"])
    #expect(ids(.agentWorking) == ["a"])
}

@Test func aMatterNeedsHimWhenItWaitsOnHimOrABlockingCheckIsOpen() throws {
    let text = #"""
        {"matters":[
        {"id":"a","name":"A","status":"moving","blockingChecks":1,"nextStep":{"kind":"do","text":"x"}},
        {"id":"b","name":"B","status":"moving","nextStep":{"kind":"wait_owner","text":"y"}},
        {"id":"c","name":"C","status":"moving","blockingChecks":0,"nextStep":{"kind":"do","text":"z"}}]}
        """#
    let list = try decoded(MatterList.self, text)
    // A new matter's offer or an ending check improves the memory, never blocks: it counts 0 and needs nothing of him.
    #expect(list.matters.map(\.needsYou) == [true, true, false])
    #expect(list.shown(filter: .needsYou).map(\.id) == ["a", "b"])
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
        // A name he types is someone Life knows: it goes as `person`, which Life reads.
        #expect(
            check.answer(naming: .name("Gran")) == AnswerRequest(ref: check.ref, options: [only.id], person: "Gran"))
        #expect(!check.takesOwnWords)
    }
    #expect(try card(.contactsCard).likelyPeople.map(\.person) == ["person:gran", "person:partner"])

    let guess = try card(.guessedPerson)
    #expect(guess.answer(guess.options[0]) == AnswerRequest(ref: guess.ref, options: ["this-is"]))
    #expect(guess.namingOption?.id == "same-person")

    let voice = try card(.voice)
    #expect(voice.namingOption?.id == "this-is")
    #expect(voice.answer(voice.options[0]) == nil)
    #expect(
        voice.answer(naming: .person("person:gran"))
            == AnswerRequest(ref: voice.ref, options: ["this-is"], person: "person:gran"))
    #expect(voice.answer(naming: .name("Sam")) == AnswerRequest(ref: voice.ref, options: ["this-is"], name: "Sam"))
    #expect(voice.options.dropFirst().compactMap(voice.answer).count == 3)

    // No button reads like the words a model is given.
    #expect(all.flatMap(\.options).allSatisfy { !$0.label.contains("`") && $0.label.count < 30 })
}

@Test func theAskerIsNamedOnce() throws {
    let all = try everyKindOfCheck()
    let voice = try #require(all.first { $0.group == .voice })
    #expect(voice.askerName(runtime: nil) == "Life, from the pendant")
    #expect(all[0].askerName(runtime: .claude) == "Claude Code")
    #expect(all[0].askerName(runtime: nil) == "Orbit")
    let name = try #require(all.first { $0.group == .name })
    #expect(name.askerName(runtime: nil) == "Life")
}
