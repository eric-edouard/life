import Glance
import SwiftUI
import WidgetKit

@main
struct LifelogWatchWidgets: WidgetBundle {
    var body: some Widget {
        RecordingComplication()
    }
}

/// "Am I recording?" and the battery on the watch face, from the glance the iPhone last sent: rectangular for the
/// Modular face's large slot, circular for its small ones, corner and inline. The rectangular one is a remote: Record
/// or Pause and Split buttons whose intents run in the Watch app (`FaceIntents.swift`). The small ones have
/// room for one tap, which opens the app and pauses or resumes from there, in one go.
struct RecordingComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecordingComplication", provider: GlanceProvider()) { entry in
            ComplicationView(entry: entry)
        }
        .configurationDisplayName("Pendant Recording")
        .description("Whether your Pendant is recording, and its battery. Pause, resume and split from here.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryCorner, .accessoryInline])
    }
}

nonisolated struct GlanceEntry: TimelineEntry {
    let date: Date
    let glance: RecordingGlance?
    /// What the last face tap did, while it's recent.
    var note: FaceNote?
}

/// The Watch app reloads timelines when a new glance arrives or a face tap ends; entries here only re-render when what
/// it says goes out of date (the reading turns "last known", a request stops waiting, a tap's note expires).
nonisolated struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(
            date: .now,
            glance: RecordingGlance(
                connected: true, microphone: .recording, reportedAt: .now, currentUntil: .now + 300, battery: 82))
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        completion(GlanceEntry(date: .now, glance: RecordingGlance.stored(), note: FaceNote.stored()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        let now = Date.now
        let glance = RecordingGlance.stored()
        let note = FaceNote.stored()
        let changes = ((glance?.changeDates ?? []) + [note?.until].compactMap(\.self))
            .filter { $0 > now }.sorted()
        let entries = ([now] + changes).map { GlanceEntry(date: $0, glance: glance, note: note) }
        completion(Timeline(entries: entries, policy: .never))
    }
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    private var now: Date { entry.date }

    var body: some View {
        Group {
            if let glance = entry.glance {
                switch family {
                case .accessoryCircular: circular(glance)
                case .accessoryRectangular: remote(glance)
                case .accessoryCorner: corner(glance)
                default: inline(glance)
                }
            } else {
                Image(systemName: "questionmark.circle")
                    .widgetLabel("lifelog · open on iPhone")
                    .accessibilityLabel("Pendant recording unknown. Open lifelog on your iPhone.")
            }
        }
        .containerBackground(.clear, for: .widget)
        // A small slot's tap opens the Watch app, which sends the pause or resume this face showed; with nothing to
        // flip, it just opens. The remote's buttons say what they do, so a tap elsewhere on it only opens the app.
        .widgetURL(family == .accessoryRectangular ? nil : entry.glance?.toggle(now: now)?.url)
    }

    /// The last tap's outcome while recent.
    private var note: FaceNote? {
        entry.note.flatMap { now < $0.until ? $0 : nil }
    }

    /// The small slots: the state in the middle, the battery as the ring around it, its last level when not current.
    @ViewBuilder
    private func circular(_ glance: RecordingGlance) -> some View {
        let state = VStack(spacing: 1) {
            Image(systemName: glance.symbol(now: now))
                .font(glance.battery == nil ? .title3 : .body)
                .widgetAccentable()
            Text(glance.shortWord(now: now))
                .font(.system(.caption2, design: .monospaced))
                .minimumScaleFactor(0.6)
        }
        Group {
            if let battery = glance.battery {
                Gauge(value: Double(battery), in: 0...100) {
                    Text("Battery")
                } currentValueLabel: {
                    state
                }
                .gaugeStyle(.accessoryCircularCapacity)
            } else {
                ZStack {
                    AccessoryWidgetBackground()
                    state
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(glance.sentence(now: now))
    }

    /// Status on top (or what the last tap did), then Record or Pause, and Split. Record or Pause shows what a
    /// tap asks for, from the Pendant's confirmed state; with nothing to flip (waiting, not connected) it shows why and
    /// a tap only opens the app. Split is offered only while the Pendant records.
    private func remote(_ glance: RecordingGlance) -> some View {
        AccessoryWidgetGroup {
            HStack(spacing: 4) {
                StatusDot(state: glance.dot(now: now), size: 8)
                    .widgetAccentable()
                Text(note?.text ?? glance.headline(now: now))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .invalidatableContent()
                if note == nil, let battery = glance.batteryLine(now: now) {
                    Text(battery).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(note.map { $0.detail ?? $0.text } ?? glance.sentence(now: now))
        } content: {
            if let request = glance.toggle(now: now) {
                Button(intent: FaceRecordingIntent(value: request == .resume)) {
                    Image(systemName: request == .pause ? "pause.fill" : "record.circle")
                        .widgetAccentable()
                }
                .accessibilityLabel(request == .pause ? "Pause recording" : "Resume recording")
            } else {
                Image(systemName: glance.symbol(now: now))
                    .accessibilityLabel("\(glance.headline(now: now)) Opens lifelog.")
            }
            if glance.isRecording(now: now) {
                Button(intent: FaceSplitIntent()) {
                    Image(systemName: "scissors")
                }
                .accessibilityLabel("Split the conversation here")
            } else {
                Image(systemName: "scissors")
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Split, offered while recording")
            }
        }
    }

    private func corner(_ glance: RecordingGlance) -> some View {
        Image(systemName: glance.symbol(now: now))
            .font(.title3)
            .widgetAccentable()
            .widgetLabel(glance.headline(now: now) + (glance.batteryLine(now: now).map { " \($0)" } ?? ""))
            .accessibilityLabel(glance.sentence(now: now))
    }

    private func inline(_ glance: RecordingGlance) -> some View {
        Label {
            let battery = glance.batteryLine(now: now).map { " · \($0)" } ?? ""
            if case .confirmed(.recording, let at) = glance.reading(now: now), glance.pendingRequest(now: now) == nil {
                Text("Rec · \(Text(.currentDate, format: .ago(at)))\(battery)")
            } else {
                Text(glance.headline(now: now) + battery)
            }
        } icon: {
            Image(systemName: glance.symbol(now: now))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(glance.sentence(now: now))
    }
}

#if DEBUG
    #Preview("Rectangular", as: .accessoryRectangular) {
        RecordingComplication()
    } timeline: {
        GlanceEntry(
            date: .now,
            glance: RecordingGlance(
                connected: true, microphone: .recording, reportedAt: .now, currentUntil: .now + 300, battery: 82))
        GlanceEntry(
            date: .now,
            glance: RecordingGlance(
                connected: true, microphone: .paused, reportedAt: .now, currentUntil: .now + 300, battery: 82))
        GlanceEntry(
            date: .now,
            glance: RecordingGlance(
                connected: true, microphone: .recording, reportedAt: .now, currentUntil: .now + 300, battery: 82),
            note: FaceNote(text: "Split at 14:02", until: .now + 60))
        GlanceEntry(
            date: .now, glance: RecordingGlance(connected: false, microphone: .recording, reportedAt: .now - 900))
    }
#endif
