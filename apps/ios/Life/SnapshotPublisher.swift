import Capture
import Foundation
import Glance
import Incidents
import OwnerSettings
import WidgetKit

/// Shares the Pendant's state with widgets, the control and Shortcuts (`PendantSnapshot` in the app group), and with
/// the Watch (`RecordingGlance`). Writes only meaningful changes, and spends widget reloads only
/// on what they show.
final class SnapshotPublisher {
    let watch = WatchRelay()

    /// ponytail: newer evidence of an unchanged state reloads widgets at most this often (reloads are budgeted);
    /// in between they say "last known". Tune if the owner finds them too pessimistic.
    private static let evidenceReloadStep: TimeInterval = 15 * 60

    private var written = PendantSnapshot.load()
    /// What widgets last reloaded with.
    private var shown = PendantSnapshot.load()
    private var shownAt = Date.distantPast

    func publish(_ status: CaptureStatus, now: Date = .now) {
        let snapshot = PendantSnapshot(status, previous: written)
        let glance = RecordingGlance(
            snapshot, sound: status.soundActivity, lowBatteryPercent: Settings.shared.alerts.lowBatteryPercent, now: now
        )
        watch.send(glance, now: now)
        guard snapshot.isWorthWriting(over: written) else { return }
        snapshot.save()
        written = snapshot
        let evidenceDue =
            snapshot.refreshesEvidence(over: shown, now: now)
            && now.timeIntervalSince(shownAt) >= Self.evidenceReloadStep
        guard snapshot.changesDisplay(from: shown, now: now) || evidenceDue else { return }
        shown = snapshot
        shownAt = now
        WidgetCenter.shared.reloadTimelines(ofKind: PendantSnapshot.widgetKind)
        ControlCenter.shared.reloadAllControls()
    }
}
