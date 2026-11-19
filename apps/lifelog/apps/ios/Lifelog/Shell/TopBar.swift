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
                        if hasPendant { PendantItem { router.sheet = .pendant } }
                        if hasSettings {
                            Button("Settings", systemImage: "gearshape") { router.sheet = .settings }
                                .accessibilityIdentifier("top.settings")
                        }
                    }
                }
            }
    }
}

private struct EndsAtColumn: ViewModifier {
    @State private var inset: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .padding(.trailing, inset)
            .onGeometryChange(for: CGFloat.self, of: { $0.safeAreaInsets.trailing }) { inset = $0 }
    }
}

extension View {
    /// The top group of a screen in a tab: Settings only on Inbox and Matters, the Pendant everywhere but in a side
    /// column (the matter's page beside it has it).
    func shellBar(_ label: String, hasSettings: Bool = true, hasPendant: Bool = true) -> some View {
        modifier(ShellBar(label: label, hasSettings: hasSettings, hasPendant: hasPendant))
    }

    /// A scrolling region that ends at the iPhone Duo's column, not under it: a scroll view's frame runs under the
    /// safe area, so its trailing inset is taken as padding.
    func endsAtColumn() -> some View { modifier(EndsAtColumn()) }

    /// A sheet in its own stack, so its Close (`SheetHeader`) is a toolbar item in the bar the system draws.
    func sheetStack() -> some View {
        NavigationStack { self }
    }
}

/// The Pendant as an icon-only toolbar item, like the gear: its state is in the mark and its spoken label, so iOS can
/// put it in the iPhone Duo's column.
struct PendantItem: View {
    let open: () -> Void

    @Environment(CaptureStore.self) private var capture

    private struct Face {
        var symbol: String
        var badge: Int?
        var spoken: String
    }

    var body: some View {
        let face = face
        Button(action: open) {
            Image(systemName: face.symbol)
                .overlay(alignment: .topTrailing) {
                    if let badge = face.badge { CountBadge(count: badge).offset(x: 9, y: -9) }
                }
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
            return Face(symbol: "battery.25percent", spoken: "battery low, \(percent) percent")
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
