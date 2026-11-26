import Capture
import Incidents
import Library
import OwnerSettings
import PendantProtocol
import ServerAPI
import SourceStore
import SwiftUI
import Timeline
import Upload

/// The Pendant sheet: what state it is in, what to do about it, its facts, and what is not on the Mac yet. Reads the
/// stores; `PendantScreen` draws plain values so previews can show every state.
struct PendantView: View {
    @Environment(CaptureStore.self) private var capture
    @Environment(SyncStore.self) private var sync
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        PendantScreen(
            capture: CaptureFacts(capture, macDictatingSince: sync.macDictatingSince, uploads: sync.uploads),
            actions: PendantActions(capture: capture, sync: sync)
        )
        // On screen in the foreground: keep "Recording." backed by current evidence. A status every
        // few seconds, never a control write; stops when the screen or the app goes away.
        .task(id: scenePhase == .active && capture.availability == .running) {
            guard scenePhase == .active else { return }
            await capture.watchLive()
        }
    }
}

struct PendantScreen: View {
    @Environment(\.dynamicTypeSize) private var size
    let capture: CaptureFacts
    let actions: PendantActions

    @Environment(\.dismiss) private var dismiss
    @State private var sheet: PendantSheet?
    /// The recovery button tapped last, and what came of it (`RowState.tap`).
    @State private var recovering: Recovery?
    @State private var recovered = RowState.known

    private enum PendantSheet: String, Identifiable {
        case replace, pair
        var id: String { rawValue }
    }

