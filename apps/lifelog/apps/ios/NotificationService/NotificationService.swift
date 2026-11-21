import Foundation
import LifeConnector
import UserNotifications

/// Rewrites a card's push ("Life · 1 new card" and its `pushId`, `host/card-push.ts`) with the card's own words, read
/// from Life (`read_inbox`) with the app's pairing (`LifeToken`). Anything else, or any failure (offline, the Mac
/// asleep, the card answered meanwhile, the time iOS gives running out), shows the push as it came: it still opens its
/// card (`NotificationRoute`, which reads the same `pushId`). An appointment Life added (`life.calendar`) is written the
/// same way from `read_appointments`.
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
        // Read from the Life paired now and no other, and kept with that Life's origin: a tap after another pairing never
        // takes it as this one's.
        let paired = LifeToken().load()?.endpoint.origin
        if request.content.categoryIdentifier == CalendarNotification.category {
            Task {
                let read = try? await Self.api.readAppointment(.pushId(pushId), at: paired)
                deliver { $0.written(byAppointment: read) }
            }
            return
        }
        Task {
            let read = await CardNotification.read(
                pushId: pushId, pairedWith: paired, asksFaceID: AppGroup.asksFaceIDToSend,
                readPush: { try await Self.api.readInbox(pushId: pushId, at: $0) })
            finish(with: read?.card, life: read?.life)
        }
    }

    override func serviceExtensionTimeWillExpire() { finish(with: nil, life: nil) }

    /// Delivers once, whichever of the read and the time limit comes first: the card's words, or the push as it came.
    private func finish(with card: CardNotification?, life: URL?) {
        deliver { original in card.map { original.written(by: $0, life: life) } ?? original }
    }

    /// Delivers the push as `write` makes it of what came, once; the time limit delivers it as it came.
    private func deliver(_ write: (UNNotificationContent) -> UNNotificationContent) {
        guard
            let held = lock.withLock({ () -> Pending? in
                defer { pending = nil }
                return pending
            })
        else { return }
        held.deliver(write(held.original))
    }
}

extension UNNotificationContent {
    /// An appointment's push with its words ("Added to your calendar", then its title, day and time), the appointment
    /// kept for Remove and Open in Calendar; as it came when Life's read failed.
    nonisolated fileprivate func written(byAppointment read: String?) -> UNNotificationContent {
        guard let read, let appointment = try? Appointment.parsed(read),
            let content = mutableCopy() as? UNMutableNotificationContent
        else { return self }
        content.title = CalendarNotification.added
        content.body = appointment.line()
        content.userInfo[CalendarNotification.appointmentKey] = read
        return content
    }

    /// This push with the card's words, its matter's thread and the card kept for the expanded view and the answer.
    nonisolated fileprivate func written(by card: CardNotification, life: URL?) -> UNNotificationContent {
        guard let content = mutableCopy() as? UNMutableNotificationContent else { return self }
        content.title = card.title
        content.subtitle = card.subtitle
        content.body = card.body
        content.threadIdentifier = card.thread
        content.categoryIdentifier = card.category
        content.userInfo[CardNotification.userInfoKey] = card.card
        content.userInfo[CardNotification.lifeKey] = life?.absoluteString
        return content
    }
}
