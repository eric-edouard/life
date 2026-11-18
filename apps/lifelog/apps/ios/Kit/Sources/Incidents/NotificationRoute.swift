import Foundation

/// Where a tapped notification opens the app, read from its payload. One mapping for every kind: the server's alert
/// (the morning push of voices to name) and a press's words. Incident alerts carry nothing and open the app as it was.
public enum NotificationRoute: Sendable, Equatable {
    /// "Who's this?", from the morning push of voices to name (its payload key is `peopleDigest`).
    case peopleDigest
    /// A new card in Life's inbox: its `pushId`, beside `aps` (the server's `card-push`).
    case card(String)
    /// New cards, or a badge: Life's inbox, no card named (thread `life-cards`).
    case inbox
    /// One press's words, ready to ask Claude or ChatGPT (`ButtonActions`; payload key `quickQuestion`).
    case quickQuestion(String)

    /// The server sends `peopleDigest` or `pushId` beside `aps`.
    public init?(userInfo: [AnyHashable: Any]) {
        if let pushId = userInfo["pushId"] as? String {
            self = .card(pushId)
        } else if (userInfo["aps"] as? [AnyHashable: Any])?["thread-id"] as? String == "life-cards" {
            self = .inbox
        } else if userInfo["peopleDigest"] != nil {
            self = .peopleDigest
        } else if let words = userInfo["quickQuestion"] as? String {
            self = .quickQuestion(words)
        } else {
            return nil
        }
    }
}
