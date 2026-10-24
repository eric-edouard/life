import Foundation
import Glance
import SwiftUI

// Compiled into the app, its widgets, and the Watch app and complications: words and marks that need only a
// `RecordingGlance`, never the Pendant's full status.

extension Date {
    /// "14:02" today, "8 Oct 14:02" otherwise.
    nonisolated var moment: String {
        formatted(
            Calendar.current.isDateInToday(self)
                ? .dateTime.hour().minute() : .dateTime.day().month(.abbreviated).hour().minute())
    }
}

nonisolated extension FormatStyle where Self == SystemFormatStyle.DateReference {
    /// "57 seconds ago", "4 minutes ago": the one relative time of the app, widgets and Shortcuts. In a view, keep it
    /// counting with `Text(.currentDate, format: .ago(date))`.
    static func ago(_ date: Date) -> Self {
        .reference(to: date, allowedFields: [.day, .hour, .minute, .second], maxFieldCount: 1)
    }
}

extension Date {
    /// `.ago` as plain text, for words that don't stay on screen (Siri, Shortcuts).
    nonisolated func ago(now: Date) -> String {
        String(now.formatted(.ago(self)).characters)
    }
}

nonisolated extension RecordingGlance.Microphone {
    var word: String {
        switch self {
        case .recording: "Recording"
        case .paused: "Paused"
        case .unrecognized: "Unrecognized state"
        }
    }

    /// Paused is the bare pause glyph of the Pendant screen's switch, never a filled disc: at control, Lock Screen and
    /// complication sizes, tinted or monochrome, `pause.circle.fill` reads as the same full dot as recording.
    var symbol: String {
        switch self {
        case .recording: "record.circle.fill"
        case .paused: "pause.fill"
        case .unrecognized: "questionmark.circle"
        }
    }
}

/// A reading's words and marks, shared by the glance (Watch) and the snapshot (widgets, control,
/// Shortcuts): only a confirmed reading gets the state's own mark, anything older a question mark.
nonisolated extension RecordingGlance.Reading {
    /// "Recording.", "Last known: recording", "Unknown."
    var headline: String {
        switch self {
        case .confirmed(let microphone, _): microphone.word + "."
        case .lastKnown(let microphone, _): "Last known: \(microphone.word.lowercased())"
        case .unknown: "Unknown."
        }
    }

    var symbol: String {
        switch self {
        case .confirmed(let microphone, _): microphone.symbol
        case .lastKnown, .unknown: "questionmark.circle"
        }
    }

    var dot: StatusDot.State {
        switch self {
        case .confirmed(.recording, _): .live
        case .confirmed: .paused
        case .lastKnown, .unknown: .unknown
        }
    }
}

/// The glance in words. Never fresher than its evidence: `now` past one of `changeDates` reads as "last known".
nonisolated extension RecordingGlance {
    /// "Recording.", "Pausing…", "Last known: recording", "Unknown."
    func headline(now: Date) -> String {
        if let pending = pendingRequest(now: now) { return pending == .pause ? "Pausing…" : "Resuming…" }
        return reading(now: now).headline
    }

    /// For the tightest spots: "Rec", "Paused", "…", "?".
    func shortWord(now: Date) -> String {
        if pendingRequest(now: now) != nil { return "…" }
        return switch reading(now: now) {
        case .confirmed(.recording, _): "Rec"
        case .confirmed(.paused, _): "Paused"
        case .confirmed, .lastKnown, .unknown: "?"
        }
    }

    func symbol(now: Date) -> String {
        if pendingRequest(now: now) != nil { return "hourglass" }
        return reading(now: now).symbol
    }

    func dot(now: Date) -> StatusDot.State {
        if pendingRequest(now: now) != nil { return .waiting }
        return reading(now: now).dot
    }

    /// How we know, in a few words; the relative time keeps counting on its own.
    func evidence(now: Date) -> Text {
        if pendingRequest(now: now) != nil { return Text("Waiting for the Pendant to confirm") }
        if let failed { return Text("\(failed == .pause ? "Pause" : "Resume") not confirmed") }
        return switch reading(now: now) {
        case .confirmed(_, let at): Text("Confirmed \(Text(.currentDate, format: .ago(at)))")
        case .lastKnown(_, let at):
            Text("Reported \(at.moment) · \(connected ? "not confirmed since" : "not connected")")
        case .unknown: Text(connected ? "No report yet" : "Not connected")
        }
    }

    /// "Heard sound at 14:02", "Quiet at 14:05": the detector's last word with its time, never "now".
    var soundLine: String? {
        heard.map { "\($0.sound == .hearing ? "Heard sound" : "Quiet") at \($0.at.moment)" }
    }

    /// "82%", "18% low", "~73%" when last known, as the iPhone's Lock Screen widget says it.
    func batteryLine(now: Date) -> String? {
        battery.map { (batteryIsCurrent(now: now) ? "" : "~") + "\($0)%" + (batteryIsLow(now: now) ? " low" : "") }
    }

    /// Everything at once, for VoiceOver: "Recording. Confirmed at 14:02. Heard sound at 14:02. Battery 82%."
    func sentence(now: Date) -> String {
        var parts = [headline(now: now)]
        if let pending = pendingRequest(now: now) {
            parts.append("\(pending == .pause ? "Pause" : "Resume") requested, not confirmed yet.")
        } else if let failed {
            parts.append("\(failed == .pause ? "Pause" : "Resume") not confirmed.")
        }
        switch reading(now: now) {
        case .confirmed(_, let at): parts.append("Confirmed at \(at.moment).")
        case .lastKnown(_, let at):
            parts.append("Reported at \(at.moment), \(connected ? "not confirmed since" : "Pendant not connected").")
        case .unknown: parts.append(connected ? "No report yet." : "Pendant not connected.")
        }
        if let soundLine { parts.append(soundLine + ".") }
        if let battery {
            parts.append(
                batteryIsCurrent(now: now)
                    ? "Battery \(battery)%\(batteryIsLow(now: now) ? ", low" : "")." : "Last known battery \(battery)%."
            )
        }
        return parts.joined(separator: " ")
    }
}

/// The status dot of the widgets, the Watch and the app's badges: red only on a confirmed "recording", a ring when
/// paused, an open arc while waiting, dashed when unknown, so the state never rests on color. It doesn't pulse.
struct StatusDot: View {
    enum State {
        case live
        case paused
        case waiting
        case unknown
    }

    let state: State
    var size: CGFloat = 10

    var body: some View {
        ZStack {
            switch state {
            case .live: Circle().fill(Palette.liveDot)
            case .paused: Circle().strokeBorder(.secondary, lineWidth: 2)
            case .waiting: Circle().trim(from: 0, to: 0.7).stroke(.secondary, lineWidth: 2)
            case .unknown: Circle().strokeBorder(.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [2.5, 2]))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
