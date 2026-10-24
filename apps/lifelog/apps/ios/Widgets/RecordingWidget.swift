import Capture
import Incidents
import SwiftUI
import WidgetKit

@main
struct LifelogWidgets: WidgetBundle {
    var body: some Widget {
        RecordingWidget()
        CodexUsageWidget()
        ClaudeUsageWidget()
        RecordingControl()
    }
}

/// Recording status on the Home Screen (small) and Lock Screen (circular, inline).
struct RecordingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: PendantSnapshot.widgetKind, provider: SnapshotProvider()) { entry in
            RecordingWidgetView(entry: entry)
        }
        .configurationDisplayName("Pendant Recording")
        .description("Whether your Pendant is recording, and how recently it said so.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryInline])
    }
}

nonisolated struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: PendantSnapshot
}

/// Reads the snapshot the app writes. The app reloads timelines when what they show changes; entries here only
/// re-render when evidence turns "last known" or a pending request lapses.
nonisolated struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(
            date: .now,
            snapshot: PendantSnapshot(link: .connected, microphone: Observed(.recording, at: .now)))
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: .now, snapshot: Self.current))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let now = Date.now
        let snapshot = Self.current
        let changes = [
            snapshot.recordingTurnsStale(now: now),
            snapshot.batteryCurrentUntil(now: now),
            snapshot.request.map { $0.since.addingTimeInterval(PendantSnapshot.requestExpiry) },
        ]
        let dates = [now] + changes.compactMap { $0 }.filter { $0 > now }.sorted()
        completion(Timeline(entries: dates.map { SnapshotEntry(date: $0, snapshot: snapshot) }, policy: .never))
    }

    private static var current: PendantSnapshot { PendantSnapshot.load() ?? PendantSnapshot(link: .notConnected) }
}

