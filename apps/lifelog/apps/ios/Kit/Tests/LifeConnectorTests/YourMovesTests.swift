import Foundation
import Testing

import Library

@testable import LifeConnector

private let utc = TimeZone(identifier: "UTC")!
private let now = Date(timeIntervalSince1970: 1_795_111_200)  // 19 Nov 2026

private func move(_ ref: String, matter: String, day: String, options: String = #"["done","start","drop"]"#) throws
    -> Check
{
    let list = try JSONSerialization.jsonObject(with: Data(options.utf8)) as! [String]
    let opts = list.map { #"{"id":"\#($0)","label":"\#($0)"}"# }.joined(separator: ",")
    let json = """
        {"ref":"\(ref)","group":"your move","title":"t","question":"q","asker":"Life","urgency":"improves",
         "options":[\(opts)],"clips":[],"likelyPeople":[],"links":[],"matter":{"id":"\(matter)","name":"M \(matter)"},
         "since":{"text":"s","at":"\(day)"}}
        """
    return try LibraryStore.feedDecoder.decode(Check.self, from: Data(json.utf8))
}

private func matters() throws -> [MatterRow] {
    func row(_ id: String, project: String, status: String, with: String) -> String {
        """
        {"id":"\(id)","name":"M \(id)","status":"\(status)","people":{"with":[\(with)]},
         "project":{"id":"\(project)","name":"P \(project)","status":"active"}}
        """
    }
    let camille = #"{"ref":"person:camille","name":"Camille","kind":"person"}"#
    let json =
        "["
        + [
            row("a", project: "p1", status: "moving", with: camille),
            row("b", project: "p2", status: "dormant", with: ""),
        ].joined(separator: ",") + "]"
    return try LibraryStore.feedDecoder.decode([MatterRow].self, from: Data(json.utf8))
}

@Test func moves_are_oldest_first_and_filter_by_age_project_person_and_dead() throws {
    let checks = [
        try move("c1", matter: "a", day: "2026-11-16"), try move("c2", matter: "b", day: "2026-09-01"),
        try move("c3", matter: "a", day: "2026-10-01"),
    ]
    let all = YourMoves(checks: checks, matters: try matters(), now: now, timeZone: utc)
    #expect(all.moves.map(\.id) == ["c2", "c3", "c1"])
    #expect(all.shown(.overMonth).map(\.id) == ["c2", "c3"])
    #expect(all.shown(.project("p1")).map(\.id) == ["c3", "c1"])
    #expect(all.shown(.person("person:camille")).map(\.id) == ["c3", "c1"])
    #expect(all.dead.map(\.id) == ["c2"])
    #expect(all.moves[2].detail == "M a · 3 days")
}

@Test func a_server_without_drop_offers_no_drop_answer() throws {
    let old = try move("c1", matter: "a", day: "2026-11-16", options: #"["done","start","not-now"]"#)
    let moves = YourMoves(checks: [old], matters: [], now: now, timeZone: utc).moves
    #expect(moves[0].answer("drop") == nil)
    #expect(moves[0].answer("done") == AnswerRequest(ref: "c1", options: ["done"]))
}

@Test func projects_follow_the_given_order_with_their_counts_and_people_list_each_once() throws {
    let checks = [
        try move("c1", matter: "a", day: "2026-11-16"), try move("c2", matter: "b", day: "2026-09-01"),
        try move("c3", matter: "a", day: "2026-10-01"),
    ]
    let all = YourMoves(checks: checks, matters: try matters(), now: now, timeZone: utc)
    let held = all.projects(in: ["p2", "none", "p1"])
    #expect(held.map(\.project.id) == ["p2", "p1"])
    #expect(held.map(\.count) == [1, 2])
    #expect(all.people().map(\.ref) == ["person:camille"])
    #expect(all.people(limit: 0).isEmpty)
}
