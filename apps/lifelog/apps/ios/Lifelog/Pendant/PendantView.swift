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
            let held = whatIsNotOnTheMac(backlog: capture.status.backlog, uploads: capture.uploads, now: now)
            VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
                ScrollView {
                    VStack(alignment: .leading, spacing: Metrics.gutter) {
                        status(reading, now: now)
                        if reading.state != .noPendant {
                            VStack(spacing: Metrics.Spacing.m) {
                                tiles(reading, now: now)
                                upload(held, now: now)
                            }
                            boxes
                        }
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

    /// The light as a tile and the state word, then what it means and what to do, one `flag` line when it needs him.
    private func status(_ reading: PendantReading, now: Date) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            let tileAndWords =
                size.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Metrics.Spacing.m))
                : AnyLayout(HStackLayout(spacing: Metrics.Spacing.l))
            tileAndWords {
                LightTile(isOn: reading.state == .recording && !reading.isFlag)
                VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                    if capture.macDictatingSince != nil {
                        Text("\(Image(systemName: "laptopcomputer")) Mac dictating").font(.line)
                            .foregroundStyle(Palette.muted)
                            .accessibilityLabel("Mac dictating").accessibilityIdentifier("pendant.macDictating")
                    }
                    Text(reading.state.word).font(.profileName)
                        .foregroundStyle(reading.isFlag ? Palette.flag : Palette.fg)
                        .lit(reading.state == .recording)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pendant.status")
                    if let line = line(reading) { Text(line).font(.line).foregroundStyle(Palette.muted) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .motion(Motion.standard, value: reading.state)
            if reading.lowBattery != nil {
                Text("Charge it soon.").font(.bodyStrong).foregroundStyle(Palette.flag)
                    .padding(.top, Metrics.Spacing.xs * 2)
            }
            ForEach(reading.conditions, id: \.means) { condition in
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    Text(condition.means).font(.line).foregroundStyle(Palette.muted)
                    Text(condition.todo).font(.bodyStrong)
                    if let recovery = condition.recovery {
                        Button(recovery.title) {
                            guard recovered != .saving else { return }
                            recovering = recovery
                            Task { await RowState.tap($recovered) { await actions.recover(recovery) } }
                        }
                        .buttonStyle(
                            .pill(.quiet, size: .compact, isBusy: recovering == recovery && recovered == .saving)
                        )
                        .accessibilityIdentifier("pendant.recover.\(recovery)")
                        .padding(.top, Metrics.Spacing.xs * 2)
                    }
                }
                .padding(.top, Metrics.Spacing.xs * 2)
            }
            // Below the conditions, so "Reconnected" stays while its condition goes.
            if recovering != nil { TapLine(state: recovered == .saving ? .known : recovered) }
        }
        .motion(Motion.standard, value: reading.conditions.map(\.means))
        // "Still not fixed" holds only while the conditions it was about do.
        .onChange(of: reading.conditions.map(\.means)) { if case .refused = recovered { recovered = .known } }
    }

    /// A state's own second line, when the conditions do not say it.
    private func line(_ reading: PendantReading) -> String? {
        switch reading.state {
        case .recording: reading.since.map { "Since \($0.formatted(date: .omitted, time: .shortened))" }
        case .notRecording:
            reading.pausedAt.map {
                "Paused at \($0.formatted(date: .omitted, time: .shortened)). Press its button to record again."
            }
        default: nil
        }
    }

    // MARK: Tiles

    /// The battery drawn as a battery and the storage as a ring. A figure not heard from now is dimmed and says when.
    private func tiles(_ reading: PendantReading, now: Date) -> some View {
        let status = capture.status
        let connected =
            switch status.connection {
            case .ready, .resting: true
            default: false
            }
        let battery = Fact(status.batteryPercent, connected: connected, now: now)
        let storage = Fact(status.storage, connected: connected, now: now)
        let isCharging = battery.isCurrent && status.charging?.value == .charging
        let percent = battery.value
        let used = storage.value?.usedFraction
        return HStack(spacing: Metrics.Spacing.m) {
            StatTile(
                name: "Battery", figure: percent.map { "\($0)%" } ?? "Unknown",
                caption: batteryCaption(battery, isCharging: isCharging, reading: reading),
                figureColor: reading.lowBattery != nil ? Palette.flag : Palette.fg, isDim: !battery.isCurrent
            ) {
                BatteryGlyph(
                    percent: percent,
                    tone: reading.lowBattery != nil ? Palette.flag : isCharging ? Palette.ok : Palette.fg,
                    charging: isCharging, width: Metrics.Tile.battery)  // the tile dims a last-known reading
            }
            StatTile(
                name: "Storage", figure: used.map { "\(Int(($0 * 100).rounded()))%" } ?? "Unknown", caption: "Used",
                figureColor: reading.state == .full ? Palette.flag : Palette.fg, isDim: !storage.isCurrent,
                visualEdge: .topTrailing
            ) {
                RingMeter(fraction: used ?? 0, tone: reading.state == .full ? Palette.flag : Palette.fg)
            }
        }
        .motion(Motion.standard, value: battery)
    }

    private func clock(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }

    private func batteryCaption(_ battery: Fact<Int>, isCharging: Bool, reading: PendantReading) -> String? {
        switch battery {
        case .current(let percent, _):
            if isCharging { return "Charging" }
            let left = capture.batteryLife.timeLeft(recording: reading.state == .recording, from: percent)
            return left.map { "About \(Self.about($0))" } ?? "Battery"
        case .lastKnown(_, let at): return "At \(clock(at))"
        case .unknown: return nil
        }
    }

    private static func about(_ left: Duration) -> String {
        let units: Set<Duration.UnitsFormatStyle.Unit> =
            left < .seconds(3_600) ? [.minutes] : left < .seconds(2 * 86_400) ? [.hours] : [.days]
        return left.formatted(.units(allowed: units, width: .wide, maximumUnitCount: 1))
    }

    // MARK: Upload

    /// One tile: everything is on the Mac, or what is catching up (a bar that fills as it works), or when it was
    /// last heard from.
    @ViewBuilder private func upload(_ held: NotOnTheMac, now: Date) -> some View {
        let isConnected =
            switch capture.status.connection {
            case .ready, .resting: true
            default: false
            }
        Group {
            if !isConnected, let seen = capture.status.lastContact ?? capture.context.lastContact {
                TileCard { Text("Last seen \(clock(seen))").font(.bodyStrong) }
            } else if held.isPhoneUnknown {
                TileCard {
                    HStack(spacing: Metrics.Spacing.m) {
                        StateGlyph.busy
                        Text("Asking…").font(.bodyStrong)
                    }
                }
            } else if let words = held.words {
                TileCard {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
                        Text("Catching up").font(.bodyStrong)
                        if let fraction = catchUpFraction {
                            ProgressLine(fraction: fraction)
                        } else {
                            Spinner(size: .small).foregroundStyle(Palette.fg)
                        }
                        Text("\(words). It goes faster with the app open.").font(.line).foregroundStyle(Palette.muted)
                    }
                }
            } else if held.isEmpty {
                TileCard {
                    HStack(spacing: Metrics.Spacing.m) {
                        Text("All on your Mac").font(.bodyStrong)
                        Spacer()
                        if let sent = capture.uploads?.sentThrough {
                            Text(
                                now.timeIntervalSince(sent) < 60
                                    ? "just now"
                                    : sent.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated))
                            )
                            .font(.line).foregroundStyle(Palette.muted)
                        }
                    }
                }
            }
        }
        .transition(Motion.appears)
        .motion(Motion.rise, value: held)
    }

    private var catchUpFraction: Double? {
        guard
            case .catchingUp(let progress) = SyncSummary(capture.status.sync, lastCaughtUp: capture.lastCaughtUp)
        else { return nil }
        return Double(progress.settled) / Double(max(progress.expected, 1))
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
