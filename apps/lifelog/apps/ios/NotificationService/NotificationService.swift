import Foundation
import LifeConnector
import UserNotifications

/// Rewrites a card's push ("Life · 1 new card" and its `pushId`, `host/card-push.ts`) with the card's own words, read
/// from Life (`read_inbox`) with the app's pairing (`LifeToken`). Anything else, or any failure (offline, the Mac
/// asleep, the card answered meanwhile, the time iOS gives running out), shows the push as it came: it still opens its
/// card (`NotificationRoute`, which reads the same `pushId`).
nonisolated final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    /// One session for the process: several pushes at once make one refresh.
    private static let api = MCPLifeAPI(client: MCPClient(session: LifeSession(store: LifeToken())))

    private struct Pending {
        let deliver: (UNNotificationContent) -> Void
        let original: UNNotificationContent
    }
    /// The push waiting for its words, behind `lock`: the read and iOS's time limit end on any thread.
    private let lock = NSLock()
    private var pending: Pending?

    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let pushId = request.content.userInfo["pushId"] as? String else {
            return contentHandler(request.content)
        }
        lock.withLock { pending = Pending(deliver: contentHandler, original: request.content) }
        Task {
            finish(with: try? CardNotification.of(pushId: pushId, inbox: await Self.api.readInbox()))
        }
    }

    override func serviceExtensionTimeWillExpire() { finish(with: nil) }

    /// Delivers once, whichever of the read and the time limit comes first: the card's words, or the push as it came.
    private func finish(with card: CardNotification?) {
        guard
            let held = lock.withLock({ () -> Pending? in
                defer { pending = nil }
                return pending
            })
        else { return }
        held.deliver(card.map { held.original.written(by: $0) } ?? held.original)
    }
}

extension UNNotificationContent {
    /// This push with the card's words, its matter's thread and the card kept for the expanded view and the answer.
    nonisolated fileprivate func written(by card: CardNotification) -> UNNotificationContent {
        guard let content = mutableCopy() as? UNMutableNotificationContent else { return self }
        content.title = card.title
        content.subtitle = card.subtitle
        content.body = card.body
        content.threadIdentifier = card.thread
        content.userInfo["card"] = card.card
        return content
    }
}
