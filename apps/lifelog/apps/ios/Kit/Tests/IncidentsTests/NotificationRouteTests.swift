import Foundation
import Testing

@testable import Incidents

@Test func otherPayloadsOpenNothing() {
    #expect(NotificationRoute(userInfo: [:]) == nil)
    #expect(NotificationRoute(userInfo: ["lifelog": "processing"]) == nil)
}

@Test func aNewCardOpensItsCardAndSeveralOpenTheInbox() {
    let one: [AnyHashable: Any] = ["aps": ["thread-id": "life-cards", "badge": 4], "pushId": "9f2c41d07ab35e68"]
    #expect(NotificationRoute(userInfo: one) == .card("9f2c41d07ab35e68", card: nil))
    // The card the service extension kept with it comes along, so the tap shows it before any read.
    let kept = one.merging(["card": "{\"ref\":\"c1\"}"]) { $1 }
    #expect(NotificationRoute(userInfo: kept) == .card("9f2c41d07ab35e68", card: "{\"ref\":\"c1\"}"))
    #expect(NotificationRoute(userInfo: ["aps": ["thread-id": "life-cards"]]) == .inbox)
    #expect(NotificationRoute(userInfo: ["aps": ["thread-id": "other"]]) == nil)
}

@Test func cardsThatLeftTheInboxAreRemoved() {
    let gone: [AnyHashable: Any] = [
        "aps": ["content-available": 1], "removed": ["9f2c41d07ab35e68", "0123456789abcdef"],
    ]
    #expect(NotificationRoute(userInfo: gone) == .removed(["9f2c41d07ab35e68", "0123456789abcdef"]))
}
