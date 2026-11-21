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

@Test func aRepliedOrReactedMessageIsNeverPlacedAmongTheLastOnesOnlyShownAsStamped() throws {
    // Nothing on `recent` proves which message `onMessage` named: an older one, a twin, a prefix, or his own.
    let recent =
        #""recent":[\#(message("Ben", "OK, tomorrow")),\#(message("Camille", "OK")),"#
        + #"\#(message("Camille", "OK")),\#(message("me", "I can be there"))]"#
    for quoted in [
        #"{"sender":"+33600000002","text":"OK"}"#,  // identical to two of them, or an older "OK" of Ana's
        #"{"sender":"+33600000002","text":"OK, tom"}"#,  // a prefix of Ben's
        #"{"sender":"+33600000009","text":"I can be there"}"#,  // his own older message
    ] {
        for kind in [#""reaction":"👍""#, #""text":"Sure""#] {
            let draft = try draft(#"\#(kind),"quoted":\#(quoted),\#(recent)"#)
            let lines = draft.chatLines(calendar: utc)
            #expect(lines.map(\.text) == ["OK, tomorrow", "OK", "OK", "I can be there"])
            #expect(lines.map(\.isMine) == [false, false, false, true])
        }
    }
    // A card asked before `recent` has no lines, only its stamped quote.
    #expect(try draft(#""text":"Fine","quoted":{"sender":"Camille","text":"See you"}"#).chatLines(calendar: utc) == [])
}

@Test func theMentionsTheDraftNamesAreCutOutOfItsWords() throws {
    let runs = try draft(#""text":"@Idris let's say Tuesday, @Nora too","mentions":[{"name":"Idris"},{"name":"Nora"}]"#)
        .textRuns
    #expect(runs.map(\.text) == ["@Idris", " let's say Tuesday, ", "@Nora", " too"])
    #expect(runs.map(\.isMention) == [true, false, true, false])
    #expect(try draft(#""text":"No one""#).textRuns.map(\.isMention) == [false])
    // A name only whole, as the send links it: `@Ann` is the second one, never the start of `@Anna`.
    let whole = try draft(#""text":"@Anna, then @Ann","mentions":[{"name":"Ann"}]"#).textRuns
    #expect(whole.map(\.text) == ["@Anna, then ", "@Ann"])
    #expect(whole.map(\.isMention) == [false, true])
    // The send tests the one UTF-16 unit after a name: half of a pair is no letter, so `@Ann𠮷` holds a whole `@Ann`.
    let paired = try draft(#""text":"@Ann𠮷, then @Ann","mentions":[{"name":"Ann"}]"#).textRuns
    #expect(paired.map(\.text) == ["@Ann", "𠮷, then @Ann"])
    #expect(paired.map(\.isMention) == [true, false])
    // A mention the send would not find ends the search there.
    #expect(try draft(#""text":"@Anna only","mentions":[{"name":"Ann"}]"#).textRuns.map(\.isMention) == [false])
}

@Test func theBubbleShowsTheSendFromItsProofOnly() throws {
    let step = { (id: String, passed: Bool) in ActionStep(id: id, passedAt: passed ? epoch : nil) }
    let running = { (steps: [ActionStep]) in ActionState<ActionProof>.running(steps: steps, limit: nil) }
    #expect(DraftDelivery(.idle) == .notSent)
    #expect(DraftDelivery(running([step("chat_checked", true), step("handed", false)])) == .notSent)
    #expect(DraftDelivery(running([step("handed", true), step("confirmed", false)])) == .handed)
    #expect(DraftDelivery(running([step("handed", true), step("confirmed", true)])) == .sent)
    let result = { (json: String) in
        ActionProof.answered(try LibraryStore.feedDecoder.decode(AnswerResult.self, from: Data(json.utf8)))
    }
    // An answer recorded with nothing sent (`send` absent): no ticks, and no "Sent." over it.
    let recorded = try result(#"{"ref":"dec_1","kind":"decision"}"#)
    #expect(DraftDelivery(.succeeded(recorded, steps: [])) == .notSent)
    #expect(!recorded.isSent)
    // A repeat of an answered send gets its first result with no steps streamed: two ticks, and nothing still asking.
    let replayed = ActionState<ActionProof>.succeeded(
        try result(#"{"ref":"dec_1","kind":"decision","send":{"state":"sent"}}"#), steps: [])
    #expect(DraftDelivery(replayed) == .sent)
    // "Asking Life" only while a request runs: never once answered, nor before it starts.
    #expect(!replayed.isRunning && running([]).isRunning && !ActionState<ActionProof>.idle.isRunning)
    // A dropped stream never said: it may have gone. Life's own "not sent" is not sent.
    let dropped = ActionState<ActionProof>.failed(ActionFailure(.streamDropped), steps: [step("handed", false)])
    #expect(DraftDelivery(dropped) == .mayHaveGone)
    // Confirmed in the chat, then the answer lost: it is sent.
    let confirmedThenDropped = ActionState<ActionProof>.failed(
        ActionFailure(.streamDropped), steps: [step("handed", true), step("confirmed", true)])
    #expect(DraftDelivery(confirmedThenDropped) == .sent)
    #expect(DraftDelivery(.failed(ActionFailure(reason: "Someone wrote", retry: .no), steps: [])) == .notSent)
}

@Test func aMailDraftIsTheOneThatNamesHisAddress() throws {
    #expect(try draft(#""text":"Signed.","from":"me@example.test","subject":"Re: Lease""#).isMail)
    #expect(try !draft(#""text":"Signed.""#).isMail)
}

@Test func anOlderMailCardKeepsItsGuessItsQuoteAndItsFile() throws {
    // Asked before `recent`, to someone Life only guesses, with a file: the legacy mail card.
    let guess =
        #"{"ref":"guess_1","group":"guessed person","title":"Who","question":"Who?","asker":"life","options":[],"#
        + #""clips":[],"likelyPeople":[],"links":[]}"#
    let card = try LibraryStore.feedDecoder.decode(
        Check.self,
        from: Data(
            (#"{"ref":"dec_mail","group":"decision","title":"Lease","question":"Send this to Helene?","asker":"desk","#
                + #""options":[],"clips":[],"likelyPeople":[],"links":[],"confirm":[\#(guess)],"draft":{"to":"Helene","#
                + #""channel":"mail","from":"me@example.test","subject":"Re: Lease","text":"Signed.","#
                + #""file":{"name":"lease.pdf","size":640000,"mime":"application/pdf"},"#
                + #""quoted":{"sender":"helene@example.test","subject":"Lease","text":"Can you send it back?"}}}"#)
                .utf8))
    let sheet = try #require(card.mailSheet)
    #expect(sheet.thread == .init(sender: "helene@example.test", at: nil, text: "Can you send it back?"))
    #expect(sheet.fields.map(\.label) == ["From", "To", "Subject"])
    #expect(sheet.fields.map(\.value) == ["me@example.test", "~ Helene", "Re: Lease"])
    #expect(card.draft?.file?.size == 640000)
}

@Test func aCardThatReplacesAnOlderDraftSaysWhich() throws {
    let card = { (replaces: String) in
        try LibraryStore.feedDecoder.decode(
            Check.self,
            from: Data(
                (#"{"ref":"dec_2","group":"decision","title":"Reply","question":"Send this?","asker":"desk","#
                    + #""options":[],"clips":[],"likelyPeople":[],"links":[],"replaces":\#(replaces),"#
                    + #""draft":{"to":"Jun","text":"Tonight"}}"#).utf8))
    }
    #expect(try card(#""dec_1""#).replaces == "dec_1")
    #expect(try card("null").replaces == nil)
}
