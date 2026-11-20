import Foundation
import Testing

@testable import LifeConnector

private let utc = TimeZone(identifier: "UTC")!
private let english = Locale(identifier: "en_GB")
/// Thursday 19 November 2026, 18:00 UTC.
private let thursday = Date(timeIntervalSince1970: 1_795_111_200)

private func check(_ extra: String, group: String = "decision") throws -> Check {
    let json = """
        {"ref":"c1","group":"\(group)","title":"t","question":"q","asker":"Codex","urgency":"blocks",
         "options":[{"id":"go","label":"Go"},{"id":"stop","label":"Stop"}],"clips":[],"likelyPeople":[],"links":[],
         "deadline":"2026-11-19T18:00:00Z"\(extra)}
        """
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(Check.self, from: Data(json.utf8))
}

@Test func aDeadlineIsOneWordingEverywhere() {
    #expect(DeadlineWords.when(thursday, locale: english, timeZone: utc) == "Thu 18:00")
    #expect(DeadlineWords.by(thursday, locale: english, timeZone: utc) == "By Thu 18:00")
    #expect(DeadlineWords.spoken(thursday, locale: english, timeZone: utc) == "Answer by Thursday 18:00")
}

@Test func theListLineIsTheMatterThenAVoiceDayThenTheChat() throws {
    #expect(try check(#","matter":{"id":"m","name":"Lease"}"#).listLine() == "Lease")
    let voice = try check(#","at":"2026-11-14T10:00:00Z""#, group: "voice")
    #expect(voice.listLine(locale: english, timeZone: utc) == "A voice, Sat 14 Nov")
    let chat = #","networkIdentity":{"shownName":"~ Idris B.","network":"WhatsApp"}"#
    #expect(try check(chat).listLine() == "~ Idris B., WhatsApp")
    #expect(try check("").listLine() == nil)
}

@Test func anAskSaysAnswerByOrWhatItGoesWithAfter() throws {
    #expect(try check("").deadlineLine(locale: english, timeZone: utc) == "Answer by Thu 18:00")
    #expect(
        try check(#","onSilence":"go""#).deadlineLine(locale: english, timeZone: utc)
            == "After Thu 18:00 it goes ahead")
    #expect(
        try check(#","onSilence":"stop""#).deadlineLine(locale: english, timeZone: utc)
            == "After Thu 18:00 it goes with Stop")
    let draft = #","onSilence":"go","draft":{"to":"Hélène"}"#
    #expect(try check(draft).deadlineLine(locale: english, timeZone: utc) == "Answer by Thu 18:00")
}
