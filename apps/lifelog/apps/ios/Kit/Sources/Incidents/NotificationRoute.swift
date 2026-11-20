import Foundation

/// What a push from Life says, read from its payload: where a tapped notification opens the app, or the cards whose
/// notifications go. One mapping for every kind: Life's cards. Incident alerts carry nothing and open the app as it was.
public enum NotificationRoute: Sendable, Equatable {
    /// A new card in Life's inbox: its `pushId`, beside `aps` (the server's `card-push`), and the card as the service
    /// extension kept it (JSON, under `card`: `CardNotification.userInfoKey`) with the Life it was read from (`cardLife`,
    /// `CardNotification.lifeKey`), so a tap shows it before any read.
    case card(String, card: String?, life: String?)
    /// New cards, or a badge: Life's inbox, no card named (thread `life-cards`).
    case inbox
    /// Cards that left Life's inbox (answered anywhere, withdrawn, lapsed): their `pushId`s, a background push never
    /// shown, so never tapped. Their notifications are removed.
    case removed(Set<String>)

    /// The server sends `pushId` or `removed` beside `aps`.
    public init?(userInfo: [AnyHashable: Any]) {
        if let removed = userInfo["removed"] as? [String] {
            self = .removed(Set(removed))
        } else if let pushId = userInfo["pushId"] as? String {
            self = .card(pushId, card: userInfo["card"] as? String, life: userInfo["cardLife"] as? String)
        } else if (userInfo["aps"] as? [AnyHashable: Any])?["thread-id"] as? String == "life-cards" {
            self = .inbox
        } else {
            return nil
        }
    }
}
