import Foundation
import Glance
import Incidents

/// Words shared by Shortcuts, widgets and the control. Each says only what the evidence supports, with the glance's
/// marks (`RecordingGlance.Reading`): an old or unlinked report is "last known" with a question mark.
nonisolated extension PendantSnapshot {
    /// The glance the Watch gets (`RecordingGlance`), so the widgets' headline, symbol and dot are decided once
    /// (`GlanceCopy`). Battery and sound play no part in those three.
    private func glance(now: Date) -> RecordingGlance {
        RecordingGlance(self, sound: nil, lowBatteryPercent: 0, now: now)
    }

    /// What leads: "Recording.", "Pausing…", "Last known: recording", "Unknown."
    func headline(now: Date) -> String { glance(now: now).headline(now: now) }

    func symbol(now: Date) -> String { glance(now: now).symbol(now: now) }

    func dot(now: Date) -> StatusDot.State { glance(now: now).dot(now: now) }

    /// One sentence for Siri and Shortcuts: "Recording — confirmed 4 seconds ago · battery 82%".
    func sentence(now: Date) -> String {
        let state: String =
            switch recording(now: now) {
            case .confirmed(let microphone, let at):
                "\(microphone.word) — confirmed \(at.ago(now: now))"
            case .lastKnown(let microphone, let at):
                "Last known: \(microphone.word.lowercased()) at \(at.moment)\(link == .connected ? "" : " — Pendant not connected")"
            case .unknown:
                link == .connected
                    ? "Unknown — waiting for the Pendant's first report" : "Unknown — Pendant not connected"
            }
        let pending = pendingRequest(now: now).map {
            $0 == .pause ? "Pause requested, not confirmed yet. " : "Resume requested, not confirmed yet. "
        }
        return (pending ?? "") + state + (batteryPhrase(now: now).map { " · \($0)" } ?? "")
    }

    /// "battery 82%", "battery 82%, charging", or "battery 82% at 14:02" when that's old news.
    func batteryPhrase(now: Date) -> String? {
        guard let battery else { return nil }
        let fresh = batteryIsCurrent(now: now)
        let charging = fresh && charging?.value == true ? ", charging" : ""
        return "battery \(battery.value)%" + (fresh ? charging : " at \(battery.at.moment)")
    }
}
