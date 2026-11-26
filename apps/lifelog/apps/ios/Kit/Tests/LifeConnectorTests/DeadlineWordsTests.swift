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

@Test func aRowSaysWhoTheChatThenAVoiceDayThenTheMatterItServes() throws {
    let chat = #","networkIdentity":{"shownName":"~ Idris B.","network":"WhatsApp"},"matter":{"id":"m","name":"Lease"}"#
    #expect(try check(chat).rowWho() == "~ Idris B., WhatsApp")
    let voice = try check(#","at":"2026-11-14T10:00:00Z""#, group: "voice")
    #expect(voice.rowWho(locale: english, timeZone: utc) == "A voice, Sat 14 Nov")
    #expect(try check(#","onMatters":[{"id":"m","name":"Lease"}]"#).rowWho() == "Lease")
    // A your-move card's title is its matter: the row does not say it twice.
    #expect(try check(#","matter":{"id":"m","name":"t"}"#, group: "your move").rowWho() == nil)
    #expect(try check("").rowWho() == nil)
}

@Test func aRowsDayIsTodayTomorrowAWeekdayOrADate() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = utc
    let day = { (hours: Double) in
        DeadlineWords.day(thursday.addingTimeInterval(hours * 3600), now: thursday, calendar: calendar, locale: english)
    }
    #expect(day(2) == "today")
    #expect(day(24) == "tomorrow")
    #expect(day(48) == "Sat")
    #expect(day(24 * 14) == "3 Dec")
    #expect(day(-24) == "18 Nov")
}

@Test func onlyHisOwnStepIsATaskAndAFixNamesItsNetwork() throws {
    #expect(try check("", group: "your move").isTask)
    #expect(try !check("").isTask)
    let fix = try JSONDecoder().decode(
        Check.self,
        from: Data(
            #"{"ref":"fix:signed-out/line","group":"fix","title":"t","question":"q","asker":"life","options":[],"clips":[],"likelyPeople":[],"links":[]}"#
                .utf8))
    #expect(fix.signInNetwork == "line")
    #expect(try check("").signInNetwork == nil)
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
