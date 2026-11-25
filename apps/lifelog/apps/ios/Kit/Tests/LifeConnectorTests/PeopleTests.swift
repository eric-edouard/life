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
    let now = try decoded(PersonNow.self, wireText("life/read_people_and_organizations_now.json"))
    #expect(now.row.party.ref == "person:test-ana")
    #expect(now.row.needsYou == false)
    #expect(now.parties.map(\.ref) == ["person:test-ana"])
}

@Test func hisPicturePickReadsOffThePartyLifeSent() throws {
    let now = try decoded(PersonNow.self, wireText("life/read_people_and_organizations_now.json"))
    #expect(now.pictures.map(\.source) == ["contacts", "whatsapp"])
    // She shows no picture although she has some: his pick is "none".
    #expect(now.pictureInUse == PersonNow.noPicture)
    #expect(now.picturesFrom == "From Contacts and WhatsApp")
    let shown = try decoded(
        PersonNow.self,
        #"{"ref":"person:kim","name":"Kim","kind":"person","picture":{"id":"b2"},"pictures":[{"id":"b1","source":"contacts"},{"id":"b2","source":"whatsapp"},{"id":"b3","source":"instagram"}]}"#
    )
    #expect(shown.pictureInUse == "whatsapp")
    #expect(shown.picturesFrom == "From Contacts, WhatsApp and Instagram")
    #expect(shown.row.party.showing("b3").picture?.id == "b3")
    #expect(shown.row.party.showing(nil).picture == nil)
}

@Test func theClosestComeFirstUnderTheirLabelThenEveryLetter() throws {
    let list = try decoded(
        PeopleList.self,
        #"{"people":[\#(row("Camille", "inner")),\#(row("Idris", "regular")),\#(row("Atelier", "regular", kind: "organization")),\#(row("Paul", "faded")),\#(row("Marta", nil)),\#(row("Zoé", "inner"))]}"#
    )
    let sections = list.sections(kind: .people, query: "")
    #expect(sections.map(\.label) == ["Close to you", "C", "I", "M", "P", "Z"])
    // Life's order in "Close to you" (the read's own), the letters by name; a closest row is in both.
    #expect(sections[0].rows.map(\.party.name) == ["Camille", "Zoé"])
    #expect(sections.dropFirst().flatMap(\.rows).map(\.party.name) == ["Camille", "Idris", "Marta", "Paul", "Zoé"])
    // Nothing close of that kind: no group of its own.
    #expect(list.sections(kind: .organizations, query: "").map(\.label) == ["A"])
    #expect(list.count(of: .people) == 5 && list.count(of: .organizations) == 1)
}

@Test func aToZGroupsByFirstLetterWithoutAccents() throws {
    let list = try decoded(
        PeopleList.self,
        #"{"people":[\#(row("Idris", "regular")),\#(row("Inès", "acquaintance")),\#(row("Hélène", "regular")),\#(row("4Life", nil))]}"#
    )
    let groups = list.sections(kind: .people, query: "")
    #expect(groups.map(\.label) == ["#", "H", "I"])
    #expect(groups[2].rows.map(\.party.name) == ["Idris", "Inès"])
    #expect(PeopleList.letter(of: "élise") == "E")
}

@Test func hisSearchKeepsTheRowsWhoseNameHoldsHisWords() throws {
    let list = try decoded(
        PeopleList.self,
        #"{"people":[\#(row("Camille", "inner")),\#(row("Hélène", "regular")),\#(row("Atelier", "inner", kind: "organization"))]}"#
    )
    // Case and accents aside, one group per letter, and no "Close to you" while he searches.
    let found = list.sections(kind: .people, query: "HÉL")
    #expect(found.map(\.label) == ["H"] && found[0].rows.map(\.party.name) == ["Hélène"])
    let other = list.sections(kind: .organizations, query: "ATE")
    #expect(other.map(\.label) == ["A"] && other[0].rows.map(\.party.name) == ["Atelier"])
    #expect(list.sections(kind: .people, query: "zq").isEmpty)
    // A space is no search: the list he sees with nothing typed, "Close to you" included.
    #expect(
        list.sections(kind: .people, query: " ").map(\.label) == list.sections(kind: .people, query: "").map(\.label))
}

