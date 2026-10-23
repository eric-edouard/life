import Accessibility
import Charts
import ServerAPI
import SwiftUI

/// What transcription, summaries, place names and search cost: today, the last 30 days, this month. Shows the driver's last answer at once and reads it again in the background; nothing polls. Every dollar
/// figure is the server's estimate at list prices, so it carries "≈".
struct SpendingSheet: View {
    /// Previews: shown instead of the driver's.
    var preview: ServerClient.UsageSummary?

    @Environment(SyncStore.self) private var sync: SyncStore?
    @Environment(\.dismiss) private var dismiss
    /// The server didn't answer the last read.
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if let summary = preview ?? sync?.spending {
                    ScrollView { SpendingContent(summary: summary).padding(16) }
                } else if sync?.isPaired != true {
                    ContentUnavailableView(
                        "Not paired", systemImage: "key.slash",
                        description: Text("Pair this iPhone with your Mac to see what Life spends."))
                } else if failed {
                    ContentUnavailableView {
                        Label("Couldn't load spending", systemImage: "wifi.slash")
                    } description: {
                        Text("The server didn't answer. It shows once Life reaches it.")
                    } actions: {
                        Button("Try again") { Task { await refresh() } }
                            .accessibilityIdentifier("spending.retry")
                    }
                } else {
                    ProgressView("Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Palette.ground)
            .navigationTitle("Spending")
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.ground)
        .task { await refresh() }
    }

    private func refresh() async {
        guard preview == nil, let sync else { return }
        failed = !(await sync.refreshSpending())
    }
}

/// The loaded summary: three figures, the month's transcription, 30 days of bars and the split by service.
struct SpendingContent: View {
    let summary: ServerClient.UsageSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PeriodFigures(summary: summary)
            MonthCard(month: summary.thisMonth, provider: summary.elevenLabsThisMonth)
            SpendingCard(title: "Last 30 days") {
                DailyChart(days: summary.days, timeZone: TimeZone(identifier: summary.timeZone) ?? .current)
            }
            SpendingCard(title: "By service, last 30 days") {
                ServiceSplit(period: summary.last30Days)
            }
            Text(
                "Estimates from Life's own records at list prices."
            )
            .font(.footnote)
            .foregroundStyle(Palette.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PeriodFigures: View {
    let summary: ServerClient.UsageSummary
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout =
            typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 10))
        layout {
            figure("Today", summary.today)
            figure("Last 30 days", summary.last30Days)
            figure("This month", summary.thisMonth)
        }
    }

    private func figure(_ title: String, _ period: ServerClient.UsageSummary.Period) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(Palette.textSecondary)
            Text(Spend.usd(period.totalUsd))
                .font(.monoFigure)
                .foregroundStyle(Palette.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .card(radius: Metrics.Radius.group)
        .accessibilityElement(children: .combine)
    }
}

/// Hours and dollars transcribed this month, and what ElevenLabs itself reports beside ours.
private struct MonthCard: View {
    let month: ServerClient.UsageSummary.Period
    let provider: ServerClient.UsageSummary.ProviderReport?

    var body: some View {
        SpendingCard(title: "Transcription this month") {
            TileFigure(
                value: Text(Spend.hours(month.transcription.hours)), caption: Spend.usd(month.transcription.usd)
            )
            .accessibilityElement(children: .combine)
            Label {
                if let provider {
                    Text(
                        "ElevenLabs reports \(Spend.hours(provider.hours)) · \(Spend.usd(provider.usd, estimated: false)) this month for the whole workspace"
                    )
                } else {
                    Text("ElevenLabs' own figure is unavailable right now")
                }
            } icon: {
                Image(systemName: "building.columns")
            }
            .font(.footnote)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private enum Service: String, CaseIterable, Plottable {
    case transcription = "Transcription"
    case summaries = "Summaries"
    case search = "Search"

    var style: Color {
        switch self {
        case .transcription: Palette.textBody
        case .summaries: Palette.redText
        case .search: Palette.redFill
        }
    }

    func usd(_ period: ServerClient.UsageSummary.Period) -> Double {
        switch self {
        case .transcription: period.transcription.usd
        case .summaries: period.intelligence.usd
        case .search: period.search.usd
        }
    }
}

/// Stacked daily bars by service. VoiceOver gets a summary, Describe Chart and the Audio Graph of daily totals.
private struct DailyChart: View, AXChartDescriptorRepresentable {
    let days: [ServerClient.UsageSummary.Day]
    let timeZone: TimeZone

    private struct Bar: Identifiable {
        var id: String { "\(day.timeIntervalSince1970)-\(service.rawValue)" }
        var day: Date
        var service: Service
        var usd: Double
    }

    private var bars: [Bar] {
        days.flatMap { day in
            Service.allCases.map { Bar(day: date(day.date), service: $0, usd: $0.usd(day.spent)) }
        }
    }

    var body: some View {
        Chart(bars) { bar in
            BarMark(
                x: .value("Day", bar.day, unit: .day), y: .value("Spent, US dollars", bar.usd)
            )
            .foregroundStyle(by: .value("Service", bar.service))
            .accessibilityLabel(bar.day.formatted(Date.FormatStyle(timeZone: timeZone).day().month(.wide)))
            .accessibilityValue("\(bar.service.rawValue) \(Spend.usd(bar.usd))")
        }
        .chartForegroundStyleScale(
            domain: Service.allCases, range: Service.allCases.map(\.style)
        )
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: 7)) {
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
            }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine().foregroundStyle(Palette.hairline)
                AxisValueLabel {
                    if let usd = value.as(Double.self) { Text(usd, format: .currency(code: "USD")) }
                }
            }
        }
        .chartLegend(position: .bottom, alignment: .leading)
        .environment(\.timeZone, timeZone)
        .font(.monoSmall)
        .frame(height: 180)
        .accessibilityChartDescriptor(self)
    }

    private func date(_ day: String) -> Date {
        (try? Date.ISO8601FormatStyle(timeZone: timeZone).year().month().day().parse(day)) ?? .distantPast
    }

    func makeChartDescriptor() -> AXChartDescriptor {
        let totals = days.map { ($0.date, $0.spent.totalUsd) }
        let peak = totals.max { $0.1 < $1.1 }
        let label: (String) -> String = { day in
            date(day).formatted(Date.FormatStyle(timeZone: timeZone).day().month(.wide))
        }
        let summary =
            if let peak, peak.1 > 0 {
                "About \(Spend.usd(peak.1, estimated: false)) at most, on \(label(peak.0)). "
                    + "\(Spend.usd(totals.reduce(0) { $0 + $1.1 }, estimated: false)) over 30 days."
            } else {
                "Nothing spent in the last 30 days."
            }
        let maxUSD = max(peak?.1 ?? 0, 0.01)
        return AXChartDescriptor(
            title: "Estimated spending per day, last 30 days", summary: summary,
            xAxis: AXCategoricalDataAxisDescriptor(title: "Day", categoryOrder: totals.map { label($0.0) }),
            yAxis: AXNumericDataAxisDescriptor(title: "US dollars", range: 0...maxUSD, gridlinePositions: []) {
                Spend.usd($0, estimated: false)
            },
            additionalAxes: [],
            series: [
                AXDataSeriesDescriptor(
                    name: "Total", isContinuous: false,
                    dataPoints: totals.map { AXDataPoint(x: label($0.0), y: $0.1) })
            ])
    }
}

