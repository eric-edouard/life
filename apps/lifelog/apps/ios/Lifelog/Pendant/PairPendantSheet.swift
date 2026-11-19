import Capture
import Incidents
import SwiftUI

/// Pairing a pendant as a sheet: it looks nearby, then the checks as they pass (found, paired with this phone, first
/// sync), then Paired, or Not paired with the reason. The phone takes the first pendant it finds, so nothing is picked.
struct PairPendantSheet: View {
    @Environment(CaptureStore.self) private var capture
    @Environment(\.dismiss) private var dismiss

    @State private var startedAt = Date.now
    @State private var hasGivenUp = false

    private var connection: ConnectionState { capture.shown.connection }

    private enum Phase { case looking, pairing, paired, failed(String) }

    private var phase: Phase {
        if hasGivenUp && foundCount == 0 {
            return .failed("No pendant answered. Keep it close and hold its button until the light blinks blue.")
        }
        if case .busyElsewhere = connection {
            return .failed("It did not answer. Another app may hold it. Close that connection and try again.")
        }
        switch connection {
        case .connecting, .discovering, .pairingPending, .resting, .disconnected:
            return .pairing
        case .ready:
            return capture.lastCaughtUp.map { !($0 < startedAt) } == true ? .paired : .pairing
        default: return .looking
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            SheetHeader(title: title, color: color) { dismiss() }
            ScrollView { content }.scrollBounceBehavior(.basedOnSize)
            VStack(spacing: 10) { buttons }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, 16)
        .padding(.bottom, 16)
        .readingWidth()
        .background(Palette.sheet)
        .presentationBackground(Palette.sheet)
        .accessibilityIdentifier("pendant.pairSheet")
        .task { await start() }
        .task(id: startedAt) {
            try? await Task.sleep(for: .seconds(CaptureCondition.noPendantAfter))
            if case .looking = phase { hasGivenUp = true }
        }
    }

    private func start() async {
        startedAt = .now
        hasGivenUp = false
        await capture.reconnect()
    }

    private var title: String {
        switch phase {
        case .looking: "Pair"
        case .pairing: "Pairing"
        case .paired: "Paired"
        case .failed: "Not paired"
        }
    }

    private var color: Color {
        switch phase {
        case .paired: Palette.ok
        case .failed: Palette.flag
        default: Palette.fg
        }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .looking:
            VStack(alignment: .leading, spacing: 8) {
                Text("Looking nearby").font(.bodyStrong)
                Text("Hold its button until the light blinks blue.").font(.note).foregroundStyle(Palette.muted)
            }
        case .pairing, .paired:
            RowGroup(surface: .sheet) { checks(failedAt: nil) }
        case .failed(let reason):
            VStack(alignment: .leading, spacing: 16) {
                RowGroup(surface: .sheet) { checks(failedAt: foundCount) }
                Text(reason).font(.note).foregroundStyle(Palette.muted)
            }
        }
    }

    /// How many checks have passed: found, paired with this phone, first sync.
    private var foundCount: Int {
        switch connection {
        case .ready: capture.lastCaughtUp.map { !($0 < startedAt) } == true ? 3 : 2
        case .connecting, .discovering, .pairingPending, .resting, .disconnected, .busyElsewhere: 1
        default: 0
        }
    }

    private func checks(failedAt: Int?) -> some View {
        let sync = capture.lastCaughtUp.map { !($0 < startedAt) ? $0 : nil } ?? nil
        let words = [
            "Found", "Paired with this phone",
            sync.map { "First sync, \($0.formatted(date: .omitted, time: .shortened))" } ?? "First sync",
        ]
        return CheckLines(
            lines: CheckLine.lines(
                "pair", words, passed: foundCount, failedAt: failedAt.map { min($0, 2) }, isRunning: failedAt == nil)
        )
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var buttons: some View {
        switch phase {
        case .looking:
            Button("Looking…") {}.buttonStyle(.pill(.filled, isBusy: true))
            Button("Cancel") { dismiss() }.buttonStyle(.pill(.quiet))
        case .pairing:
            Button("Pairing…") {}.buttonStyle(.pill(.filled, isBusy: true))
        case .paired:
            Button("Done") { dismiss() }.buttonStyle(.pill(.filled)).accessibilityIdentifier("pendant.pair.done")
        case .failed:
            Button("Try again") { Task { await start() } }.buttonStyle(.pill(.filled))
            Button("Cancel") { dismiss() }.buttonStyle(.pill(.quiet))
        }
    }
}
