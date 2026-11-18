import Foundation
import Testing

@testable import Incidents

/// Payloads as `apps/server/src/naming-queue.ts` and `IncidentNotifier.announce` send them.
@Test func routesEachNotificationKind() {
    let aps: [AnyHashable: Any] = ["alert": ["title": "New people", "body": "2 voices to name"], "sound": "default"]
    #expect(
        NotificationRoute(userInfo: ["aps": aps, "peopleDigest": "2026-10-11"]) == .peopleDigest)
    #expect(NotificationRoute(userInfo: ["aps": aps, "quickQuestion": "What time?"]) == .quickQuestion("What time?"))
}

@Test func otherPayloadsOpenNothing() {
    #expect(NotificationRoute(userInfo: [:]) == nil)
    #expect(NotificationRoute(userInfo: ["lifelog": "processing"]) == nil)
}

@Test func aNewCardOpensItsCardAndSeveralOpenTheInbox() {
    let one: [AnyHashable: Any] = ["aps": ["thread-id": "life-cards", "badge": 4], "pushId": "9f2c41d07ab35e68"]
    #expect(NotificationRoute(userInfo: one) == .card("9f2c41d07ab35e68"))
    #expect(NotificationRoute(userInfo: ["aps": ["thread-id": "life-cards"]]) == .inbox)
    #expect(NotificationRoute(userInfo: ["aps": ["thread-id": "other"]]) == nil)
}
