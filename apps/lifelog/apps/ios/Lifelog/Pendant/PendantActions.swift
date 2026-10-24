import Capture
import Incidents
import Library
import OwnerSettings
import ServerAPI
import SourceStore
import SwiftUI
import Timeline

/// What the Pendant screen's controls do, against the stores. References and methods rather than closures, so the
/// screen compares equal to itself while nothing it shows changed.
struct PendantActions {
    let capture: CaptureStore
    let sync: SyncStore
    let permissions: PermissionsStore

    func control(_ control: HeroReading.Control) {
        Task {
            switch control {
            case .pause: await capture.pause()
            case .resume: await capture.resume()
            case .reconnect: await capture.reconnect()
            case .none: break
            }
        }
    }

    func recover(_ recovery: Recovery) {
        switch recovery {
        case .openSettings:
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case .pair, .reconnect: Task { await capture.reconnect() }
        case .syncNow: Task { await capture.syncNow() }
        case .resume: Task { await capture.resume() }
        }
    }

    /// Durably records the owner's split at that moment; returns why it wasn't saved.
    func split(at date: Date) async -> String? {
        await sync.perform(.split(at: date))
    }

    /// Settles every incident a card shows, each as its own card would.
    func resolve(_ ids: [IncidentItem.ID], _ resolution: IncidentResolution) async throws {
        try await capture.resolve(capture.openIncidents.filter { ids.contains($0.id) }, keeping: resolution)
    }

    func allowNotifications() {
        Task {
            await capture.notifier.requestPermission()
            await permissions.refresh()
        }
    }

    func dismissNotificationsInvite() { Settings.shared.notificationsInviteDismissed = true }

    func refresh() async { await capture.syncNow() }

}
