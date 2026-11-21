import Capture
import Foundation
import Incidents
import LifeConnector
import OwnerSettings
import ServerAPI
import UIKit
import UserNotifications

/// Local notifications: one per actionable capture incident (decided by `IncidentReducer`), changes made on the
/// Pendant itself (`PendantChangeReducer`). Never asks twice for
/// permission and posts nothing when denied.
final class IncidentNotifier: NSObject {
    /// Marks the notification that shows his answer's result: Life's push removing the answered card spares it.
    static let resultKey = "lifeResult"
    private static let stateKey = "incidentReducer"
    private static let changesKey = "pendantChanges"

    private let center = UNUserNotificationCenter.current()
    private let defaults: UserDefaults
    private var reducer: IncidentReducer
    private var changes: PendantChangeReducer
    /// Opens what a tapped notification points to. Set by the capture store.
    var open: ((NotificationRoute) -> Void)?
    /// A push of Life's cards arrived while the app is in front. Set by the capture store.
    var cardArrived: (() -> Void)?
    /// Answers a card from its notification, the way its screen does, and says how it went. Set by the app delegate.
    /// It goes to the Life the card was found in (`PairedLife`), captured with the card.
    var answer: ((Check, AnswerRequest, PairedLife) async -> (word: String, line: String))?
    /// The card a notification names, as the Life paired now has it (`LifeStore.notifiedCard`), asked before any
    /// answer from it. Set by the app delegate.
    var card: ((_ pushId: String, _ kept: String?, _ life: String?) async -> (check: Check, life: PairedLife)?)?
    /// His Remove of an appointment Life added, from its notification, by its id: whether Life removed it. Set by the app
    /// delegate.
    var removeAppointment: ((String) async -> Bool)?

    /// Life's cards: Reply… (a decision's own words), the only action shown where the expanded notification isn't (the
    /// Watch, a collapsed one); the expanded one adds the card's one-tap answers (`NotificationContent`). Every answer
    /// asks for an unlocked phone or Watch.
    private static let cardCategory = UNNotificationCategory(
        identifier: CardNotification.category, actions: [CardNotification.replyAction], intentIdentifiers: [],
        options: [.hiddenPreviewsShowTitle])
    /// A card it can send from, whole draft as its text (`NotificationService`): Send and Reply…, on the Watch too.
    private static let sendCategory = UNNotificationCategory(
        identifier: CardNotification.sendCategory,
        actions: [CardNotification.sendAction, CardNotification.replyAction],
        intentIdentifiers: [], options: [.hiddenPreviewsShowTitle])