private struct ServiceSplit: View {
    let period: ServerClient.UsageSummary.Period

    var body: some View {
        VStack(spacing: 0) {
            TileRow(
                "Transcription",
                "\(Spend.usd(period.transcription.usd)) · \(Spend.hours(period.transcription.hours))")
            TileRow("Summaries", summaries)
            TileRow("Search", Spend.usd(period.search.usd))
        }
    }

    private var summaries: String {
        let providers = period.intelligence.byProvider.filter { $0.value > 0 }.sorted { $0.key < $1.key }
            .map { "\(Spend.provider($0.key)) \(Spend.usd($0.value))" }
        var text = Spend.usd(period.intelligence.usd)
        if providers.count > 1 { text += " · " + providers.joined(separator: " · ") }
        if period.intelligence.unpricedRuns > 0 { text += " · \(period.intelligence.unpricedRuns) unpriced" }
        return text
    }
}

private struct SpendingCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: Metrics.Radius.group)
    }
}

/// How spending is written: "≈ $1.24" for an estimate, "$0" for nothing at all, hours to one decimal.
enum Spend {
    static func usd(_ value: Double, estimated: Bool = true) -> String {
        if value == 0 { return "$0" }
        if value < 0.01 { return "< $0.01" }
        let amount = value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
        return estimated ? "≈ \(amount)" : amount
    }

    static func hours(_ value: Double) -> String {
        "\(value.formatted(.number.precision(.fractionLength(value < 10 ? 1 : 0)))) h"
    }

    static func provider(_ key: String) -> String {
        switch key {
        case "openai": "OpenAI"
        case "anthropic": "Anthropic"
        default: key
        }
    }
}

#if DEBUG
    extension ServerClient.UsageSummary {
        /// A month of plausible spending, decoded from the server's JSON shape.
        static func preview(provider: Bool = true) throws -> Self {
            func period(_ hours: Double, _ summaries: Double, _ calls: Int) -> String {
                let usd = hours * 0.22
                return """
                    "transcription": {"hours": \(hours), "usd": \(usd)},
                    "intelligence": {"byProvider": {"openai": \(summaries), "anthropic": 0}, "unpricedRuns": 0, "usd": \(summaries)},
                    "search": {"tokens": \(calls * 900), "usd": 0.0004}, "totalUsd": \(usd + summaries + 0.0004)
                    """
            }
            let calendar = Calendar(identifier: .gregorian)
            let days = (0..<30).map { offset -> String in
                let date = calendar.date(byAdding: .day, value: offset - 29, to: .now) ?? .now
                let day = date.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
                let hours = offset % 6 == 0 ? 0 : Double((offset * 7) % 5) + 0.5
                return "{\"date\": \"\(day)\", \(period(hours, hours * 0.03, offset % 3))}"
            }
            let json = """
                {"timeZone": "\(TimeZone.current.identifier)",
                 "today": {\(period(2.5, 0.08, 4))},
                 "last30Days": {\(period(61, 1.9, 30))},
                 "thisMonth": {\(period(14.2, 0.42, 9))},
                 "days": [\(days.joined(separator: ","))],
                 "elevenLabsThisMonth": \(provider ? "{\"hours\": 15.1, \"usd\": 3.32}" : "null")}
                """
            return try JSONDecoder().decode(Self.self, from: Data(json.utf8))
        }
    }

    #Preview("Spending") {
        SpendingSheet(preview: try? .preview())
            .preferredColorScheme(.dark)
    }

    #Preview("Spending, ElevenLabs silent") {
        SpendingSheet(preview: try? .preview(provider: false))
            .preferredColorScheme(.dark)
    }

    #Preview("Spending, no token") {
        SpendingSheet().previewSync().preferredColorScheme(.dark)
    }
#endif
