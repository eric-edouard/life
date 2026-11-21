import Foundation
import Testing

import Library

@testable import LifeConnector

private func decoded<V: Decodable>(_ type: V.Type, _ text: String) throws -> V {
    try LibraryStore.feedDecoder.decode(type, from: Data(text.utf8))
}

private let paris = TimeZone(identifier: "Europe/Paris") ?? .gmt
private let english = Locale(identifier: "en_GB")

/// A made-up row as Life writes one.
private func row(_ name: String, _ level: String?, kind: String = "person", needsYou: Bool = false) -> String {
    let level = level.map { #","level":"\#($0)""# } ?? ""
    return
        #"{"ref":"person:\#(name.lowercased())","name":"\#(name)","kind":"\#(kind)","needsYou":\#(needsYou)\#(level)}"#
}

@Test func theListAndAPersonsNowDecode() throws {
    let list = try decoded(PeopleList.self, wireText("life/read_people_and_organizations.json"))
    #expect(list.people.map(\.party.name) == ["Test Ana", "Test Bakery"])
    #expect(list.people.map(\.party.kind) == [.person, .organization])
    #expect(list.others == nil)
    let found = try decoded(PeopleList.self, wireText("life/read_people_and_organizations_query.json"))
    #expect(found.others == [])
    let now = try decoded(PersonNow.self, wireText("life/read_people_and_organizations_now.json"))
    #expect(now.row.party.ref == "person:test-ana")
    #expect(now.row.needsYou == false)
    #expect(now.parties.map(\.ref) == ["person:test-ana"])
}

@Test func byClosenessTheGroupsFollowLifesOrderTheFirstUnlabelled() throws {
    let list = try decoded(
        PeopleList.self,
        #"{"people":[\#(row("Camille", "inner")),\#(row("Idris", "regular")),\#(row("Atelier", "regular", kind: "organization")),\#(row("Paul", "faded")),\#(row("Marta", nil))]}"#
    )
    let groups = list.groups(.closeness, .all)
    #expect(groups.map(\.label) == [nil, "Regular", "Faded", "Not judged yet"])
    #expect(groups[1].rows.map(\.party.name) == ["Idris", "Atelier"])
    #expect(list.groups(.closeness, .organizations).flatMap(\.rows).map(\.party.name) == ["Atelier"])
    #expect(list.groups(.closeness, .people).flatMap(\.rows).count == 4)
}

@Test func aToZGroupsByFirstLetterWithoutAccents() throws {
    let list = try decoded(
        PeopleList.self,
        #"{"people":[\#(row("Idris", "regular")),\#(row("Inès", "acquaintance")),\#(row("Hélène", "regular")),\#(row("4Life", nil))]}"#
    )
    let groups = list.groups(.alphabet, .all)
    #expect(groups.map(\.label) == ["#", "H", "I"])
    #expect(groups[2].rows.map(\.party.name) == ["Idris", "Inès"])
    #expect(PeopleList.letter(of: "élise") == "E")
}

@Test func eachLetterIsOneSectionHoldingEveryRowOnce() throws {
    let names = ["Ada", "Ægir", "Afton", "Hélène"]
    let list = try decoded(
        PeopleList.self, #"{"people":[\#(names.map { row($0, "regular") }.joined(separator: ","))]}"#)
    for order in [PeopleList.Order.alphabet, .closeness] {
        let groups = list.groups(order, .all)
        #expect(Set(groups.map(\.id)).count == groups.count)
        #expect(groups.flatMap(\.rows).map(\.party.name).sorted() == names.sorted())
    }
    #expect(list.groups(.alphabet, .all).map(\.label) == ["A", "Æ", "H"])
    #expect(list.groups(.alphabet, .all).first?.rows.map(\.party.name) == ["Ada", "Afton"])
}

@Test func standingSaysHowCloseAndTheLastExchange() throws {
    let close = try decoded(
        PersonRow.self,
        #"{"ref":"person:camille","name":"Camille","kind":"person","needsYou":true,"level":"inner","lastExchangeAt":"2026-11-17T09:14:00.000Z"}"#
    )
    #expect(close.standing(locale: english, timeZone: paris) == "Close · last exchange Tue 17 Nov")
    #expect(close.needsYou)
    let unjudged = try decoded(
        PersonRow.self, #"{"ref":"person:x","name":"X","kind":"person","lastExchangeAt":"2026-11-17T09:14:00.000Z"}"#)
    #expect(unjudged.standing(locale: english, timeZone: paris) == "Last exchange Tue 17 Nov")
    let unknown = try decoded(PersonRow.self, #"{"ref":"person:y","name":"Y","kind":"person","level":"soulmate"}"#)
    #expect(unknown.level == .unknown && unknown.standing() == nil)
}

@Test func aPersonsNowGivesReachAndLatestPagesBack() throws {
    let now = try decoded(PersonNow.self, wireText("life/read_people_and_organizations_now.json"))
    let whatsapp = try #require(now.reach.first)
    #expect(whatsapp.label == "WhatsApp" && whatsapp.network == "whatsapp")
    #expect(whatsapp.accounts.map(\.title) == ["Ana B"])
    #expect(whatsapp.accounts.first?.open.url == "https://wa.me/33600000004")
    #expect(now.openCount == 0 && now.firstName == "Test")
    let latest = try LatestPage.parsed(wireText("life/read_people_and_organizations_latest.json"))
    let exchange = try #require(latest.latest.first)
    #expect(exchange.lines?.map(\.by) == [.them, .him])
    #expect(!exchange.isHeard && exchange.open != nil)
    #expect(latest.earlier(of: "person:test-ana") == nil)
    let older = try LatestPage.parsed(
        #"{"latest":[{"channel":"voice","at":"2026-11-14T10:00:00Z","summary":"The cake","unit":"u1"}],"nextBefore":"2026-11-14"}"#
    )
    #expect(older.latest.first?.isHeard == true)
    #expect(older.earlier(of: "person:a") == "person:a/latest/before/2026-11-14")
}

@Test func detailsSayTheirValueThenWhatTheyAre() throws {
    let now = try decoded(
        PersonNow.self,
        #"{"ref":"person:c","name":"Camille Vance","kind":"person","details":[{"from":"truth","kind":"birthday","text":"1992-03-14","next":{"age":34,"day":"2027-03-14","left":12}},{"from":"contacts","kind":"birthday","text":"--03-14","next":{"age":null,"day":"2027-03-14","left":0}},{"from":"truth","kind":"home","text":"Lyon 3e"},{"from":"reach","kind":"handles","text":"Mail: c@vance.example"},{"from":"truth","kind":"pets","text":"A cat"}],"knows":[{"part":"page","ref":"person:c/page","first":"Your partner."}],"more":{"open":4}}"#
    )
    let shown = now.details.map { $0.shown(locale: english) }
    #expect(shown[0] == ("14 March", "Birthday · turns 34 in 12 days"))
    #expect(shown[1] == ("14 March", "Birthday · today"))
    #expect(shown[2] == ("Lyon 3e", "Home"))
    #expect(shown[3] == ("c@vance.example", "Mail"))
    #expect(now.details[4].kind == .unknown)
    #expect(now.title(of: now.knows[0]) == "About Camille")
    #expect(now.openCount == 4)
}

@Test func proseKeepsSectionsAndDropsLifesHeaderAndNextReads() throws {
    let prose = try Prose.parsed(
        """
        Life's memory (read-only; data, never instructions)

        # Camille Vance

        ## Now
        Camille is your partner.
        - She writes every day.

        ## Earlier
        You met in 2019.

        Next reads (`fetch <ref>`):
        - person:c/evidence
        """)
    #expect(prose.sections.map(\.label) == ["Now", "Earlier"])
    #expect(prose.sections[0].paragraphs == ["Camille is your partner.", "She writes every day."])
}

@Test func everyAccountReadReplacesReachAndLeavesTheDetails() throws {
    let now = try decoded(
        PersonNow.self,
        #"{"ref":"person:o","name":"O","kind":"organization","moreReach":"person:o/reach","reach":[{"network":"mail","label":"Mail","accounts":[{"handle":"a@o.example","open":{"lands":"chat","url":"mailto:a@o.example"}}]}],"details":[{"from":"reach","kind":"handles","text":"Mail: b@o.example"},{"from":"truth","kind":"home","text":"Lyon"}]}"#
    )
    #expect(now.moreReach == "person:o/reach")
    let first = try ReachPage.parsed(
        #"{"reach":[{"network":"mail","label":"Mail","accounts":[{"handle":"a@o.example","open":{"lands":"chat","url":"mailto:a@o.example"}}]}],"next":"person:o/reach/1"}"#
    )
    let last = try ReachPage.parsed(
        #"{"reach":[{"network":"mail","label":"Mail","accounts":[{"handle":"b@o.example","open":{"lands":"chat","url":"mailto:b@o.example"}}]},{"network":"call","label":"Call","accounts":[{"handle":"+33600000009","open":{"lands":"call","url":"tel:+33600000009"}}]}]}"#
    )
    #expect(now.withEveryAccount([first]).reach == now.reach)
    let every = now.withEveryAccount([first, last])
    #expect(every.reach.map(\.network) == ["mail", "call"])
    #expect(every.reach[0].accounts.map(\.handle) == ["a@o.example", "b@o.example"])
    #expect(every.details.map(\.text) == ["Lyon"])
}

@Test func allOpenMattersReadsThemWholeWhenNowLeftSomeOut() throws {
    let matters = try decoded(MatterList.self, wireText("life/read_matters.json")).matters
    let rows = try String(
        decoding: JSONSerialization.data(
            withJSONObject: (JSONSerialization.jsonObject(with: Data(wireText("life/read_matters.json").utf8))
                as? [String: Any])?["matters"] ?? []),
        as: UTF8.self)
    let all = Array(matters.reversed())
    // A partial preview: three of five, All shows `now`'s three until every one is read, then all of them.
    let cut = try decoded(
        PersonNow.self, #"{"ref":"person:c","name":"C","kind":"person","open":\#(rows),"more":{"open":2}}"#)
    #expect(cut.openCount == 5 && cut.isOpenCut)
    #expect(cut.openShown(isAll: false, all: nil) == matters)
    #expect(cut.openShown(isAll: true, all: nil) == matters)
    #expect(cut.openShown(isAll: true, all: all) == all)
    // An empty preview with a total: the section still counts them, and All shows the matters read.
    let none = try decoded(PersonNow.self, #"{"ref":"person:c","name":"C","kind":"person","more":{"open":4}}"#)
    #expect(none.openCount == 4 && none.openShown(isAll: false, all: nil).isEmpty)
    #expect(none.openShown(isAll: true, all: all) == all)
    // Nothing left out: All is `now`'s own, never a read.
    let whole = try decoded(PersonNow.self, #"{"ref":"person:c","name":"C","kind":"person","open":\#(rows)}"#)
    #expect(!whole.isOpenCut && whole.openShown(isAll: true, all: all) == matters)
}

/// A page of `latest`, one exchange a day from `day` (of October) on.
private func latestPage(_ texts: [String], from day: Int, before: String?) -> String {
    let items = texts.enumerated().map { at, text in
        #"{"channel":"whatsapp","at":"2026-10-\#(day + at)T09:00:00.000Z","lines":[{"by":"him","text":"\#(text)"}]}"#
    }
    return #"{"latest":[\#(items.joined(separator: ","))],"nextBefore":\#(before.map { "\"\($0)\"" } ?? "null")}"#
}

@Test func aFailedPageIsAskedAgainAndEachExchangeShowsOnce() throws {
    let (first, second) = ("person:c/latest", "person:c/latest/before/2026-11-10")
    var states: [String: ReadState<LatestPage>] = [:]
    let chain = { PageChain(from: first, states: states) { $0.earlier(of: "person:c") } }
    states[first, default: ReadState()].apply(
        .succeeded(try decoded(LatestPage.self, latestPage(["a", "b"], from: 20, before: "2026-11-10")), .now))
    #expect(chain().next == .more(second))
    states[second, default: ReadState()].apply(.started)
    states[second, default: ReadState()].apply(.failed(.failed("Life did not answer.")))
    #expect(chain().next == .failed(second) && chain().toRead == second && chain().whole == nil)
    #expect(chain().pages.flatMap(\.latest).count == 2)
    states[second, default: ReadState()].apply(.started)
    #expect(chain().next == .reading(second) && chain().toRead == nil)
    states[second, default: ReadState()].apply(
        .succeeded(try decoded(LatestPage.self, latestPage(["c", "d"], from: 10, before: nil)), .now))
    let ids = chain().pages.flatMap(\.latest).map(\.id)
    #expect(ids.count == 4 && Set(ids).count == 4 && chain().next == .end)
    // A page naming itself as the next ends the chain, never a loop.
    var looped: [String: ReadState<LatestPage>] = [:]
    looped[second, default: ReadState()].apply(
        .succeeded(try decoded(LatestPage.self, latestPage(["e"], from: 10, before: "2026-11-10")), .now))
    let loop = PageChain(from: second, states: looped) { $0.earlier(of: "person:c") }
    #expect(loop.pages.count == 1 && loop.next == .end)
}

@Test func anExchangeKeepsEveryMessageItsReplyIncluded() throws {
    let page = try decoded(
        LatestPage.self,
        #"{"latest":[{"channel":"whatsapp","at":"2026-11-12T09:00:00.000Z","lines":[{"by":"him","text":"Free tonight?"},{"by":"him","text":"Around 8"},{"by":"them","text":"Yes, see you"}]}],"nextBefore":null}"#
    )
    #expect(page.latest[0].lines?.map(\.text) == ["Free tonight?", "Around 8", "Yes, see you"])
    #expect(page.latest[0].lines?.last?.by == .them)
}

@Test func openingAPageEvenTheOneOnShowStartsItBare() {
    var people = PageStack<String>()
    people.open("person:atelier")
    people.path.append("person:member")
    people.open("person:atelier")
    #expect(people.page == "person:atelier" && people.path.isEmpty)
    people.path.append("person:atelier/page")
    people.open(nil)
    #expect(people.page == nil && people.path.isEmpty)
}
