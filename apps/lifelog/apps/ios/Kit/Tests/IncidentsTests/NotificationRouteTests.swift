import Foundation
import Testing

@testable import Incidents

@Test func otherPayloadsOpenNothing() {
    #expect(NotificationRoute(userInfo: [:]) == nil)
    #expect(NotificationRoute(userInfo: ["lifelog": "processing"]) == nil)
}

@Test func aNewCardOpensItsCardAndSeveralOpenTheInbox() {
    let one: [AnyHashable: Any] = ["aps": ["thread-id": "life-cards", "badge": 4], "pushId": "9f2c41d07ab35e68"]
    #expect(NotificationRoute(userInfo: one) == .card("9f2c41d07ab35e68", card: nil, life: nil))
    // The card the service extension kept with it comes along, with its Life, so the tap shows it before any read.
    let kept = one.merging(["card": "{\"ref\":\"c1\"}", "cardLife": "https://life.example.test"]) { $1 }
    #expect(
        NotificationRoute(userInfo: kept)
            == .card("9f2c41d07ab35e68", card: "{\"ref\":\"c1\"}", life: "https://life.example.test"))
    #expect(NotificationRoute(userInfo: ["aps": ["thread-id": "life-cards"]]) == .inbox)
    #expect(NotificationRoute(userInfo: ["aps": ["thread-id": "other"]]) == nil)
}

@Test func cardsThatLeftTheInboxAreRemoved() {
    let gone: [AnyHashable: Any] = [
        "aps": ["content-available": 1], "removed": ["9f2c41d07ab35e68", "0123456789abcdef"],
    ]
    #expect(NotificationRoute(userInfo: gone) == .removed(["9f2c41d07ab35e68", "0123456789abcdef"]))
}

@Test func anAppointmentLifeAddedOpensItsEventSheet() {
    // As lifelog's `alertOf` sends it: `kind` and `pushId` beside `aps`, category `life.calendar`, no badge.
    let added: [AnyHashable: Any] = [
        "aps": ["alert": ["title": "Life", "body": "Added to your calendar"], "category": "life.calendar"],
        "kind": "calendar.added", "pushId": "0123456789abcdef",
    ]
    #expect(NotificationRoute(userInfo: added) == .appointment("0123456789abcdef"))
}
