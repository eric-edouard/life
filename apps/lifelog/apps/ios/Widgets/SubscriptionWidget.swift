import AppIntents
import Glance
import SwiftUI
import WidgetKit

nonisolated enum UsageWindowChoice: String, AppEnum {
    case weekly, fiveHour

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Usage period" }
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
        [.weekly: "Weekly", .fiveHour: "Five hours"]
    }

    func window(in reading: SubscriptionUsage?) -> SubscriptionUsage.Window? {
        self == .weekly ? reading?.sevenDay : reading?.fiveHour
    }
}

struct UsageWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Subscription Usage"
    static let description = IntentDescription("Choose the weekly or five-hour subscription limit.")

    @Parameter(title: "Period", default: .weekly) var period: UsageWindowChoice
}

// A `Widget` is made with `init()`, so each service is its own type over one configuration.
struct CodexUsageWidget: Widget {
    var body: some WidgetConfiguration { usageWidget(.codex) }
}

struct ClaudeUsageWidget: Widget {
    var body: some WidgetConfiguration { usageWidget(.claude) }
}

private func usageWidget(_ service: SubscriptionService) -> some WidgetConfiguration {
    AppIntentConfiguration(
        kind: service.kind, intent: UsageWidgetIntent.self, provider: SubscriptionProvider(service: service)
    ) { entry in
        SubscriptionDial(entry: entry)
    }
    .configurationDisplayName(service.name + " Usage")
    .description("The ring fills as you use your subscription. The center counts down to its reset.")
    .supportedFamilies([.accessoryCircular])
}

nonisolated struct SubscriptionEntry: TimelineEntry {
    let date: Date
    let service: SubscriptionService
    let period: UsageWindowChoice
    let reading: SubscriptionUsage?
}

nonisolated struct SubscriptionProvider: AppIntentTimelineProvider {
    let service: SubscriptionService

    func placeholder(in context: Context) -> SubscriptionEntry { sample() }

    func snapshot(for configuration: UsageWidgetIntent, in context: Context) async -> SubscriptionEntry {
        context.isPreview ? sample() : entry(period: configuration.period)
    }

    func timeline(for configuration: UsageWidgetIntent, in context: Context) async -> Timeline<SubscriptionEntry> {
        // The app writes readings to the app group (`SubscriptionService.save`); this only reads them.
        let now = Date.now
        let reading = service.cached()
        let nextRead = now.addingTimeInterval(SubscriptionUsage.refreshInterval)
        // Minute entries update only the displayed countdown and spend no reload.
        // Reset and freshness boundaries get their own entries, including resets between minute ticks.
        var dates = Set((0...30).map { now.addingTimeInterval(Double($0) * 60) })
        if let reset = configuration.period.window(in: reading)?.resetsAt {
            let date = Date(timeIntervalSince1970: reset)
            if date > now, date < nextRead { dates.insert(date) }
        }
        if let observed = reading?.observedAt {
            let stale = Date(timeIntervalSince1970: observed + SubscriptionUsage.staleAfter)
            if stale > now, stale < nextRead { dates.insert(stale) }
        }
        let entries = dates.sorted().map {
            SubscriptionEntry(date: $0, service: service, period: configuration.period, reading: reading)
        }
        return Timeline(entries: entries, policy: .after(nextRead))
    }

    private func entry(period: UsageWindowChoice) -> SubscriptionEntry {
        SubscriptionEntry(date: .now, service: service, period: period, reading: service.cached())
    }

    private func sample() -> SubscriptionEntry {
        let now = Date.now
        return SubscriptionEntry(
            date: now, service: service, period: .weekly,
            reading: SubscriptionUsage(
                observedAt: now.timeIntervalSince1970,
                sevenDay: .init(usedPercent: 38, resetsAt: now.addingTimeInterval(5 * 86_400).timeIntervalSince1970)))
    }
}

struct SubscriptionDial: View {
    let entry: SubscriptionEntry

    private var window: SubscriptionUsage.Window? { entry.period.window(in: entry.reading) }
    private var expired: Bool { window?.hasReset(now: entry.date) == true }
    private var stale: Bool { entry.reading?.isStale(now: entry.date) == true }

    var body: some View {
        Group {
            if let window, !expired {
                Gauge(value: window.usedPercent, in: 0...100) {
                    Text(entry.service.name)
                } currentValueLabel: {
                    caption
                }
                .gaugeStyle(.accessoryCircularCapacity)
            } else {
                // An unknown or elapsed window must not look like a verified unused quota.
                ZStack {
                    Circle()
                        .stroke(style: StrokeStyle(lineWidth: 4, dash: [2, 3]))
                        .foregroundStyle(.secondary)
                        .padding(4)
                    caption
                }
            }
        }
        .opacity(stale ? 0.5 : 1)
        .widgetAccentable()
        .containerBackground(.clear, for: .widget)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var caption: some View {
        VStack(spacing: 1) {
            Text(entry.service.shortName + (stale ? " ?" : ""))
                .font(.system(size: 9, weight: .semibold))
            Text(window?.countdown(now: entry.date) ?? "—")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }

    private var accessibilitySummary: String {
        let name = entry.service.name + (entry.period == .weekly ? " weekly" : " five-hour")
        guard let window, let reading = entry.reading else {
            return "\(name) usage unavailable."
        }
        if expired { return "\(name) usage reset. Waiting for a new reading." }
        let reset = Date(timeIntervalSince1970: window.resetsAt).formatted(date: .abbreviated, time: .shortened)
        let observed = Date(timeIntervalSince1970: reading.observedAt).formatted(date: .abbreviated, time: .shortened)
        return "\(name), \(Int(window.usedPercent)) percent used. Resets \(reset)."
            + (stale ? " Last known reading from \(observed)." : "")
    }
}

#if DEBUG
    #Preview("ChatGPT usage", as: .accessoryCircular) {
        CodexUsageWidget()
    } timeline: {
        SubscriptionEntry(
            date: .now, service: .codex, period: .weekly,
            reading: .init(
                observedAt: Date.now.timeIntervalSince1970,
                sevenDay: .init(
                    usedPercent: 38, resetsAt: Date.now.addingTimeInterval(5 * 86_400).timeIntervalSince1970)))
    }

    #Preview("Claude usage", as: .accessoryCircular) {
        ClaudeUsageWidget()
    } timeline: {
        SubscriptionEntry(
            date: .now, service: .claude, period: .fiveHour,
            reading: .init(
                observedAt: Date.now.timeIntervalSince1970,
                fiveHour: .init(usedPercent: 82, resetsAt: Date.now.addingTimeInterval(80 * 60).timeIntervalSince1970)))
        SubscriptionEntry(date: .now, service: .claude, period: .weekly, reading: nil)
    }
#endif
