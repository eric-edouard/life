import Capture
import Foundation
import Incidents
import OwnerSettings
import ServerAPI
import UserNotifications

/// Local notifications: one per actionable capture incident (decided by `IncidentReducer`), changes made on the
/// Pendant itself (`PendantChangeReducer`), and what the Pendant's button asked (`ButtonActions`). Never asks twice for
/// permission and posts nothing when denied.
final class IncidentNotifier: NSObject {
    private static let stateKey = "incidentReducer"
    private static let quickQuestionCategory = "quickQuestion"
    private static let changesKey = "pendantChanges"

    private let center = UNUserNotificationCenter.current()
    private let defaults: UserDefaults
    private var reducer: IncidentReducer
    private var changes: PendantChangeReducer
    /// Opens what a tapped notification points to. Set by the capture store.
    var open: ((NotificationRoute) -> Void)?

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
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.quickQuestionCategory,
                actions: QuickQuestion.App.allCases.map {
                    UNNotificationAction(identifier: $0.rawValue, title: $0.name, options: .foreground)
                }, intentIdentifiers: [])
        ])
    }

    /// Asks once; iOS never shows the prompt again after the owner answers.
    func requestPermission() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
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

    /// One press's words, in the background: a tap opens them in lifelog, Claude and ChatGPT are its actions.
    func quickQuestion(_ words: String, id: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Quick question to AI"
        content.body = words
        content.categoryIdentifier = Self.quickQuestionCategory
        content.userInfo = ["quickQuestion": words]
        await add(UNNotificationRequest(identifier: "press-\(id)", content: content, trigger: nil))
    }

    /// A press that came to nothing, and why.
    func pressFailed(_ reason: String, id: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Quick question to AI failed"
        content.body = reason
        await add(UNNotificationRequest(identifier: "press-\(id)", content: content, trigger: nil))
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
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// On the main actor: iOS calls this method's completion when it returns, and UIKit throws (a crash) when that
    /// happens off the main thread.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        if let words = userInfo["quickQuestion"] as? String,
            let app = QuickQuestion.App(rawValue: response.actionIdentifier)
        {
            return await ButtonActions.ask(app, words)
        }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
            let route = NotificationRoute(userInfo: userInfo)
        else { return }
        open?(route)
    }
}
