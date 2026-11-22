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

    /// What came of it: the condition it was for gone ("Reconnected", "Synced"), or still there. Opening iOS Settings
    /// has no answer here: the row changes when he comes back.
    func recover(_ recovery: Recovery) async -> RowState {
        switch recovery {
        case .openSettings:
            if let url = URL(string: UIApplication.openSettingsURLString) { _ = await UIApplication.shared.open(url) }
            return .known
        case .reconnect: await capture.reconnect()
        case .syncNow: await capture.syncNow()
        }
        var isStill = CaptureCondition.evaluate(capture.status, context: capture.context, now: .now).contains {
            $0.recovery == recovery
        }
        #if DEBUG
            isStill = isStill || LifeFixture.refuses("reconnect")
        #endif
        if isStill { return .refused("Still not fixed. Try again in a moment.") }
        return .done(recovery == .reconnect ? "Reconnected" : "Synced")
    }

    /// Settles every incident a card shows, each as its own card would.
    func resolve(_ ids: [IncidentItem.ID], _ resolution: IncidentResolution) async throws {
        try await capture.resolve(capture.openIncidents.filter { ids.contains($0.id) }, keeping: resolution)
    }

    func refresh() async { await capture.syncNow() }
}
