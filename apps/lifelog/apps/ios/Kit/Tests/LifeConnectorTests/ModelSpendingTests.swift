import Foundation
import Testing

import Library

@testable import LifeConnector

private func decoded<V: Decodable>(_ type: V.Type, _ text: String) throws -> V {
    try LibraryStore.feedDecoder.decode(type, from: Data(text.utf8))
}

private let britain = Locale(identifier: "en_GB")

/// `read_spending` as the page lists it: billed by provider with its share, his plans apart in tokens, the kinds in the
/// page's order (the agents in tokens, never dollars), the top rows opening their agent or matter.
@Test func theSpendingPageListsBilledAndPlansApart() throws {
    let spending = try decoded(ModelSpending.self, wireText("life/read_spending.json"))
    #expect(spending.monthName(locale: britain) == "February")
    #expect(spending.dayLabel("2020-02-03", locale: britain) == "3 Feb")
    let sections = spending.sections
    #expect(
        sections.map(\.label) == [
            "Billed to your keys, by provider", "Subscriptions, not counted above", "By kind, this month",
            "Top agents, by tokens", "Top matters, by tokens",
        ])
    let billed = sections[0].lines
    #expect(billed.map(\.title) == ["OpenRouter", "ElevenLabs"])
    #expect(billed.map(\.value) == ["$0.25", "$0.10"])
    #expect(billed.map(\.detail) == [nil, "Not reported"])
    #expect(abs((billed[0].share ?? 0) - 0.25 / 0.35) < 0.001)
    #expect(sections[1].lines == [SpendLine(title: "Claude", value: "0.5 M tokens", detail: "≈ $2 at list price")])
    #expect(sections[2].lines.map(\.title) == ["The night", "Agents", "Voice"])
    #expect(sections[2].lines.map(\.value) == ["$0.25", "0.5 M tokens", "$0.10"])
    #expect(sections[2].lines.map(\.detail) == [nil, "≈ $2 at list price, not billed", "1 not settled yet"])
    #expect(sections[3].lines.map(\.detail) == ["≈ $4 at list price, not billed"])
    #expect(sections[3].lines.map(\.opens) == [.agent("agt_000000000001")])
    #expect(sections[4].lines.map(\.opens) == [.matter("matter_000000000001")])
}

/// A month's read of these kinds and providers, and nothing else, as the page's lines.
private func lines(_ kinds: String, providers: String = "[]", unsettled: Int = 0) throws -> [SpendLine] {
    let zero = #"{"amount":0,"basis":"billed","currency":"USD"}"#
    return try decoded(
        ModelSpending.self,
        #"{"today":\#(zero),"month":\#(zero),"days":[],"byKind":\#(kinds),"byProvider":\#(providers),"unsettled":\#(unsettled),"topAgents":[],"topMatters":[],"observedAt":"2026-11-18T10:00:00.000Z"}"#
    ).sections.flatMap(\.lines)
}

/// The Mac's own models are one row at $0, naming what ran there.
@Test func theMacsModelsAreOneRow() throws {
    let free = #""billed":{"amount":0,"basis":"billed","currency":"USD"},"reported":true"#
    let mac = try lines("[]", providers: #"[{"provider":"describer",\#(free)},{"provider":"apple",\#(free)}]"#)
    #expect(mac == [SpendLine(title: "On this Mac", value: "$0", detail: "Photos, the arrival reader", isZero: true)])
}

/// What the read doesn't know is said: an older Life's agents row has no list price (their tokens alone, never "≈ $0"),
/// a plan's unpriced turn makes theirs a floor, and Voice work not settled shows before any of it settled.
@Test func spendingSaysWhatItDoesNotKnow() throws {
    #expect(
        try lines(#"[{"kind":"agents","tokens":500000}]"#) == [
            SpendLine(title: "Agents", value: "0.5 M tokens", detail: "Not billed")
        ])
    let price = #""equivalent":{"amount":1.2,"basis":"equivalent","currency":"USD"}"#
    let plans = #"[{"provider":"codex",\#(price),"tokens":500000,"reported":false}]"#
    let agents = #"[{"kind":"agents","tokens":500000,\#(price)}]"#
    #expect(try lines(agents, providers: plans).last?.detail == "≈ $1 at list price, not billed, not all reported")
    let voice = SpendLine(title: "Voice", value: "$0", detail: "2 not settled yet", isZero: true)
    #expect(try lines("[]", unsettled: 2) == [voice])
}

@Test func spendingsFiguresReadAsTheFramesSayThem() {
    #expect([0, 0.001, 8.956, 1234.5].map(SpendWords.dollars) == ["$0", "< $0.01", "$8.96", "$1,234.50"])
    #expect([640, 12_400, 4_120_000].map(SpendWords.tokens) == ["640 tokens", "12 k tokens", "4.1 M tokens"])
}

/// The agent's and the matter's quiet last lines: none for nothing spent, a session's start and plan named, a turn
/// without its usage said.
@Test func anAgentsAndAMattersSpendingLines() throws {
    let agents = try decoded(RegisteredAgents.self, wireText("life/read_registered_agents.json"))
    #expect(agents.agents[0].spending?.provider == .claude)
    #expect(agents.agents[0].spendingLine() == nil)
    var wire = try #require(
        JSONSerialization.jsonObject(with: Data(wireText("life/read_registered_agents.json").utf8)) as? [String: Any])
    var rows = try #require(wire["agents"] as? [[String: Any]])
    rows[0]["spending"] = [
        "tokens": 2_200_000, "reported": true, "provider": "claude", "since": "2026-11-14T10:00:00.000Z",
        "equivalent": ["amount": 30.2, "basis": "equivalent", "currency": "USD"],
    ]
    wire["agents"] = rows
    let spent = try decoded(
        RegisteredAgents.self, String(decoding: JSONSerialization.data(withJSONObject: wire), as: UTF8.self))
    #expect(
        spent.agents[0].spendingLine(locale: britain, timeZone: .gmt)
            == "This session, since 14 Nov: 2.2 M tokens on Claude, ≈ $30 at list price, not billed")
    let matter = try decoded(Matter.self, wireText("life/read_matter.json"))
    #expect(matter.spending?.tokens == 0 && matter.spendingLine == nil)
    let none = #""equivalent":{"amount":0,"basis":"equivalent","currency":"USD"}"#
    let unreported = try decoded(TokenSpending.self, #"{"tokens":0,"reported":false,\#(none)}"#)
    #expect(unreported.words() == "0 tokens, ≈ $0 at list price, not billed, not all reported")
}
