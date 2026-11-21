import Charts
import LifeConnector
import SwiftUI

/// What Life costs (Settings, decision 83), for looking only: this month's billed dollars and a bar a day, then its lists
/// (`ModelSpending.sections`: billed and his plans' tokens never added). A top agent opens its sheet over its matter, a
/// top matter its page.
struct SpendingPage: View {
    /// Settings' Life page, for "Pair with Life".
    let pair: () -> Void
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ReadScreen(
            shown: life.spending.shown(), retry: { await life.refreshSpending() }, pair: pair,
            loading: { Spinner().foregroundStyle(Palette.fg).frame(maxHeight: .infinity) },
            empty: { EmptyView() },
            content: page
        )
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.sheet)
        .screenTitle("Spending")
        // On entry, on a new pairing, and back in front: "Today" is never yesterday's.
        .task(id: [AnyHashable(life.parties.generation.current), AnyHashable(scenePhase == .active)]) {
            if scenePhase == .active { await life.refreshSpending() }
        }
    }

    private func page(_ spending: ModelSpending) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xl) {
                SpendFigures(spending: spending)
                ForEach(spending.sections, id: \.label) { section in
                    RowGroup(label: section.label, surface: .sheet) {
                        ForEach(section.lines) { row($0) }
                    }
                }
            }
            .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.xl).readingWidth()
        }
    }

    /// Its name, its figure in strong text ($0 muted), one muted line, and its share of the month as a bar under it.
    @ViewBuilder private func row(_ line: SpendLine) -> some View {
        let open = opening(line.opens)
        let step: TypeStep = line.isZero ? .rowFigure : .rowName
        let shown = VStack(spacing: 0) {
            Row(title: line.title, detail: line.detail) {
                Text(line.value).monospacedDigit().font(step)
                    .foregroundStyle(line.isZero ? Palette.muted : Palette.fg)
                if open != nil { RowValue() }
            }
            if let share = line.share { ProgressLine(fraction: share).padding(.horizontal, Metrics.Spacing.l) }
        }
        if let open {
            Button(action: open) { shown }.buttonStyle(.plain)
        } else {
            shown
        }
    }

    /// A top matter opens its page; a top agent its sheet over the matter its read names, when it names one.
    private func opening(_ opens: SpendLine.Opens?) -> (() -> Void)? {
        switch opens {
        case .matter(let id): return { router.open(matter: id) }
        case .agent(let id):
            guard let matter = life.agents.value?.agents.first(where: { $0.id == id })?.matter else { return nil }
            return { router.open(agent: id, matter: matter.id) }
        case nil: return nil
        }
    }
}

/// The figure card: the month's billed total big, today's (or a pressed day's) beside it, and a bar a day under them,
/// today's lit.
private struct SpendFigures: View {
    let spending: ModelSpending
    /// The day a press on the bars picked.
    @State private var picked: String?

    var body: some View {
        let day = picked.flatMap { picked in spending.days.first { $0.day == picked } }
        VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
            HStack(alignment: .lastTextBaseline) {
                figure(spending.monthName(), spending.month.amount, step: .screenName, alignment: .leading)
                Spacer(minLength: Metrics.Spacing.m)
                figure(
                    day.map { spending.dayLabel($0.day) } ?? "Today", day?.billed.amount ?? spending.today.amount,
                    step: .tileFigure, alignment: .trailing)
            }
            Chart(spending.days, id: \.day) { day in
                BarMark(x: .value("Day", day.day), y: .value("Billed", day.billed.amount))
                    .foregroundStyle(day.day == spending.days.last?.day ? Palette.fg : Color.fillTint)
                    .accessibilityLabel(spending.dayLabel(day.day))
                    .accessibilityValue(SpendWords.dollars(day.billed.amount))
            }
            .chartXAxis(.hidden).chartYAxis(.hidden)
            .chartXSelection(value: $picked)
            .frame(height: Metrics.trend)
            HStack {
                Text(spending.days.first.map { spending.dayLabel($0.day) } ?? "")
                Spacer()
                Text("Today")
            }
            .font(.small).foregroundStyle(Palette.muted)
        }
        .padding(Metrics.Spacing.l)
        .background(Surface.sheet.fill, in: .rect(cornerRadius: Metrics.Radius.card))
    }

    private func figure(_ label: String, _ amount: Double, step: TypeStep, alignment: HorizontalAlignment)
        -> some View
    {
        VStack(alignment: alignment, spacing: Metrics.Spacing.xs) {
            Text(label).font(.small).foregroundStyle(Palette.muted)
            Text(SpendWords.dollars(amount)).monospacedDigit().font(step).foregroundStyle(Palette.fg)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The one quiet line at the very end of an agent's or a matter's page: what its agents spent of his plans.
struct SpendingLine: View {
    let text: String

    var body: some View {
        Text(text).monospacedDigit().font(.small).foregroundStyle(Palette.faint)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Metrics.Spacing.xl)
    }
}
