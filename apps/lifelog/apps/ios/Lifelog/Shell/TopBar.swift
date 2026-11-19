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

    /// One thing, the most pressing first: something that needs him, a low battery, then the state.
    private var face: Face {
        let facts = CaptureFacts(capture, macDictatingSince: nil)
        let alerts = Settings.shared.alerts
        let reading = PendantReading(
            status: facts.status, context: facts.context, recordingSince: nil,
            lowBatteryPercent: alerts.lowBattery ? alerts.lowBatteryPercent : nil, now: .now)
        let needs = reading.needs + facts.incidents.count
        if needs > 0 { return Face(symbol: "exclamationmark.circle", badge: needs, spoken: "something needs you") }
        if let percent = reading.lowBattery {
            return Face(symbol: "battery.25percent", text: "\(percent)%", spoken: "battery low, \(percent) percent")
        }
        switch reading.state {
        case .outOfRange, .notConnected: return Face(symbol: "wifi.slash", spoken: "out of reach")
        case .noPendant: return Face(symbol: "link.badge.plus", spoken: "no pendant")
        case .notRecording: return Face(symbol: "pause.circle", spoken: "paused")
        case .checking: return Face(symbol: "ellipsis.circle", spoken: "waiting")
        case .full: return Face(symbol: "exclamationmark.circle", spoken: "full")
        case .recording:
            if case .catchingUp = SyncSummary(facts.status.sync, lastCaughtUp: facts.lastCaughtUp) {
                return Face(symbol: "arrow.up.circle", spoken: "sending audio")
            }
            return Face(symbol: "record.circle", spoken: "recording")
        }
    }
}