/// The Pendant screen's status sentence, small: "Recording." in the serif with how recently the Pendant said so, a
/// battery ring on the Lock Screen, and one line inline. Never fresher than the snapshot's evidence.
struct RecordingWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SnapshotEntry

    private var snapshot: PendantSnapshot { entry.snapshot }
    private var now: Date { entry.date }
    private var reading: PendantSnapshot.RecordingReading { snapshot.recording(now: now) }
    private var pending: RecordingIntent? { snapshot.pendingRequest(now: now) }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryInline:
                Label {
                    inline
                } icon: {
                    Image(systemName: snapshot.symbol(now: now))
                }
            default: small
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(snapshot.sentence(now: now))
    }

    // MARK: Home Screen

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                StatusDot(state: snapshot.dot(now: now))
                Text("Pendant")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 4)
                if let battery = snapshot.battery {
                    BatteryFigure(percent: battery.value, isCurrent: snapshot.batteryIsCurrent(now: now))
                        .fixedSize()
                }
            }
            Spacer(minLength: 0)
            Text(word)
                .font(.system(size: 30, design: .serif))
                .foregroundStyle(reading.microphone == nil && pending == nil ? .secondary : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            evidence
                .font(.system(.footnote, design: .monospaced))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.top, 4)
            Text(qualifier)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .foregroundStyle(Palette.textPrimary)
        .containerBackground(for: .widget) {
            LinearGradient(
                colors: [Palette.ground.mix(with: Palette.liveDot, by: 0.12), Palette.ground], startPoint: .topLeading,
                endPoint: .bottomTrailing)
        }
    }

    private var word: String {
        if let pending { return pending == .pause ? "Pausing…" : "Resuming…" }
        return switch reading.microphone {
        case .recording?: "Recording."
        case .paused?: "Paused."
        case .unrecognized?, nil: "Unknown."
        }
    }

    @ViewBuilder private var evidence: some View {
        if pending != nil {
            Text("waiting for Pendant")
        } else {
            switch reading {
            case .confirmed(_, let at): Text(.currentDate, format: .ago(at))
            case .lastKnown(_, let at): Text("last known \(at.moment)")
            case .unknown: Text(snapshot.link == .connected ? "no report yet" : "not linked")
            }
        }
    }

    private var qualifier: String {
        if pending != nil { return "Not changed until it confirms" }
        return switch reading {
        case .confirmed: "confirmed by the Pendant"
        case .lastKnown(let microphone, _):
            "\(microphone.word.lowercased()) then · \(snapshot.link == .connected ? "not confirmed since" : "not linked")"
        case .unknown: "never reported"
        }
    }

    // MARK: Lock Screen

    private var circular: some View {
        Gauge(value: Double(snapshot.battery?.value ?? 0), in: 0...100) {
            Text("Pendant")
        } currentValueLabel: {
            VStack(spacing: 1) {
                Image(systemName: circularSymbol)
                    .font(.caption.weight(.semibold))
                Text(circularCaption)
                    .font(.system(.caption2, design: .monospaced))
                    .minimumScaleFactor(0.6)
            }
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .widgetAccentable()
        .containerBackground(.clear, for: .widget)
    }

    private var circularSymbol: String {
        if pending != nil { return "hourglass" }
        return switch reading {
        case .confirmed(.recording, _): "circle.fill"
        case .confirmed(.paused, _): "pause.fill"
        case .confirmed: "ear"
        case .lastKnown, .unknown: "circle.dashed"
        }
    }

    private var circularCaption: String {
        if pending != nil { return "…" }
        return batteryText ?? "—"
    }

    private var inline: Text {
        if let pending {
            return Text(pending == .pause ? "Pausing… · waiting for Pendant" : "Resuming… · waiting for Pendant")
        }
        let battery = batteryText.map { " · \($0)%" } ?? ""
        return switch reading {
        case .confirmed(.recording, let at): Text("Rec · \(Text(.currentDate, format: .ago(at)))\(battery)")
        case .confirmed(let microphone, let at):
            Text("\(microphone.word) · since \(at.formatted(date: .omitted, time: .shortened))\(battery)")
        case .lastKnown(let microphone, let at): Text("\(microphone.word) · last known \(at.moment)\(battery)")
        case .unknown: Text("Pendant · unknown")
        }
    }

    // MARK: Evidence

    /// The level, "~" when last known: paused, off or out of reach, the last level is still worth seeing.
    private var batteryText: String? {
        snapshot.battery.map { (snapshot.batteryIsCurrent(now: now) ? "" : "~") + "\($0.value)" }
    }
}

/// The app's battery glyph with the percentage, in grey when it's last known.
private struct BatteryFigure: View {
    let percent: Int
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: Metrics.Spacing.xs) {
            BatteryGlyph(percent: percent, isCurrent: isCurrent, width: 22)
            Text("\(percent)%")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(percent <= BatteryGlyph.lowAtOrBelow && isCurrent ? Palette.redText : .secondary)
        }
        .accessibilityHidden(true)
    }
}

#if DEBUG
    private let previewEntries: [SnapshotEntry] = {
        let now = Date.now
        let recent = now.addingTimeInterval(-6)
        let old = now.addingTimeInterval(-3_600)
        return [
            PendantSnapshot(
                link: .connected, microphone: Observed(.recording, at: recent), battery: Observed(82, at: recent)),
            PendantSnapshot(
                link: .connected, microphone: Observed(.paused, at: recent), battery: Observed(18, at: recent)),
            PendantSnapshot(
                link: .connected, microphone: Observed(.recording, at: recent),
                request: .init(intent: .pause, since: now, failed: false), battery: Observed(82, at: recent)),
            PendantSnapshot(
                link: .notConnected, microphone: Observed(.recording, at: old), battery: Observed(81, at: old)),
        ].map { SnapshotEntry(date: now, snapshot: $0) }
    }()

    #Preview("Home", as: .systemSmall) {
        RecordingWidget()
    } timeline: {
        for entry in previewEntries { entry }
    }

    #Preview("Lock Screen circular", as: .accessoryCircular) {
        RecordingWidget()
    } timeline: {
        for entry in previewEntries { entry }
    }

    #Preview("Lock Screen inline", as: .accessoryInline) {
        RecordingWidget()
    } timeline: {
        for entry in previewEntries { entry }
    }
#endif
