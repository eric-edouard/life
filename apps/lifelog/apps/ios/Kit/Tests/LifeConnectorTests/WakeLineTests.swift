import Foundation
import Testing

import Library

@testable import LifeConnector

private func lines(_ json: String) throws -> [WakeLine] {
    try LibraryStore.feedDecoder.decode([WakeLine].self, from: Data(json.utf8))
}

private let utc = TimeZone(identifier: "UTC")!
private let english = Locale(identifier: "en_GB")

private func clause(_ json: String) throws -> WakeClause {
    guard case .clause(let clause) = try #require(try lines(json).first).row(locale: english, timeZone: utc) else {
        Issue.record("not a clause")
        throw CancellationError()
    }
    return clause
}

private func waker(_ json: String) throws -> Waker {
    guard case .waker(let waker) = try #require(try lines(json).first).row(locale: english, timeZone: utc) else {
        Issue.record("not a waker")
        throw CancellationError()
    }
    return waker
}

@Test func theWireFixturesDecodeEveryKind() throws {
    for name in ["read_registered_agents", "read_matter", "read_matter_found"] {
        let text = try wireText("life/\(name).json")
        let all = try LibraryStore.feedDecoder.decode(AnyAgents.self, from: Data(text.utf8)).agents
        #expect(all.contains { $0.wakesOn.count == 8 }, "\(name)")
    }
    let agents = try LibraryStore.feedDecoder.decode(
        RegisteredAgents.self, from: Data(wireText("life/read_registered_agents.json").utf8))
    #expect(agents.agents[0].wakesOn.isEmpty)
    #expect(agents.agents[0].statusSince != nil)
    // A person, a chat, a broken person (left out of the row line), then 5 other lines.
    #expect(agents.agents[1].rowLine(locale: english, timeZone: utc) == "Gran, Shop fit-out +5, or Fri 09:00")
}

/// `read_registered_agents` and `read_matter` both carry `agents`.
private struct AnyAgents: Decodable {
    let agents: [RegisteredAgent]
    private enum Key: String, CodingKey { case agents }
    init(from decoder: any Decoder) throws {
        agents = try decoder.container(keyedBy: Key.self).decode([RegisteredAgent].self, forKey: .agents)
    }
}

@Test func aPersonAndAChatThatCoverCallsAreWakerRows() throws {
    let person = try waker(
        #"[{"kind":"message","party":{"ref":"person:idris","name":"Idris Benali","kind":"person"},"personAsWritten":"Idris","calls":true}]"#
    )
    guard case .person(let name, let party) = person.who else { Issue.record("not a person"); return }
    #expect(name == "Idris Benali")
    #expect(party?.ref == "person:idris")
    #expect(person.apps.isEmpty)
    #expect(person.brokenReason == nil)
    let chat = try waker(
        #"[{"kind":"message","calls":true,"apps":["whatsapp"],"chat":{"name":"Halden house","app":"whatsapp","group":true}}]"#
    )
    #expect(chat.who == .chat(name: "Halden house", isGroup: true))
    #expect(chat.apps == ["whatsapp"])
}

