import Capture
import Glance
import Incidents
import OwnerSettings
import SwiftUI

/// The top group, as the system's own toolbar items: the Pendant then Settings (a gear), together on the trailing
/// edge in one glass capsule. Leading is the stack's Back, or a list's Filter (`filterBar`). Declared, never
/// drawn, so iOS places them: a bar on a phone, the side column on the iPhone Duo.
private struct ShellBar: ViewModifier {
    let label: String
    let hasSettings: Bool
    let hasPendant: Bool

    @Environment(AppRouter.self) private var router
    @Environment(\.topBarZoom) private var topBarZoom

    func body(content: Content) -> some View {
        content
            // An empty label leaves the title to the screen's `screenTitle`, the inline one on the open Duo.
            .titled(label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // One item each, never a group: the closed Duo's side column took the group's first item only. Each is
                // said to fit the column: a button the zoom wraps reads as a custom view, which the system keeps in a
                // bar of its own over the screen's title (the "huge black header", seen in `design:shots`).
                if hasPendant { fitted(pendant) }
                if hasSettings { fitted(settings) }
            }
    }
}

extension View {
    @ViewBuilder fileprivate func titled(_ label: String) -> some View {
        if label.isEmpty { self } else { navigationTitle(label) }
    }
}

extension ShellBar {
    /// One item said to fit the column (drop this once the deployment target is 27.1).
    @ToolbarContentBuilder
    private func fitted(_ item: some ToolbarContent) -> some ToolbarContent {
        if #available(iOS 27.1, *) { item.axisBehavior(.verticalPreferred) } else { item }
    }

    private var pendant: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            PendantItem { router.sheet = .pendant }.zoomSource(AppRouter.Sheet.pendant, in: topBarZoom)
        }
    }

    private var settings: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button("Settings", systemImage: "gearshape") { router.sheet = .settings }
                .labelStyle(.iconOnly)
                .zoomSource(AppRouter.Sheet.settings, in: topBarZoom)
                .accessibilityIdentifier("top.settings")
                // Under the Pendant in the column: Tell Life stands below the lower of the two.
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) {
                    if $0.width > 0, $0.minX > 0 { router.settingsFrame = $0 }
                }
                .onDisappear { router.settingsFrame = nil }
        }
    }
}

extension View {
    /// The top group of a screen in a tab: Settings only on Inbox and Matters, the Pendant everywhere but in a side
    /// column (the matter's page beside it has it). The bar's own title is always inline: a list screen's name is its
    /// `screenTitle`, a page's its first line.
    func shellBar(_ label: String, hasSettings: Bool = true, hasPendant: Bool = true) -> some View {
        modifier(ShellBar(label: label, hasSettings: hasSettings, hasPendant: hasPendant))
    }
}

/// The Pendant as an icon-only toolbar item, like the gear: its state is in the mark and its spoken label, so iOS can
/// put it in the iPhone Duo's column.
struct PendantItem: View {
    let open: () -> Void

    @Environment(CaptureStore.self) private var capture
    @Environment(AppRouter.self) private var router

    private struct Face {
        var symbol: String
        var badge: Int?
        var spoken: String
        var color = Palette.fg
    }

    var body: some View {
        let face = face
        Button(action: open) {
            Image(systemName: face.symbol).foregroundStyle(face.color)
                .overlay(alignment: .topTrailing) {
                    if let badge = face.badge { CountBadge(count: badge).offset(x: 9, y: -9) }
                }
                .motion(Motion.standard, value: face.symbol)
        }
        .accessibilityLabel("Pendant, \(face.spoken)")
        .accessibilityIdentifier("top.pendant")
        // Where the system put it, so Tell Life stands on its vertical line, below it (`AppRouter.pendantFrame`). Only an
        // item on screen: a collapsed split view keeps its hidden column's item laid out at the leading edge, which drew
        // Tell Life over the content's left edge (seen in `design:shots`, the Inbox's moves).
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) {
            if $0.width > 0, $0.minX > 0 { router.pendantFrame = $0 }
        }
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
            return Face(symbol: "battery.25percent", spoken: "battery low, \(percent) percent", color: Palette.flag)
        }
        switch reading.state {
        // The pendant's own mark, dimmed, while it is not recording for a reason of its own: never "…" (that is More).
        case .outOfRange, .notConnected:
            return Face(symbol: "record.circle", spoken: "out of reach", color: Palette.muted)
        case .noPendant: return Face(symbol: "record.circle", spoken: "no pendant", color: Palette.muted)
        case .notRecording: return Face(symbol: "pause.circle", spoken: "paused")
        case .checking: return Face(symbol: "record.circle", spoken: "waiting", color: Palette.muted)
        case .full: return Face(symbol: "exclamationmark.circle", spoken: "full")
        case .recording:
            if case .catchingUp = SyncSummary(facts.status.sync, lastCaughtUp: facts.lastCaughtUp) {
                return Face(symbol: "arrow.up.circle", spoken: "sending audio")
            }
            return Face(symbol: "record.circle", spoken: "recording")
        }
    }
}

extension View {
    /// Tells whether the system puts this screen's bars in a vertical column on a compact window (the closed iPhone Duo,
    /// iOS 27.1): the system's own `toolbarVerticalEdge`, never a guess from the size. The one rule for the Undo toast
    /// and the floating Filter.
    @ViewBuilder func reportsSideColumn(_ isInColumn: Binding<Bool>) -> some View {
        if #available(iOS 27.1, *) { modifier(SideColumnReport(isInColumn: isInColumn)) } else { self }
    }
}

@available(iOS 27.1, *)
private struct SideColumnReport: ViewModifier {
    @Binding var isInColumn: Bool
    @Environment(\.toolbarVerticalEdge) private var edge
    @Environment(\.windowSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        content.onChange(of: edge != nil && sizeClass != .regular, initial: true) { _, now in isInColumn = now }
    }
}

extension EnvironmentValues {
    /// The namespace the top bar's Settings and Pendant buttons zoom their sheets out of (the root's).
    @Entry var topBarZoom: Namespace.ID?
}
