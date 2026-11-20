import Foundation
import Library
import Testing

@testable import LifeConnector

/// A draft as the card carries it, from its JSON fields.
private func draft(_ fields: String) throws -> Check.Draft {
    try LibraryStore.feedDecoder.decode(Check.Draft.self, from: Data(#"{"to":"Halden house",\#(fields)}"#.utf8))
}

private func message(_ who: String, _ text: String, at: String = "2026-11-12T09:00:00.000Z") -> String {
    let ref = who == "me" ? "person:me" : "person:inf_\(who.lowercased())"
    return #"{"at":"\#(at)","sender":{"kind":"person","name":"\#(who) Keller","ref":"\#(ref)"},"text":"\#(text)"}"#
}

private var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .gmt
    return calendar
}

@Test func aGroupNamesEachRunOfItsSendersAndHisOwnLinesAreHis() throws {
    let lines = try draft(
        #""text":"Tuesday then","recent":[\#(message("Idris", "The supplier can deliver Tuesday")),"#
            + #"\#(message("Idris", "Or Wednesday")),\#(message("me", "Tuesday is better")),"#
            + #"\#(message("Nora", "Tuesday works", at: "2026-11-13T08:00:00.000Z"))]"#
    ).chatLines(calendar: utc)
    #expect(lines.map(\.isMine) == [false, false, true, false])
    // Over the first bubble of each run, in the sender's colour; never over his own.
    #expect(
        lines.map(\.sender) == [
            .init(name: "Idris", tone: 0), nil, nil, .init(name: "Nora", tone: 1),
        ])
    // A day divider only where the day changes.
    #expect(lines.map(\.newDay) == [nil, nil, nil, utc.date(from: DateComponents(year: 2026, month: 11, day: 13))])
}

@Test func aOneToOneChatNamesNobody() throws {
    let lines = try draft(#""text":"Yes","recent":[\#(message("Jun", "Signed?")),\#(message("me", "Soon"))]"#)
        .chatLines(calendar: utc)
    #expect(lines.allSatisfy { $0.sender == nil })
}

@Test func aReactionSitsOnTheMessageItReactsToAndNoNewBubbleIsDrawn() throws {
    let recent = #""recent":[\#(message("Idris", "Tuesday?")),\#(message("Camille", "I can be there from 9"))]"#
    let lines = try draft(
        #""reaction":"❤️","quoted":{"sender":"Camille","text":"I can be there from 9"},\#(recent)"#
    ).chatLines(calendar: utc)
    #expect(lines.map(\.reaction) == [nil, "❤️"])
    // Twin messages: which one is meant is unknown, so the quoted one is drawn apart rather than guessed.
    let twins = #""recent":[\#(message("Camille", "OK")),\#(message("Camille", "OK"))]"#
    let apart = try draft(#""reaction":"👍","quoted":{"sender":"+33600000002","text":"OK"},\#(twins)"#)
    #expect(apart.chatLines(calendar: utc).map(\.reaction) == [nil, nil, "👍"])
    // The quote names its sender as Life does when the message is among the last ones.
    let reply = try draft(#""text":"Sure","quoted":{"sender":"+33600000003","text":"I can be"},\#(recent)"#)
    #expect(reply.quotedSender == "Camille Keller")
    // Not among the last messages: the quoted one is drawn last, with the reaction on it.
    let alone = try draft(#""reaction":"👍","quoted":{"sender":"Camille","text":"See you"}"#).chatLines(calendar: utc)
    #expect(alone.map(\.text) == ["See you"])
    #expect(alone.map(\.reaction) == ["👍"])
    // A reply draws no reaction, and a card asked before `recent` has no lines.
    #expect(try draft(#""text":"Fine","quoted":{"sender":"Camille","text":"See you"}"#).chatLines(calendar: utc) == [])
}

@Test func theMentionsTheDraftNamesAreCutOutOfItsWords() throws {
    let runs = try draft(#""text":"@Idris let's say Tuesday, @Nora too","mentions":[{"name":"Idris"},{"name":"Nora"}]"#)
        .textRuns
    #expect(runs.map(\.text) == ["@Idris", " let's say Tuesday, ", "@Nora", " too"])
    #expect(runs.map(\.isMention) == [true, false, true, false])
    #expect(try draft(#""text":"No one""#).textRuns.map(\.isMention) == [false])
}

@Test func theBubbleShowsTheSendsOwnSteps() {
    let step = { (id: String, passed: Bool) in ActionStep(id: id, passedAt: passed ? epoch : nil) }
    let running = { (steps: [ActionStep]) in ActionState<ActionProof>.running(steps: steps, limit: nil) }
    #expect(DraftDelivery(ActionState<ActionProof>.idle) == .notSent)
    #expect(DraftDelivery(running([step("chat_checked", true), step("handed", false)])) == .notSent)
    #expect(DraftDelivery(running([step("handed", true), step("confirmed", false)])) == .handed)
    #expect(DraftDelivery(running([step("handed", true), step("confirmed", true)])) == .sent)
    // A repeat of an answered card's send gets its first result with no steps streamed: Life's answer is the proof.
    let replayed = ActionState<String>.succeeded("sent", steps: [])
    #expect(DraftDelivery(replayed) == .sent)
    #expect(DraftDelivery(ActionState<String>.failed(ActionFailure(reason: "No", retry: .no), steps: [])) == .notSent)
}

@Test func aMailDraftIsTheOneThatNamesHisAddress() throws {
    #expect(try draft(#""text":"Signed.","from":"me@example.test","subject":"Re: Lease""#).isMail)
    #expect(try !draft(#""text":"Signed.""#).isMail)
}
