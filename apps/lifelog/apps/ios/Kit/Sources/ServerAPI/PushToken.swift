import Foundation

/// The phone's push token, kept until the paired server has it. iOS hands it over at every launch, often before pairing
/// or offline; runs send it (`Driver.run`) until a server says yes, then again after the next launch (the server drops
/// a token APNs refuses, and can't ask for it), for a new token, or for another server.
public enum PushToken {
    private static let tokenKey = "pushToken"
    /// "<server> <token>" the server confirmed: naming the server, pairing another one sends again with no reset.
    private static let sentKey = "pushTokenSent"

    /// Keeps iOS's newest token (hex) for the next run to send, even one the server had.
    public static func keep(_ token: Data, in defaults: UserDefaults = .standard) {
        defaults.set(token.map { String(format: "%02x", $0) }.joined(), forKey: tokenKey)
        defaults.removeObject(forKey: sentKey)
    }

    /// Sends the kept token unless this server already has it. Returns the `push.device_token` event's fields when it
    /// tried (the outcome and the token's first characters, as the server's `apns.sent` shows them), nil when nothing
    /// was due. A failure is sent again by the next run.
    public static func send(with client: ServerClient, in defaults: UserDefaults = .standard) async -> [String: String]?
    {
        guard let token = defaults.string(forKey: tokenKey), let server = client.server() else { return nil }
        let sent = "\(server.absoluteString) \(token)"
        guard defaults.string(forKey: sentKey) != sent else { return nil }
        let ok = (try? await client.setNotificationPushToken(token)) != nil
        if ok { defaults.set(sent, forKey: sentKey) }
        return ["outcome": ok ? "sent" : "failed", "token": String(token.prefix(8))]
    }
}
