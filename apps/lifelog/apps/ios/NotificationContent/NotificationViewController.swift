import LifeConnector
import LocalAuthentication
import SwiftUI
import UIKit
import UserNotifications
import UserNotificationsUI

/// A card's expanded notification: iOS shows the card's words (written by `NotificationService`); this shows a draft
/// whole, as the card's screen does, and gives the card's own answers as buttons (`CardNotification.actions`). It reads
/// nothing from Life: the card came with the notification. Send goes on only after Face ID or his passcode at that tap;
/// every answer is then given by the app (`IncidentNotifier`).
final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    private var check: Check?

    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = .zero
    }

    func didReceive(_ notification: UNNotification) {
        guard let check = CardNotification.card(in: notification.request.content.userInfo) else { return }
        self.check = check
        extensionContext?.notificationActions = CardNotification.actions(check)
        if let draft = check.draft { show(DraftBlock(draft: draft).padding(16)) }
    }

    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        guard let check else { return completion(.dismissAndForwardAction) }
        Task {
            let proven = await CardNotification.mayAnswer(response.actionIdentifier, of: check) {
                await Self.askOwner()
            }
            completion(proven ? .dismissAndForwardAction : .doNotDismiss)
        }
    }

    /// Face ID, or his passcode, every time: an unlocked phone is not enough to send in his name.
    private static func askOwner() async -> Bool {
        (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Send this message"))
            ?? false
    }

    private func show(_ content: some View) {
        let host = UIHostingController(rootView: content)
        addChild(host)
        host.view.backgroundColor = .clear
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        preferredContentSize = host.sizeThatFits(in: CGSize(width: view.bounds.width, height: .greatestFiniteMagnitude))
    }
}
