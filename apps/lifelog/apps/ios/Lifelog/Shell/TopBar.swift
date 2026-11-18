import Capture
import Incidents
import OwnerSettings
import SwiftUI

/// The bar over every screen: Settings (or back), where he is, and the Pendant's pill. Drawn here, not by the
/// navigation bar, so every tab and every page keeps the same bar.
struct TopBar: View {
    let label: String
    var back: (() -> Void)?

    @Environment(AppRouter.self) private var router

    var body: some View {
        HStack(spacing: 12) {
            Button {
                if let back { back() } else { router.sheet = .settings }
            } label: {
                Image(systemName: back == nil ? "slider.horizontal.3" : "chevron.left")
                    .font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.fg)
                    .frame(width: 44, height: 44)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel(back == nil ? "Settings" : "Back")
            .accessibilityIdentifier(back == nil ? "top.settings" : "top.back")
            Text(label).label().foregroundStyle(Palette.muted).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            PendantPill { router.sheet = .pendant }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(Palette.bg)
    }
}

/// The Pendant as a pill: what it is doing at a glance, or the one thing that needs him.
struct PendantPill: View {
    let open: () -> Void

    @Environment(CaptureStore.self) private var capture
    @Environment(SyncStore.self) private var sync

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
                Text("Pendant").font(.manrope(16, weight: 500))
                if let text = face.text { Text(text).font(.monoTime).foregroundStyle(Palette.flag) }
                Image(systemName: face.symbol).font(.system(size: 17, weight: .medium))
                    .overlay(alignment: .topTrailing) {
                        if let badge = face.badge {
                            Text("\(badge)").font(.manrope(11, weight: 700)).foregroundStyle(Palette.on)
                                .frame(minWidth: 16, minHeight: 16).background(Palette.flag, in: .capsule).offset(
                                    x: 9, y: -9)
                        }
                    }
            }
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
        }
        .glassEffect(.regular.interactive(), in: .capsule)
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
        if let percent = status.batteryPercent?.value, percent < Settings.shared.alerts.lowBatteryPercent,
            Settings.shared.alerts.lowBattery
        {
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
