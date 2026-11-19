import LifeConnector
import UIKit
import UserNotifications
import UserNotificationsUI

/// A card's expanded notification: iOS shows the card's words (written by `NotificationService`), and this gives it the
/// card's own answers as buttons (`CardNotification.actions`). It reads nothing from Life: the card came with the
/// notification. A tapped button is answered by the app (`IncidentNotifier`).
final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = .zero
    }

    func didReceive(_ notification: UNNotification) {
        guard let check = CardNotification.card(in: notification.request.content.userInfo) else { return }
        extensionContext?.notificationActions = CardNotification.actions(check)
    }
}
