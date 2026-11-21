import Foundation
import Library
import Testing

@testable import LifeConnector

private func decoded<V: Decodable>(_ type: V.Type, _ text: String) throws -> V {
    try LibraryStore.feedDecoder.decode(type, from: Data(text.utf8))
}

/// An appointment as the wire carries it: the made-up dinner, a field of it replaced by `swap` (its old text, its new).
private func dinner(swapping swap: (String, String)? = nil) throws -> Appointment {
    var text =
        #"{"appointment":"apt_000000000001","pushId":"0123456789abcdef","title":"Dinner with Camille","#
        + #""startsAt":"2026-11-20T19:00:00.000Z","endsAt":"2026-11-20T21:00:00.000Z","allDay":false,"#
        + #""where":"Chez Lou","link":null,"matterId":"matter_mum60","addedAt":"2026-11-18T10:00:00.000Z","#
        + #""removedAt":null,"from":{"at":"2026-11-18T09:58:00.000Z","chat":"!room:life.test","#
        + #""message":"msg:whatsapp|m1","text":"Friday 8pm at Chez Lou?","#
        + #""sender":{"kind":"person","name":"Camille Test","ref":"person:test-camille"}}}"#
    if let swap { text = text.replacingOccurrences(of: swap.0, with: swap.1) }
    return try decoded(Appointment.self, text)
}

@Test func theEventSheetsReadDecodesAsLifeWroteIt() throws {
    let added = try decoded(Appointment.self, wireText("life/read_appointments.json"))
    #expect(added.title == "Coffee with Kit" && added.link == "https://meet.example.com/kit-lou")
    #expect(!added.isRemoved && added.from == nil && added.start != nil)
    let removed = try decoded(Appointment.self, wireText("life/read_appointments_removed.json"))
    #expect(removed.isRemoved && removed.appointment == added.appointment)
    #expect(try decoded(AppointmentChange.self, wireText("life/change_appointment_removed.json")).result == .removed)
    let failed = try decoded(AppointmentChange.self, wireText("life/change_appointment_failed.json"))
    #expect(failed.result == .failed && failed.reason != nil)
    // The message it came from, with its sender as a party.
    let quoted = try dinner().from
    #expect(quoted?.sender?.name == "Camille Test" && quoted?.message == "msg:whatsapp|m1")
}

@Test func itsWordsAreItsDayAndTimeWhereThePhoneIs() throws {
    let paris = try #require(TimeZone(identifier: "Europe/Paris"))
    #expect(try dinner().line(in: paris) == "Dinner with Camille, Fri 20:00")
    #expect(try dinner().when(in: paris) == "Fri 20 Nov, 20:00")
    // An all-day one is its own day, wherever the phone is.
    let trip = try dinner(
        swapping: (
            #""startsAt":"2026-11-20T19:00:00.000Z","endsAt":"2026-11-20T21:00:00.000Z","allDay":false"#,
            #""startsAt":"2026-11-20","endsAt":"2026-11-23","allDay":true"#
        ))
    let tokyo = try #require(TimeZone(identifier: "Asia/Tokyo"))
    #expect(trip.line(in: tokyo) == "Dinner with Camille, Fri" && trip.when(in: tokyo) == "All day, Fri 20 Nov")
    #expect(try dinner().mapsURL?.absoluteString == "https://maps.apple.com/?q=Chez%20Lou")
    #expect(try dinner().calendarURL?.scheme == "calshow")
}

@Test func removeFromItsNotificationSaysHowItWent() throws {
    let line = try dinner().line(in: .gmt)
    let removed = try wireText("life/change_appointment_removed.json")
    #expect(throws: Never.self) { try AppointmentChange.checked(removed, isOn: false) }
    #expect(CalendarNotification.afterRemove(isRemoved: true, line: line) == ("Removed from your calendar", line))
    // Life's refusal, or an answer that is not his act's: failed, with Life's reason; nothing changed.
    #expect(throws: MCPError.failed("gog calendar delete: offline")) {
        try AppointmentChange.checked(try wireText("life/change_appointment_failed.json"), isOn: false)
    }
    #expect(throws: MCPError.self) { try AppointmentChange.checked(removed, isOn: true) }
    #expect(
        CalendarNotification.afterRemove(isRemoved: false, line: line)
            == ("Not removed", "Your Mac did not answer. Open Life to try again."))
    #expect(CalendarNotification.actions.map(\.identifier) == ["remove", "openInCalendar"])
}
