import Foundation

/// What a push from Life says, read from its payload: where a tapped notification opens the app, or the cards whose
/// notifications go. One mapping for every kind Life sends (`core/push.ts`): its cards, the appointments it added, and
/// the spoken asks it heard, answered or could not do. Incident alerts carry nothing and open the app as it was.
public enum NotificationRoute: Sendable, Equatable {
    /// A new card in Life's inbox (`kind` `card.new`): its `pushId`, beside `aps` (the server's `card-push`), and the
    /// card as the service extension kept it (JSON, under `card`: `CardNotification.userInfoKey`) with the Life it was
    /// read from (`cardLife`, `CardNotification.lifeKey`), so a tap shows it before any read.
    case card(String, card: String?, life: String?)
    /// An appointment Life added to his calendar (`kind` `calendar.added`, category `life.calendar`): its `pushId`, which
    /// `read_appointments` takes; a tap opens its event sheet.
    case appointment(String)
    /// Life's inbox, no card named: a spoken ask heard, answered or failed (`thread.heard`, `thread.answered`,
    /// `thread.failed`), whose one id makes each replace the last.
    case inbox
    /// Cards that left Life's inbox (answered anywhere, withdrawn, lapsed): their `pushId`s, a background push never
    /// shown, so never tapped (`kind` `cards.removed`). Their notifications are removed.
    case removed(Set<String>)

    /// The server sends `kind` and `pushId`, or `removed`, beside `aps`. A push that names nothing to open
    /// (`voice.waiting`, `voice.ready`) reads as nil: it opens the app as it was.
    public init?(userInfo: [AnyHashable: Any]) {
        let kind = userInfo["kind"] as? String
        if let removed = userInfo["removed"] as? [String] {
            self = .removed(Set(removed))
        } else if kind == "calendar.added", let pushId = userInfo["pushId"] as? String {
            self = .appointment(pushId)
        } else if kind?.hasPrefix("thread.") == true {
            // A spoken ask heard, answered or not done (one id, so the answer replaces "heard"): Life's thread.
            self = .inbox
        } else if let pushId = userInfo["pushId"] as? String {
            self = .card(pushId, card: userInfo["card"] as? String, life: userInfo["cardLife"] as? String)
        } else if (userInfo["aps"] as? [AnyHashable: Any])?["thread-id"] as? String == "life-cards" {
            self = .inbox
        } else {
            return nil
        }
    }
}