    /// An appointment Life added: Remove (in the background) and Open in Calendar, under the expanded notification.
    private static let calendarCategory = UNNotificationCategory(
        identifier: CalendarNotification.category, actions: CalendarNotification.actions, intentIdentifiers: [])

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        reducer =
            defaults.data(forKey: Self.stateKey).flatMap { try? JSONDecoder().decode(IncidentReducer.self, from: $0) }
            ?? IncidentReducer()
        changes =
            defaults.data(forKey: Self.changesKey).flatMap {
                try? JSONDecoder().decode(PendantChangeReducer.self, from: $0)
            } ?? PendantChangeReducer()
        super.init()
        // Must be set before launch finishes so a response that relaunched the app is delivered.
        center.delegate = self
        center.setNotificationCategories([Self.cardCategory, Self.sendCategory, Self.calendarCategory])
    }

    /// Asks once; iOS never shows the prompt again after the owner answers.
    func requestPermission() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    /// The owner asked lifelog (app, Shortcut or control) to pause or resume: its outcome won't notify.
    func appRequested(_ intent: RecordingIntent) {
        changes.appRequested(intent, at: .now)
        defaults.set(try? JSONEncoder().encode(changes), forKey: Self.changesKey)
    }

    func update(_ status: CaptureStatus, phoneFreeBytes: Int64?) {
        let effects = reducer.reduce(status, phoneFreeBytes: phoneFreeBytes, settings: Settings.shared.alerts)
        if !effects.isEmpty { defaults.set(try? JSONEncoder().encode(reducer), forKey: Self.stateKey) }
        let before = changes
        let changeEffects = changes.reduce(status, now: .now)
        if changes != before { defaults.set(try? JSONEncoder().encode(changes), forKey: Self.changesKey) }
        guard !effects.isEmpty || !changeEffects.isEmpty else { return }
        Task { await perform(effects + changeEffects) }
    }

    private func perform(_ effects: [IncidentEffect]) async {
        for effect in effects {
            switch effect {
            case .post(let alert):
                await add(UNNotificationRequest(identifier: alert.rawValue, content: content(alert), trigger: nil))
            case .schedule(let alert, let at):
                let trigger = UNTimeIntervalNotificationTrigger(
                    timeInterval: max(1, at.timeIntervalSinceNow), repeats: false)
                await add(UNNotificationRequest(identifier: alert.rawValue, content: content(alert), trigger: trigger))
            case .clear(let alert): await Self.remove(alert.rawValue, delivered: true)
            case .unschedule(let alert): await Self.remove(alert.rawValue, delivered: false)
            case .postReconnected(let pages):
                let content = content(.pendantReconnected)
                content.body =
                    switch pages {
                    case 0?: "Everything it recorded is already on this iPhone."
                    case let pages?: "Catching up \(pages) pages."
                    case nil: "Catching up on what it recorded meanwhile."
                    }
                let id = IncidentAlert.pendantReconnected.rawValue
                await add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
            }
        }
    }

    /// These calls are synchronous IPC; on the main actor they once froze a cold launch, so they run off it.
    @concurrent private nonisolated static func remove(_ id: String, delivered: Bool) async {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        if delivered { center.removeDeliveredNotifications(withIdentifiers: [id]) }
    }

    private func add(_ request: UNNotificationRequest) async {
        let settings = await center.notificationSettings()
        guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else { return }
        try? await center.add(request)
    }

    /// The known reason only; a lost connection is never reported as a battery or recording failure.
    private func content(_ alert: IncidentAlert) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        switch alert {
        case .recordingStopped:
            content.title = "Pendant stopped recording"
            content.body = "It reported it isn't recording, and you didn't pause it."
        case .recordingControlFailed:
            content.title = "Pause or resume didn't take effect"
            content.body = "The Pendant didn't confirm the change. Open lifelog to check what it's doing."
        case .storageWriteFailed:
            content.title = "Can't save recordings on this iPhone"
            content.body = "Nothing is deleted from the Pendant until they're saved. Open lifelog for details."
        case .integrity:
            content.title = "Some Pendant pages need a look"
            content.body = "lifelog kept them on the Pendant and stopped clearing past them."
        case .pendantStorageLow:
            content.title = "Pendant storage almost full"
            content.body = "It stops recording when full. Keep it near your iPhone so it can sync."
        case .phoneStorageLow:
            content.title = "iPhone storage almost full"
            content.body = "lifelog needs space to save new recordings."
        case .noContact:
            content.title = "No sync with your Pendant for a day"
            content.body = "Recordings stay on the Pendant until it syncs. Open lifelog near your Pendant."
        case .batteryLow:
            content.title = "Pendant battery low"
            content.body = "Charge it soon. It stops recording when the battery runs out."
        case .recordingPausedOnPendant:
            content.title = "Recording paused on your Pendant"
            content.body = "It reported it isn't recording. Hold its button about 2 s to resume."
        case .recordingResumedOnPendant:
            content.title = "Recording resumed on your Pendant"
            content.body = "It reported it's recording again."
        case .pendantDisconnected:
            // Its Bluetooth can stop advertising until restarted (docs/pendant.md, Button and lights). A restart keeps
            // every page; purple is a factory reset.
            content.title = "Pendant not answering"
            content.body =
                "Away from your phone, it keeps recording. With you, restart it (never through purple): hold until red, release, hold until off, press. It keeps every recording."
        case .pendantReconnected:
            content.title = "Pendant reconnected"
        }
        return content
    }
}