@Test func aBrokenLineKeepsItsPlaceAndSaysWhy() throws {
    let broken = try waker(#"[{"kind":"message","personAsWritten":"Léa","calls":true,"broken":"unknown_person"}]"#)
    #expect(broken.brokenReason == "No longer in your people")
    #expect(
        try lines(#"[{"kind":"message","personAsWritten":"Léa","calls":true,"broken":"unknown_person"}]"#)[0].isBroken)
}

@Test func aBrokenMessageLineWithWordsStaysAClauseAndSaysWhy() throws {
    let broken = try clause(
        #"[{"kind":"message","personAsWritten":"Léa","words":"prix","calls":false,"broken":"unknown_person"}]"#)
    #expect(broken.text == "Léa writes “prix”")
    #expect(broken.brokenReason == "No longer in your people")
    #expect(
        try clause(#"[{"kind":"message","personAsWritten":"Léa","words":"prix","calls":false}]"#).brokenReason == nil)
}

@Test func aChatWithNoNameYetIsNotAGroup() throws {
    let chat = try waker(#"[{"kind":"message","calls":true,"chat":{"name":null,"app":"line","group":null}}]"#)
    #expect(chat.who == .chat(name: nil, isGroup: false))
    #expect(chat.apps == ["line"])
}

@Test func aMessageLineWithWordsIsAClauseNotACallRow() throws {
    let said = try clause(
        #"[{"kind":"message","party":{"ref":"person:idris","name":"Idris","kind":"person"},"personAsWritten":"Idris","words":"prix","calls":false}]"#
    )
    #expect(said.text == "Idris writes “prix”")
    #expect(said.glyph == .bubble)
    #expect(said.pieces.map(\.isFigure) == [false, false, true])
    let mail = try clause(#"[{"kind":"message","words":"devis","calls":false,"apps":["mail"]}]"#)
    #expect(mail.text == "A mail contains “devis”")
    #expect(mail.glyph == .mail)
    #expect(mail.apps.isEmpty)
    let him = try clause(
        #"[{"kind":"message","fromHim":true,"calls":false,"chat":{"name":"Carmes building","app":null,"group":true}}]"#)
    #expect(him.text == "You write in Carmes building")
    #expect(him.glyph == .person)
}

@Test func paymentsReadAsAClauseFromThePaymentsSource() throws {
    // The amount stays with its word: a non-breaking space between them.
    func words(_ json: String) throws -> String {
        try clause(json).text.replacingOccurrences(of: "\u{00A0}", with: " ")
    }
    #expect(try words(#"[{"kind":"payments","quantity":"eur_out","above":500}]"#) == "A payment is over €500")
    #expect(try words(#"[{"kind":"payments","quantity":"eur_in","above":500}]"#) == "You receive over €500")
    #expect(try words(#"[{"kind":"payments","quantity":"eur_out","below":20.5}]"#) == "A payment is under €20.50")
    #expect(
        try words(#"[{"kind":"payments","quantity":"eur_out","above":100,"below":500}]"#)
            == "A payment is between €100 and €500")
    #expect(
        try words(#"[{"kind":"payments","quantity":"eur_in","above":100,"below":500}]"#)
            == "You receive between €100 and €500")
    #expect(try words(#"[{"kind":"payments","words":"loyer"}]"#) == "A payment mentions “loyer”")
    #expect(
        try words(#"[{"kind":"payments","quantity":"eur_out","above":100,"words":"shop"}]"#)
            == "A payment is over €100 and mentions “shop”")
    let any = try clause(#"[{"kind":"payments"}]"#)
    #expect(any.text == "Any payment")
    #expect(any.source == "Payments")
}

@Test func anAnswerHasItsDeadlineUnderIt() throws {
    let answer = try clause(
        #"[{"kind":"answer","card":"Go with this plan?","check":"dec_1","deadline":"2026-11-19T18:00:00.000Z"}]"#)
    #expect(answer.text == "You answer “Go with this plan?”")
    #expect(answer.aside == "or Thu 18:00 passes")
    #expect(answer.check == "dec_1")
}

@Test func theWideNetAndAKindTheAppDoesNotKnowAreClauses() throws {
    #expect(try clause(#"[{"kind":"wide_net"}]"#).text == "Something new touches this matter")
    let places = try clause(#"[{"kind":"places","where":"Halden house"}]"#)
    #expect(places.text == "Something new in places")
    #expect(places.glyph == .ring)
    #expect(try lines(#"[{"kind":"message","calls":true,"personAsWritten":"A","broken":"someday"}]"#)[0].isBroken)
}

@Test func theRowLineNamesTwoCountsTheRestAndSkipsWhatCanNeverFire() throws {
    func agent(
        _ status: String, since: String = "null", wakes: String,
        until: String = #"{"reason":"r","until":"2026-11-20T18:00:00.000Z","isDefault":false}"#
    ) throws -> RegisteredAgent {
        let json = """
            {"id":"a","title":"t","status":"\(status)","runtime":"claude","link":null,"notes":"",
             "outcome":null,"notStarted":null,"project":null,"matter":null,"wait":\(until),"statusSince":\(since),
             "wakesOn":\(wakes),"amber":[]}
            """
        return try LibraryStore.feedDecoder.decode(RegisteredAgent.self, from: Data(json.utf8))
    }
    let dead = try agent(
        "waiting",
        wakes: """
            [{"kind":"message","party":{"ref":"person:idris","name":"Idris Benali","kind":"person"},"personAsWritten":"Idris","calls":true},
             {"kind":"message","personAsWritten":"Léa Marchetti","calls":true,"broken":"unknown_person"},
             {"kind":"message","calls":true,"chat":{"name":null,"app":null,"group":null}},
             {"kind":"answer","card":"Go?","check":"c","deadline":"2026-11-20T18:00:00.000Z"},{"kind":"wide_net"}]
            """)
    #expect(dead.rowLine(locale: english, timeZone: utc) == "Idris +3, or Fri 18:00")
    let none = try agent("waiting", wakes: "[]", until: "null")
    #expect(none.rowLine(locale: english, timeZone: utc) == nil)
    let only = try agent("waiting", wakes: #"[{"kind":"wide_net"}]"#)
    #expect(only.rowLine(locale: english, timeZone: utc) == "Fri 18:00")
    #expect(
        try agent("running", since: #""2026-11-19T14:02:00.000Z""#, wakes: "[]", until: "null").rowLine(
            locale: english, timeZone: utc)
            == "Working since 14:02")
    #expect(try agent("stopped", wakes: "[]", until: "null").rowLine(locale: english, timeZone: utc) == "Stopped")
    #expect(try agent("ended", wakes: "[]", until: "null").rowLine(locale: english, timeZone: utc) == nil)
}

@Test func anAgentHasOneStateWordForItsRowAndItsSheet() throws {
    func agent(_ status: String, notStarted: String = "null", since: String = "null") throws -> RegisteredAgent {
        let json = """
            {"id":"a","title":"t","status":"\(status)","runtime":"claude","link":null,"notes":"","outcome":null,
             "notStarted":\(notStarted),"project":null,"matter":null,"wait":null,"statusSince":\(since),"wakesOn":[],
             "amber":[]}
            """
        return try LibraryStore.feedDecoder.decode(RegisteredAgent.self, from: Data(json.utf8))
    }
    #expect(try agent("running").stateWord == "Working")
    #expect(try agent("stopped").stateWord == "Stopped")
    #expect(try agent("ended").stateWord == "Finished")
    #expect(try agent("handed_over").stateWord == "Handed over")
    #expect(try agent("waiting").stateWord == nil)
    let refused = try agent("ended", notStarted: #""Codex refused""#)
    #expect(refused.stateWord == "Not started")
    #expect(refused.rowLine(locale: english, timeZone: utc) == "Not started: Codex refused")
    // The server decides when it began: no date, no guess from a turn.
    #expect(try agent("running").rowLine(locale: english, timeZone: utc) == "Working")
}

@Test func aWaitingAgentWhoseSessionIsOpenInHisAppSaysSoOnItsRow() throws {
    let json = """
        {"id":"a","title":"t","status":"waiting","runtime":"claude","link":null,"notes":"","outcome":null,
         "notStarted":null,"project":null,"matter":null,"wait":null,"statusSince":null,"wakesOn":[],
         "amber":["session open in your Claude app"],"sessionOpenIn":"claude_app",
         "sessionOpenSince":"2026-11-22T09:12:00.000Z"}
        """
    let agent = try LibraryStore.feedDecoder.decode(RegisteredAgent.self, from: Data(json.utf8))
    #expect(agent.rowLine(locale: english, timeZone: utc) == "Paused: open in your Claude app since 09:12")
}
