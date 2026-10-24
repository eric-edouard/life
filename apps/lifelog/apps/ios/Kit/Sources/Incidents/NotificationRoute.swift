import Foundation

/// Where a tapped notification opens the app, read from its payload. One mapping for every kind: the server's alert
/// (the morning push of voices to name) and a press's words. Incident alerts carry nothing and open the app as it was.
public enum NotificationRoute: Sendable, Equatable {
    /// "Who's this?", from the morning push of voices to name (its payload key is `peopleDigest`).
    case peopleDigest
    /// One press's words, ready to ask Claude or ChatGPT (`ButtonActions`; payload key `quickQuestion`).
    case quickQuestion(String)

    /// The server sends `peopleDigest` beside `aps`.
    public init?(userInfo: [AnyHashable: Any]) {
        if userInfo["peopleDigest"] != nil {
            self = .peopleDigest
        } else if let words = userInfo["quickQuestion"] as? String {
            self = .quickQuestion(words)
        } else {
            return nil
        }
    }
}
