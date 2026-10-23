import Foundation
import Testing

@testable import Incidents

/// Payloads as `apps/voice/src/naming-queue.ts` and `IncidentNotifier.announce` send them.
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
