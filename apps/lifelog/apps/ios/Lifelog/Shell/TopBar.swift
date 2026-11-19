import Capture
import Glance
import Incidents
import OwnerSettings
import SwiftUI

/// The bar over every screen, as the system's own: Settings at the leading edge (a page's back button is the stack's), the
/// screen's name in the middle, the Pendant's pill at the trailing edge. Real toolbar items, so the system can move them
/// (into a side column on a foldable) and gives them their glass.
private struct ShellBar: ViewModifier {
    let label: String
    let hasSettings: Bool
    let hasPendant: Bool

    @Environment(AppRouter.self) private var router

    func body(content: Content) -> some View {
        content
            .navigationTitle(label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if hasSettings {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            router.sheet = .settings
                        } label: {
                            Image(systemName: "slider.horizontal.3")
                        }
                        .accessibilityLabel("Settings")
                        .accessibilityIdentifier("top.settings")
                    }
                }
                if hasPendant { ToolbarItem(placement: .topBarTrailing) { PendantPill { router.sheet = .pendant } } }
            }
    }
}

extension View {
    func shellBar(_ label: String, hasSettings: Bool = true, hasPendant: Bool = true) -> some View {
        modifier(ShellBar(label: label, hasSettings: hasSettings, hasPendant: hasPendant))
    }
}

/// The Pendant as a pill: what it is doing at a glance, or the one thing that needs him.
struct PendantPill: View {
    let open: () -> Void

    @Environment(CaptureStore.self) private var capture

    private struct Face {
        var symbol: String
        var text: String?
        var badge: Int?
        var spoken: String
    }

    var body: some View {
        let face = face
        Button(action: open) {
            HStack(spacing: 8) {
                Text("Pendant").font(.lead)
                if let text = face.text { Text(text).font(.monoTime).foregroundStyle(Palette.flag) }
                Image(systemName: face.symbol).font(.system(size: 17, weight: .medium))
                    .overlay(alignment: .topTrailing) {
                        if let badge = face.badge {
                            CountBadge(count: badge).offset(x: 9, y: -9)
                        }
                    }
            }
            .foregroundStyle(Palette.fg)
        }
        .accessibilityLabel("Pendant, \(face.spoken)")
        .accessibilityIdentifier("top.pendant")
    }

    /// One thing, the most pressing first: something that needs him, a low battery, out of reach, sending, paused, recording.
    private var face: Face {
        let facts = CaptureFacts(capture, macDictatingSince: nil)
        let status = facts.status
        let conditions = CaptureCondition.evaluate(status, context: facts.context, now: .now)
        let hero = HeroReading(status: status, conditions: conditions, now: .now)
        let needs = conditions.filter(\.isCard).count + facts.incidents.count
        if needs > 0 { return Face(symbol: "exclamationmark.circle", badge: needs, spoken: "something needs you") }
        // Low as the alert and the Watch decide it: at or below his threshold, from a current reading, not charging.
        let glance = RecordingGlance(
            PendantSnapshot(status, previous: nil), sound: nil,
            lowBatteryPercent: Settings.shared.alerts.lowBatteryPercent, now: .now)
        if Settings.shared.alerts.lowBattery, glance.batteryIsLow(now: .now), let percent = glance.battery {
            return Face(symbol: "battery.25percent", text: "\(percent)%", spoken: "battery low, \(percent) percent")
        }
        switch hero.mode {
        case .notConnected, .lastKnownRecording, .unrecognized:
            return Face(symbol: "wifi.slash", spoken: "out of reach")
        case .paused: return Face(symbol: "pause.circle", spoken: "paused")
        case .waiting: return Face(symbol: "ellipsis.circle", spoken: "waiting")
        case .live:
            if case .catchingUp = SyncSummary(status.sync, lastCaughtUp: facts.lastCaughtUp) {
                return Face(symbol: "arrow.up.circle", spoken: "sending audio")
            }
            return Face(symbol: "record.circle", spoken: "recording")
        }
    }
}
