import Capture
import Glance
import Incidents
import OwnerSettings
import SwiftUI

/// The top group, as the system's own toolbar items: the Pendant then Settings (a gear), together on the trailing
/// edge in one glass capsule. Leading is the stack's Back, or a screen's own item (the Matters filter). Declared, never
/// drawn, so iOS places them: a bar on a phone, the side column on the iPhone Duo. The content scrolls under the bar
/// behind a soft edge.
private struct ShellBar: ViewModifier {
    let label: String
    let hasSettings: Bool
    let hasPendant: Bool

    @Environment(AppRouter.self) private var router

    func body(content: Content) -> some View {
        content
            .navigationTitle(label)
            .navigationBarTitleDisplayMode(.inline)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .toolbar {
                if hasPendant || hasSettings {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        if hasPendant { PendantPill { router.sheet = .pendant } }
                        if hasSettings {
                            Button("Settings", systemImage: "gearshape") { router.sheet = .settings }
                                .accessibilityIdentifier("top.settings")
                        }
                    }
                }
            }
    }
}

extension View {
    /// The top group of a screen in a tab: Settings only on Inbox and Matters, the Pendant everywhere but in a side
    /// column (the matter's page beside it has it).
    func shellBar(_ label: String, hasSettings: Bool = true, hasPendant: Bool = true) -> some View {
        modifier(ShellBar(label: label, hasSettings: hasSettings, hasPendant: hasPendant))
    }

    /// A sheet in its own stack, so its Close (`SheetHeader`) is a toolbar item in the bar the system draws.
    func sheetStack() -> some View {
        NavigationStack { self }
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
                Image(systemName: face.symbol).font(.lead)
                    .overlay(alignment: .topTrailing) {
                        if let badge = face.badge {
                            CountBadge(count: badge).offset(x: 9, y: -9)
                        }
                    }
            }
            .foregroundStyle(Palette.fg)
            .motion(Motion.standard, value: face.symbol)
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
