import Foundation
import Testing

@testable import Incidents

@Test func otherPayloadsOpenNothing() {
    #expect(NotificationRoute(userInfo: [:]) == nil)
    #expect(NotificationRoute(userInfo: ["lifelog": "processing"]) == nil)
    // An alert about nothing to name (`voice.waiting`): the Pendant's audio waits, nothing to open.
    #expect(
        NotificationRoute(userInfo: ["aps": ["alert": ["title": "Open lifelog", "body": "Audio waiting."]]]) == nil)
}

@Test func aNewCardOpensItsCardAndSeveralOpenTheInbox() {
    // As `apns-request.ts` sends it: the kind, the card's id, and no count (the badge is the phone's own read).
    let one: [AnyHashable: Any] = [
        "aps": ["alert": ["title": "Life", "body": "New card"], "thread-id": "life-cards", "category": "life.card"],
        "kind": "card.new", "pushId": "9f2c41d07ab35e68",
    ]
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
        "aps": ["content-available": 1], "kind": "cards.removed",
        "removed": ["9f2c41d07ab35e68", "0123456789abcdef"],
    ]
    #expect(NotificationRoute(userInfo: gone) == .removed(["9f2c41d07ab35e68", "0123456789abcdef"]))
}

@Test func anAppointmentLifeAddedOpensItsEventSheet() {
    // As lifelog's `apnsRequestOf` sends it: `kind` and `pushId` beside `aps`, category `life.calendar`, no count.
    let added: [AnyHashable: Any] = [
        "aps": ["alert": ["title": "Life", "body": "Added to your calendar"], "category": "life.calendar"],
        "kind": "calendar.added", "pushId": "0123456789abcdef",
    ]
    #expect(NotificationRoute(userInfo: added) == .appointment("0123456789abcdef"))
}

@Test func aSpokenAsksReplyOpensTheThreadNeverACard() {
    // Every `thread.` kind — `thread.heard`, `thread.answered`, `thread.failed`: its `pushId` only collapses the last
    // into the newest; no category.
    for kind in ["thread.heard", "thread.answered", "thread.failed"] {
        let reply: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Life answered", "body": "Open Life to read it."]],
            "kind": kind, "pushId": "0123456789abcdef",
        ]
        #expect(NotificationRoute(userInfo: reply) == .inbox, "\(kind)")
    }
}

@Test func aReadyBackgroundPushOpensNothing() {
    // `voice.ready` only asks the app to collect what is ready: a background push, never shown, never tapped.
    #expect(NotificationRoute(userInfo: ["aps": ["content-available": 1], "kind": "voice.ready"]) == nil)
}