@Test func eachLetterIsOneSectionHoldingEveryRowOnce() throws {
    let names = ["Ada", "Ægir", "Afton", "Hélène"]
    let list = try decoded(
        PeopleList.self, #"{"people":[\#(names.map { row($0, "regular") }.joined(separator: ","))]}"#)
    let groups = list.sections(kind: .people, query: "")
    #expect(Set(groups.map(\.id)).count == groups.count)
    #expect(groups.flatMap(\.rows).map(\.party.name).sorted() == names.sorted())
    // Which letter Æ sorts after is the locale's: only that each letter is one section.
    #expect(Set(groups.map(\.label)) == ["A", "Æ", "H"])
    #expect(groups.first { $0.label == "A" }?.rows.map(\.party.name) == ["Ada", "Afton"])
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

@Test func besideTheListThePageOnShowIsOneOfTheRowsUnlessHeOpenedItFromElsewhere() throws {
    let list = try decoded(
        PeopleList.self,
        #"{"people":[\#(row("Idris", "inner")),\#(row("Atelier", "regular", kind: "organization")),\#(row("Nora", "faded"))]}"#
    )
    let beside = { (shown: String?, isFromElsewhere: Bool, kind: PeopleList.Kind, query: String) in
        list.selectionOf(shown, isFromElsewhere: isFromElsewhere, kind: kind, query: query, isSplit: true)
    }
    // The same listed person: tapped in the list, a control that leaves them out picks its first row; opened from a
    // matter's chip or a wake row, they stay through any control.
    #expect(beside("person:idris", false, .organizations, "") == "person:atelier")
    #expect(beside("person:idris", true, .organizations, "") == "person:idris")
    #expect(beside("person:idris", false, .people, "") == "person:idris")
    // A search that leaves them out picks the first of what he typed.
    #expect(beside("person:idris", false, .people, "Nor") == "person:nora")
    // A read that dropped the person tapped picks the first row.
    let fewer = try decoded(PeopleList.self, #"{"people":[\#(row("Nora", "faded"))]}"#)
    #expect(
        fewer.selectionOf("person:idris", isFromElsewhere: false, kind: .people, query: "", isSplit: true)
            == "person:nora")
    // No one on show: the first row of what the list shows.
    #expect(list.selectionOf(nil, isFromElsewhere: false, kind: .people, query: "", isSplit: true) == "person:idris")
}

@Test func theOpenDuoUprightChoosesNoOneBeforeATap() throws {
    let cached = try decoded(PeopleList.self, #"{"people":[\#(row("Idris", "inner"))]}"#)
    // Its first appearance, measured: a regular width taller than wide stacks, so nothing is chosen for him.
    let upright = PeopleList.isSplit(isRegularWidth: true, width: 1_000, height: 1_300)
    #expect(!upright && PeopleList.isSplit(isRegularWidth: true, width: 1_300, height: 1_000))
    #expect(!PeopleList.isSplit(isRegularWidth: false, width: 1_300, height: 1_000))
    #expect(
        cached.selectionOf(nil, isFromElsewhere: false, kind: .people, query: "", isSplit: upright) == nil)
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

@Test func anOrganizationsNowGivesItsPeopleThenThoseWhoLeft() throws {
    let bakery = try decoded(PersonNow.self, wireText("life/read_people_and_organizations_organization.json"))
    #expect(bakery.row.party.kind == .organization)
    #expect(bakery.members.map(\.line) == ["baker"])
    #expect(bakery.domains == ["bakery.example"])
    #expect(bakery.parties.map(\.ref) == ["person:test-bakery", "person:test-ana"])
    let atelier = try decoded(
        PersonNow.self,
        #"{"ref":"person:atelier","name":"Atelier","kind":"organization","people":[{"party":{"ref":"person:b","name":"B","kind":"person"},"role":"Founder"},{"party":{"ref":"person:m","name":"M","kind":"person"},"role":"Fitter","until":2025},{"party":{"ref":"person:j","name":"J","kind":"person"},"role":"Intern","until":"2024-06-30"}]}"#
    )
    let (now, before) = atelier.membersNowThenBefore
    #expect(now.map(\.line) == ["Founder"])
    #expect(before.map(\.line) == ["Fitter · until 2025", "Intern · until 2024-06-30"])
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

@Test func anExchangeKeepsEveryMessageItsReplyIncluded() throws {
    let page = try decoded(
        LatestPage.self,
        #"{"latest":[{"channel":"whatsapp","at":"2026-11-12T09:00:00.000Z","lines":[{"by":"him","text":"Free tonight?"},{"by":"him","text":"Around 8"},{"by":"them","text":"Yes, see you"}]}],"nextBefore":null}"#
    )
    #expect(page.latest[0].lines?.map(\.text) == ["Free tonight?", "Around 8", "Yes, see you"])
    #expect(page.latest[0].lines?.last?.by == .them)
}

@Test func anOrganizationSaysWhatItsReadLeftOut() throws {
    // Nothing fit: its people, domains and matters still count, so the page says how many rather than nothing.
    let none = try decoded(
        PersonNow.self,
        #"{"ref":"person:atelier","name":"Atelier","kind":"organization","more":{"people":3,"domains":2,"open":2}}"#)
    #expect(none.members.isEmpty && none.membersLeftOut == 3)
    #expect(none.domains.isEmpty && none.domainsLeftOut == 2)
    #expect(none.openCount == 2 && none.isOpenCut && none.openShown(isAll: false, all: nil).isEmpty)
    // Nothing left out: no count.
    let whole = try decoded(
        PersonNow.self, #"{"ref":"person:a","name":"A","kind":"organization","domains":["a.example"]}"#)
    #expect(whole.membersLeftOut == 0 && whole.domainsLeftOut == 0 && !whole.isOpenCut)
}
