import Foundation
import Testing

@testable import LifeConnector

@Test func aMatterThreadDecodesAsLifeWroteIt() throws {
    let page = try MatterThread.parsed(wireText("life/fetch_matter_thread.json"))
    #expect(page.matter == "matter_aaaaaaaaaaaa" && page.nextBefore == nil && page.earlier == nil)
    #expect(
        page.lines.map(\.kind) == [.moment, .payment, .message, .event, .voice, .quote, .call, .todoItem])
    #expect(Set(page.lines.map(\.id)).count == page.lines.count)
    let message = try #require(page.lines.first { $0.kind == .message })
    #expect(message.speaker?.name == "Gran" && message.channel == "whatsapp" && !message.isHis)
    #expect(message.open?.absoluteString == "https://wa.me/33600000001")
    let payment = try #require(page.lines.first { $0.kind == .payment })
    #expect(payment.paymentWords == "Watch Shop, 45 EUR" && payment.step == nil)
    let call = try #require(page.lines.first { $0.kind == .call })
    #expect(call.span.map { $0.until.timeIntervalSince($0.at) } == 90)
    #expect(page.parties.count == 4)
}

@Test func anOlderPageIsAskedByItsDayAndAnUnknownKindIsKept() throws {
    let text =
        #"{"matter":"matter_x","nextBefore":"2026-10-02","thread":[{"at":"2026-10-03T10:00:00Z","day":"2026-10-03","#
        + #""kind":"letter","text":"A new kind"}]}"#
    let page = try MatterThread.parsed(text)
    #expect(page.earlier == "matter_x/thread/before/2026-10-02" && page.lines.first?.kind == .unknown)
}