    var body: some View {
        TimelineView(.explicit(capture.boundaries(after: .now))) { timeline in
            let now = timeline.date
            let settings = Settings.shared.alerts
            let reading = PendantReading(
                status: capture.status, context: capture.context, recordingSince: capture.recordingSince,
                lowBatteryPercent: settings.lowBattery ? settings.lowBatteryPercent : nil, now: now)
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                ScrollView {
                    VStack(alignment: .leading, spacing: Metrics.gutter) {
                        status(reading, now: now)
                        if reading.state != .noPendant { boxes }
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, Metrics.Spacing.l)
                    .readingWidth()
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollEdgeEffectStyle(.soft, for: .vertical)
                .refreshable { await actions.refresh() }
                footer(reading)
            }
            .padding(.top, Metrics.Spacing.l)
            .background(Palette.sheet)
            .presentationBackground(Palette.sheet)
            .toolbar { CloseItem { dismiss() } }
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .replace: ReplaceSheet { sheet = .pair }.sheetStack()
            case .pair: PairPendantSheet().sheetStack()
            }
        }
        .accessibilityIdentifier("pendant.sheet")
    }

    // MARK: Status

    /// The pendant's page, like a profile (the lab's D): its light as a round face, its name, one line; pause at the
    /// end while it is fine; when it needs him, only the fix: why, and the answer that does it.
    private func status(_ reading: PendantReading, now: Date) -> some View {
        VStack(spacing: Metrics.Spacing.m) {
            let isOn = reading.state == .recording && !reading.isFlag
            Circle().fill(Palette.tint).frame(width: Metrics.Tile.light, height: Metrics.Tile.light)
                .overlay {
                    if isOn {
                        StateDot(color: Palette.fg, isLit: true).scaleEffect(1.15)
                    } else {
                        StillRing(progress: 0)
                    }
                }
                .accessibilityHidden(true)
            Text("Pendant").font(.profileName).accessibilityIdentifier("pendant.status")
            if capture.macDictatingSince != nil {
                Text("\(Image(systemName: "laptopcomputer")) Mac dictating").font(.line)
                    .foregroundStyle(Palette.muted).accessibilityIdentifier("pendant.macDictating")
            }
            if let line = line(reading) {
                Text(line).font(.line).foregroundStyle(reading.isFlag ? Palette.flag : Palette.muted)
                    .multilineTextAlignment(.center)
            }
            if reading.lowBattery != nil { Text("Charge it soon.").font(.bodyStrong).foregroundStyle(Palette.flag) }
            if reading.conditions.isEmpty, reading.state == .recording || reading.pausedAt != nil {
                SettingsBlock {
                    SettingSwitchRow(title: "Pendant records", isOn: reading.pausedAt == nil) { records in
                        Task { await actions.setPaused(!records) }
                    }
                }
                .padding(.top, Metrics.Spacing.s)
            }
            ForEach(reading.conditions, id: \.means) { condition in
                VStack(spacing: Metrics.Spacing.s) {
                    Text(condition.means).font(.line).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                    if let recovery = condition.recovery {
                        Button(recovery.title) {
                            guard recovered != .saving else { return }
                            recovering = recovery
                            Task { await RowState.tap($recovered) { await actions.recover(recovery) } }
                        }
                        .buttonStyle(
                            .pill(.filled, size: .row, isBusy: recovering == recovery && recovered == .saving)
                        )
                        .accessibilityIdentifier("pendant.recover.\(recovery)")
                    } else {
                        Text(condition.todo).font(.bodyStrong).multilineTextAlignment(.center)
                    }
                }
                .padding(.top, Metrics.Spacing.s)
            }
            // Below the conditions, so "Reconnected" stays while its condition goes.
            if recovering != nil { TapLine(state: recovered == .saving ? .known : recovered) }
        }
        .frame(maxWidth: .infinity)
        .motion(Motion.standard, value: reading.conditions.map(\.means))
        // "Still not fixed" holds only while the conditions it was about do.
        .onChange(of: reading.conditions.map(\.means)) { if case .refused = recovered { recovered = .known } }
    }

    /// The state in one line: since when it records, since when it does not.
    private func line(_ reading: PendantReading) -> String? {
        func clock(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }
        switch reading.state {
        case .recording: return reading.since.map { "Recording since \(clock($0))" } ?? "Recording"
        case .notRecording: return reading.pausedAt.map { "Paused at \(clock($0))" } ?? "Not recording"
        case .noPendant: return nil
        default: return String(reading.state.word.dropLast())
        }
    }

    // MARK: Boxes, footer

    @ViewBuilder private var boxes: some View {
        let omi = capture.pairedKind == .omi && OmiFirmware.freesOnDelivery(capture.status.firmwareRevision)
        if omi || !capture.incidents.isEmpty {
            VStack(spacing: Metrics.Spacing.m) {
                if omi { OmiCustodyCard(revision: capture.status.firmwareRevision) }
                IncidentCards(incidents: capture.incidents, resolve: actions.resolve)
            }
            .motion(Motion.rise, value: capture.incidents.map(\.id))
        }
    }

    @ViewBuilder private func footer(_ reading: PendantReading) -> some View {
        Group {
            if reading.state == .noPendant {
                Button("Pair a pendant") { sheet = .pair }.buttonStyle(.pill(.filled))
                    .accessibilityIdentifier("pendant.pair")
            } else {
                QuietChip("Replace this pendant", symbol: "arrow.left.arrow.right") { sheet = .replace }.frame(
                    maxWidth: .infinity, minHeight: Metrics.tapTarget
                )
                .accessibilityIdentifier("pendant.replace")
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.bottom, Metrics.Spacing.l)
    }
}

extension PendantReading.State {
    /// The big word: a state, said as a sentence.
    var word: String {
        switch self {
        case .recording: "Recording."
        case .notRecording: "Not recording."
        case .outOfRange: "Out of range."
        case .notConnected: "Not connected."
        case .full: "Full."
        case .noPendant: "No pendant."
        case .checking: "Checking."
        }
    }
}

extension DeviceKind {
    var modelName: String {
        switch self {
        case .limitless: "Limitless Pendant"
        case .omi: "Omi"
        }
    }
}

extension Fact {
    var isCurrent: Bool { if case .current = self { true } else { false } }
}
