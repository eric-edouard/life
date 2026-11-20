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
