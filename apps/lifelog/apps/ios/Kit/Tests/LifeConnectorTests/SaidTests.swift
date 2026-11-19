import Foundation
import Testing

@testable import LifeConnector

private let utc = TimeZone(identifier: "UTC")!
private let english = Locale(identifier: "en_GB")

private func said(_ json: String) throws -> Check.Said {
    try JSONDecoder().decode(Check.Said.self, from: Data(json.utf8))
}

@Test func aSentenceSaysWhoToWhomWhereAndWhen() throws {
    let spoken = try said(
        #"{"at":"2026-11-14T10:00:00Z","by":"Sam","channel":"whatsapp","to":"Camille","text":"x"}"#)
    #expect(
        spoken.line(channelName: { $0 == "whatsapp" ? "WhatsApp" : $0 }, locale: english, timeZone: utc)
            == "Sam, to Camille, WhatsApp, Sat 14 Nov")
}

@Test func theChatThatIsTheSpeakerIsNotSaidTwiceAndADayIsKept() throws {
    let day = try said(#"{"at":"2026-11-14","by":"Camille","channel":"WhatsApp","to":"Camille","text":"x"}"#)
    #expect(day.line(locale: english, timeZone: utc) == "Camille, WhatsApp, Sat 14 Nov")
}

@Test func whatLifeDoesNotKnowIsLeftOut() throws {
    #expect(try said(#"{"at":null,"by":null,"channel":null,"to":null,"text":"x"}"#).line() == "")
    #expect(try said(#"{"at":"2026-11-14","text":"x"}"#).line(locale: english, timeZone: utc) == "Sat 14 Nov")
}

@Test func aMessageIsDatedToTheMinute() {
    #expect(
        SaidWords.moment(Date(timeIntervalSince1970: 1_795_111_200), locale: english, timeZone: utc)
            == "Thu 19 Nov, 18:00")
}

@Test func initialsAreTwoCapitalsWithoutTheGuessMark() {
    #expect(SaidWords.initials("Marc Delmas") == "MD")
    #expect(SaidWords.initials("~ Idris B.") == "IB")
}