extension IncidentNotifier: UNUserNotificationCenterDelegate {
    /// On the main actor, as `didReceive`: a card's push also has the inbox read again.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        switch NotificationRoute(userInfo: notification.request.content.userInfo) {
        case nil, .appointment?: break
        default: cardArrived?()
        }
        return [.banner, .list, .sound]
    }

    /// On the main actor: iOS calls this method's completion when it returns, and UIKit throws (a crash) when that
    /// happens off the main thread.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let request = response.notification.request
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier:
            NotificationRoute(userInfo: request.content.userInfo).map { open?($0) }
        case UNNotificationDismissActionIdentifier: break
        case CalendarNotification.remove, CalendarNotification.openInCalendar: await calendar(response)
        default: await answer(response)
        }
    }

    /// An appointment's Open in Calendar (the app is in front: Calendar on its day), or its Remove, in the background:
    /// the notification is replaced by how it went, and a tap still opens its sheet. With no appointment kept (Life's
    /// read failed when it came), nothing is removed: it says so.
    private func calendar(_ response: UNNotificationResponse) async {
        let request = response.notification.request
        let kept = (request.content.userInfo[CalendarNotification.appointmentKey] as? String)
            .flatMap { try? Appointment.parsed($0) }
        guard response.actionIdentifier == CalendarNotification.remove else {
            if let url = kept?.calendarURL { await UIApplication.shared.open(url) }
            return
        }
        let awake = Awake()
        awake.id = UIApplication.shared.beginBackgroundTask(withName: "appointment remove") { awake.end() }
        defer { awake.end() }
        var isRemoved = false
        if let kept, let removeAppointment { isRemoved = await removeAppointment(kept.id) }
        let words = CalendarNotification.afterRemove(isRemoved: isRemoved, line: kept?.line() ?? request.content.body)
        let content = UNMutableNotificationContent()
        (content.title, content.body) = words
        content.userInfo = request.content.userInfo
        content.categoryIdentifier = isRemoved ? "" : request.content.categoryIdentifier
        content.interruptionLevel = .passive
        try? await center.add(UNNotificationRequest(identifier: request.identifier, content: content, trigger: nil))
    }

    /// A card answered from its notification, with the app in the background: the same answer as its screen's, then
    /// the notification is replaced by how it went, in the result screen's words.
    private func answer(_ response: UNNotificationResponse) async {
        let request = response.notification.request
        // Never the kept card as it is: it may be another pairing's (`CardNotification.card`).
        let found: (check: Check, life: PairedLife)? =
            if case .card(let pushId, let kept, let life)? = NotificationRoute(userInfo: request.content.userInfo) {
                await card?(pushId, kept, life)
            } else { nil }
        let check = found?.check
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        let awake = Awake()
        awake.id = UIApplication.shared.beginBackgroundTask(withName: "card answer") { awake.end() }
        defer { awake.end() }
        let result: (word: String, line: String)
        if let found, let check, let answer,
            let answering = CardNotification.answer(
                response.actionIdentifier, typed: typed, to: check, in: request.content.categoryIdentifier,
                asksFaceID: AppGroup.asksFaceIDToSend)
        {
            result = await answer(check, answering, found.life)
        } else {
            result = ("Open the card to answer.", "This answer can't be given from the notification.")
        }
        let content = UNMutableNotificationContent()
        content.title = result.word
        content.subtitle = check?.title ?? ""
        content.body = result.line
        // Still opens its card when tapped; the card itself is not kept, so it offers no answers again.
        content.userInfo = request.content.userInfo.filter { $0.key as? String != CardNotification.userInfoKey }
            .merging([Self.resultKey: true]) { $1 }
        content.threadIdentifier = request.content.threadIdentifier
        content.interruptionLevel = .passive
        try? await center.add(UNNotificationRequest(identifier: request.identifier, content: content, trigger: nil))
    }
}
