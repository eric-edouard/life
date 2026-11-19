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
    let capture: CaptureFacts
    let actions: PendantActions

    @Environment(\.dismiss) private var dismiss
    @State private var sheet: PendantSheet?

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
            VStack(alignment: .leading, spacing: 16) {
                SheetHeader(title: "Pendant", isLabel: true) { dismiss() }
                    .padding(.horizontal, Metrics.gutter)
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        status(reading, now: now)
                        if reading.state != .noPendant {
                            facts(reading, now: now)
                            upload(held)
                            boxes
                        }
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, Metrics.Spacing.l)
                    .readingWidth()
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .refreshable { await actions.refresh() }
                footer(reading)
            }
            .padding(.top, Metrics.Spacing.l)
            .background(Palette.sheet)
            .presentationBackground(Palette.sheet)
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .replace: ReplaceSheet { sheet = .pair }
            case .pair: PairPendantSheet()
            }
        }
        .accessibilityIdentifier("pendant.sheet")
        #if DEBUG
            // `-fixtureSheet replacePendant|pairPendant`: opens that sheet at once, to be photographed.
            .task {
                sheet =
                    switch LifeFixture.sheet {
                    case "replacePendant": .replace
                    case "pairPendant": .pair
                    default: nil
                    }
            }
        #endif
    }

    // MARK: Status

    private func status(_ reading: PendantReading, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if capture.macDictatingSince != nil {
                Text("\(Image(systemName: "laptopcomputer")) Mac dictating").font(.small).foregroundStyle(Palette.muted)
                    .accessibilityLabel("Mac dictating").accessibilityIdentifier("pendant.macDictating")
            }
            if let level = reading.lowBattery { Caps("Battery \(level)%", color: Palette.flag) }
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                dot(reading).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 0 }.offset(y: -14)
                Text(reading.state.word).font(.statusWord)
                    .foregroundStyle(reading.isFlag ? Palette.flag : Palette.fg)
                    .modifier(GlowWhen(reading.state == .recording))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("pendant.status")
            }
            if let line = line(reading, now: now) {
                Text(line).font(.note).foregroundStyle(Palette.muted)
            }
            if reading.lowBattery != nil { Text("Charge it.").font(.bodyStrong) }
            ForEach(reading.conditions, id: \.means) { condition in
                VStack(alignment: .leading, spacing: 8) {
                    Text(condition.means).font(.note).foregroundStyle(Palette.muted)
                    Text(condition.todo).font(.bodyStrong)
                    if let recovery = condition.recovery {
                        Button(recovery.title) { actions.recover(recovery) }
                            .buttonStyle(.pill(.quiet, size: .compact))
                            .accessibilityIdentifier("pendant.recover.\(recovery)")
                    }
                }
            }
        }
    }

    /// A state's own second line, when the conditions do not say it.
    private func line(_ reading: PendantReading, now: Date) -> String? {
        if reading.lowBattery != nil {
            let left = reading.lowBattery.flatMap { capture.batteryLife.timeLeft(recording: true, from: $0) }
            return (left.map { "About \(Self.about($0)) left. " } ?? "") + "Recording stops when it is empty."
        }
        switch reading.state {
        case .recording: return reading.since.map { "Since \($0.formatted(date: .omitted, time: .shortened))" }
        case .notRecording:
            return reading.pausedAt.map {
                "Paused on the pendant at \($0.formatted(date: .omitted, time: .shortened))."
            }
        case .checking: return "Nothing is confirmed until it answers."
        default: return nil
        }
    }

    private func dot(_ reading: PendantReading) -> some View {
        Group {
            if reading.state == .recording && !reading.isFlag {
                Circle().fill(Palette.fg).shadow(color: Palette.fg.opacity(0.5), radius: 4)
            } else {
                Circle().fill(reading.isFlag ? Palette.flag : Palette.muted)
            }
        }
        .frame(width: 9, height: 9)
        .accessibilityHidden(true)
    }

    // MARK: Facts

    private func facts(_ reading: PendantReading, now: Date) -> some View {
        let status = capture.status
        let connected = if case .ready = status.connection { true } else { false }
        let battery = Fact(status.batteryPercent, connected: connected, now: now)
        let storage = Fact(status.storage, connected: connected, now: now)
        return RowGroup(surface: .sheet) {
            Row(title: capture.pairedKind.modelName, detail: connected ? nil : "Not connected")
            if !connected, let seen = status.lastContact ?? capture.context.lastContact {
                Row(title: "Last seen") { value(seen.formatted(date: .omitted, time: .shortened)) }
            }
            Row(title: "Battery") {
                value(
                    batteryWords(battery, charging: status.charging?.value == .charging, reading: reading),
                    isFlag: reading.lowBattery != nil)
            }
            Row(title: "Storage") {
                value(storageWords(storage), isFlag: reading.state == .full)
            }
            if connected, let synced = capture.lastCaughtUp {
                Row(title: "Last sync") {
                    value(
                        now.timeIntervalSince(synced) < 60
                            ? "just now" : synced.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated))
                    )
                }
            }
        }
    }

    private func value(_ text: String, isFlag: Bool = false) -> some View {
        Text(text).font(.note).foregroundStyle(isFlag ? Palette.flag : Palette.muted).multilineTextAlignment(.trailing)
    }

    private func batteryWords(_ battery: Fact<Int>, charging: Bool, reading: PendantReading) -> String {
        switch battery {
        case .current(let percent, _):
            if charging { return "\(percent)%, charging" }
            let left = capture.batteryLife.timeLeft(recording: reading.state == .recording, from: percent)
            return "\(percent)%" + (left.map { ", about \(Self.about($0))" } ?? "")
        case .lastKnown(let percent, let at): return "\(percent)% at \(at.formatted(date: .omitted, time: .shortened))"
        case .unknown: return "Unknown"
        }
    }

    private func storageWords(_ storage: Fact<StorageState>) -> String {
        switch storage {
        case .current(let state, _), .lastKnown(let state, _):
            guard state.totalPages > 0 else { return "Unknown" }
            let used = 100 - Int((Double(state.freePages) / Double(state.totalPages) * 100).rounded())
            return storage.isCurrent
                ? "\(used)% used" : "\(used)% used at \(storage.at?.formatted(date: .omitted, time: .shortened) ?? "")"
        case .unknown: return "Unknown"
        }
    }

    private static func about(_ left: Duration) -> String {
        let units: Set<Duration.UnitsFormatStyle.Unit> =
            left < .seconds(3_600) ? [.minutes] : left < .seconds(2 * 86_400) ? [.hours] : [.days]
        return left.formatted(.units(allowed: units, width: .wide, maximumUnitCount: 1))
    }

    // MARK: Upload

    @ViewBuilder private func upload(_ held: NotOnTheMac) -> some View {
        if held.isEmpty {
            RowGroup(label: "On your Mac", surface: .sheet) {
                Row(
                    title: capture.uploads?.sentThrough.map {
                        "Everything up to \($0.formatted(date: .omitted, time: .shortened))"
                    } ?? "Everything")
            }
        } else if held.isPhoneUnknown {
            RowGroup(label: "On your Mac", surface: .sheet) {
                Row(title: "Asking…") { StateGlyph.busy }
            }
        } else if let words = held.words {
            VStack(alignment: .leading, spacing: 8) {
                Caps("Waiting to upload").padding(.horizontal, Metrics.Spacing.l)
                VStack(alignment: .leading, spacing: 12) {
                    Text(words).font(.bodyStrong)
                    if case .catchingUp(let progress) = SyncSummary(
                        capture.status.sync, lastCaughtUp: capture.lastCaughtUp)
                    {
                        let fraction = Double(progress.settled) / Double(max(progress.expected, 1))
                        ProgressLine(
                            label: "To this phone", fraction: fraction,
                            end: fraction.formatted(.percent.precision(.fractionLength(0))))
                        Text("Keep the app open: it goes faster.").font(.note).foregroundStyle(Palette.muted)
                    }
                }
                .padding(Metrics.Spacing.l).frame(maxWidth: .infinity, alignment: .leading)
                .background(Surface.sheet.fill, in: .rect(cornerRadius: Metrics.Radius.card))
            }
        }
    }

    // MARK: Boxes, footer

    @ViewBuilder private var boxes: some View {
        let omi = capture.pairedKind == .omi && OmiFirmware.freesOnDelivery(capture.status.firmwareRevision)
        if omi || !capture.incidents.isEmpty {
            VStack(spacing: 12) {
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
                TextLink("Replace this pendant") { sheet = .replace }.frame(maxWidth: .infinity, minHeight: 44)
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

/// The glow of the bold line, only where asked.
private struct GlowWhen: ViewModifier {
    let isOn: Bool
    init(_ isOn: Bool) { self.isOn = isOn }

    func body(content: Content) -> some View {
        if isOn { content.lit() } else { content }
    }
}
