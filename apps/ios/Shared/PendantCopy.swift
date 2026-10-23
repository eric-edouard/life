import Foundation
import Incidents

/// Words shared by Shortcuts, widgets and the control. Each says only what the evidence supports, with the glance's
/// marks (`RecordingGlance.Reading`): an old or unlinked report is "last known" with a question mark.
nonisolated extension PendantSnapshot {
    /// What leads: "Recording.", "Pausing…", "Last known: recording", "Unknown."
    func headline(now: Date) -> String {
        if let pending = pendingRequest(now: now) { return pending == .pause ? "Pausing…" : "Resuming…" }
        return recording(now: now).headline
    }

    func symbol(now: Date) -> String {
        if pendingRequest(now: now) != nil { return "hourglass" }
        return recording(now: now).symbol
    }

    func dot(now: Date) -> StatusDot.State {
        if pendingRequest(now: now) != nil { return .waiting }
        return recording(now: now).dot
    }

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
