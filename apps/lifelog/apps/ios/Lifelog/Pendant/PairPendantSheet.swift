import Capture
import Incidents
import SwiftUI

/// Pairing a pendant as a sheet: it looks nearby, then the checks as they pass (found, paired with this phone, first sync), then Paired, or Not paired with the reason. The phone takes the first pendant it finds, so nothing is picked.
struct PairPendantSheet: View {
    @Environment(CaptureStore.self) private var capture
    @Environment(\.dismiss) private var dismiss

    @State private var startedAt = Date.now
    @State private var hasGivenUp = false

    private var connection: ConnectionState { capture.shown.connection }

    /// The first sync since this sheet opened: what makes Paired, for a resting Omi as for a ready Pendant.
    private var hasCaughtUp: Bool { capture.lastCaughtUp.map { !($0 < startedAt) } == true }

    private enum Phase { case looking, pairing, paired, failed(String) }

    private var phase: Phase {
        if hasGivenUp && foundCount == 0 {
            return .failed("It did not answer. Keep it close and hold its button again.")
        }
        if case .busyElsewhere = connection {
            return .failed("It did not answer. Another app may hold it. Close that connection and try again.")
        }
        switch connection {
        case .ready, .resting:
            return hasCaughtUp ? .paired : .pairing
        case .connecting, .discovering, .pairingPending, .disconnected:
            return .pairing
        default: return .looking
        }
    }

    var body: some View {
        content
            .faces(face)
            .sheetScroll {
                SheetHeader(title: title, color: color) { dismiss() }
            } buttons: {
                VStack(spacing: 10) { buttons }.faces(face)
            }
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

    private var face: String {
        switch phase {
        case .looking: "looking"
        case .pairing: "pairing"
        case .paired: "paired"
        case .failed: "failed"
        }
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
                RowGroup(surface: .sheet) { checks(failedAt: 1) }
                Text(reason).font(.note).foregroundStyle(Palette.muted)
            }
        }
    }

    /// How many checks have passed: found, paired with this phone, first sync.
    private var foundCount: Int {
        switch connection {
        case .ready, .resting: hasCaughtUp ? 3 : 2
        case .connecting, .discovering, .pairingPending, .disconnected, .busyElsewhere: 1
        default: 0
        }
    }

    private func checks(failedAt: Int?) -> some View {
        let sync = capture.lastCaughtUp.flatMap { !($0 < startedAt) ? $0 : nil }
        let words = [
            "Found", "Paired with this phone",
            sync.map { "First sync, \($0.formatted(date: .omitted, time: .shortened))" } ?? "First sync",
        ]
        // A failure is always the second check: the pendant was found, it did not pair.
        return CheckLines(
            lines: CheckLine.lines(
                "pair", words, passed: failedAt == nil ? foundCount : 1, failedAt: failedAt, isRunning: failedAt == nil)
        )
        .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading)
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
