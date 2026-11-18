import Foundation

/// Where a tapped notification opens the app, read from its payload. One mapping for every kind: Life's cards. Incident alerts carry nothing and open the app as it was.
public enum NotificationRoute: Sendable, Equatable {
    /// A new card in Life's inbox: its `pushId`, beside `aps` (the server's `card-push`).
    case card(String)
    /// New cards, or a badge: Life's inbox, no card named (thread `life-cards`).
    case inbox

    /// The server sends `pushId` beside `aps`.
    public init?(userInfo: [AnyHashable: Any]) {
        if let pushId = userInfo["pushId"] as? String {
            self = .card(pushId)
        } else if (userInfo["aps"] as? [AnyHashable: Any])?["thread-id"] as? String == "life-cards" {
            self = .inbox
        } else {
            return nil
        }
    }
}
