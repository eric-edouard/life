import LifeConnector
import LocalAuthentication
import SwiftUI
import UIKit
import UserNotifications
import UserNotificationsUI

/// A card's expanded notification: iOS shows the card's words (written by `NotificationService`); this shows a draft
/// whole, as the card's screen does, and gives the card's own answers as buttons (`CardNotification.actions`). It reads
/// nothing from Life: the card came with the notification. Its chat's head opens the chat in its app (the extension
/// takes taps: `UNNotificationExtensionUserInteractionEnabled`). Send waits for Face ID or his passcode at that tap when his
/// setting asks for it; every answer is then given by the app (`IncidentNotifier`).
final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    /// The one draft view: iOS calls `didReceive` again when another card of the same thread arrives while it is open.
    private let draft = UIHostingController<AnyView?>(rootView: nil)

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(draft)
        draft.view.backgroundColor = .clear
        draft.view.frame = view.bounds
        draft.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(draft.view)
        draft.didMove(toParent: self)
        preferredContentSize = .zero
    }

    func didReceive(_ notification: UNNotification) {
        let check = CardNotification.card(in: notification.request.content.userInfo)
        extensionContext?.notificationActions = check.map(CardNotification.actions) ?? []
        draft.rootView = check.flatMap { DraftBlock(check: $0) }.map {
            AnyView(
                $0.padding(16).environment(
                    \.openURL,
                    OpenURLAction { [weak self] url in
                        self?.openChat(url)
                        return .handled
                    }))
        }
        preferredContentSize =
            check?.draft == nil
            ? .zero : draft.sizeThatFits(in: CGSize(width: view.bounds.width, height: .greatestFiniteMagnitude))
    }

    /// The chat in its app; when the system refuses the open from here, the card's own app instead, where the card
    /// holds the same link.
    private func openChat(_ url: URL) {
        extensionContext?.open(url) { [weak self] opened in
            if !opened { Task { @MainActor in self?.extensionContext?.performNotificationDefaultAction() } }
        }
    }

    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        Task {
            let proven = await CardNotification.isAnswerAllowed(response.actionIdentifier) {
                await AppGroup.asksFaceIDToSend ? Self.askOwner() : true
            }
            completion(proven ? .dismissAndForwardAction : .doNotDismiss)
        }
    }

    /// Face ID, or his passcode, every time it is asked.
    private static func askOwner() async -> Bool {
        (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Send this message"))
            ?? false
    }
}
