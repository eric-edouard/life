import Foundation
import Library
import Timeline

extension ServerClient {
    // MARK: Health

    /// Posts a report the `Health` outbox already encoded: `diagnostics` or `health/heartbeat`.
    public func postReport(_ path: String, json body: Data) async throws {
        var request = try request(path, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await send(request, body: body)
    }

    /// The app's push token, for the server's silent pushes and alerts (the morning's voices to name).
    public func setNotificationPushToken(_ token: Data) async throws {
        struct Body: Encodable { var token: String }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        _ = try await send("notifications/push-token", method: "PUT", Body(token: hex))
    }
}
