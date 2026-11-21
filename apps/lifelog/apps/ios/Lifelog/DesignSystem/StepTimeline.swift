import LifeConnector
import SwiftUI

/// A matter's steps as the design's timeline (components.md, "Timeline"): newest first, grouped by day ("Today",
/// "Tue 17 Nov"), on one thin rail with a dot per step (open: `fg`, lit; an agent's: `ai`; past: `muted`); each step who
/// it came from in `small` muted (the time at the right for today's, "Open" in `flag` on an open to-do), then the words
/// said, else the fact. No heading, no numbers.
struct StepTimeline: View {
    /// Oldest first, as Life sends them.
    let steps: [MatterStep]

    var body: some View {
        let days = Dictionary(grouping: steps.reversed(), by: \.day)
        let order = steps.reversed().map(\.day).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        VStack(alignment: .leading, spacing: 0) {
            ForEach(order, id: \.self) { day in
                let dated = days[day] ?? []
                Text(Self.dayWords(day)).font(.label).foregroundStyle(Palette.muted)
                    .padding(.leading, 21).padding(.bottom, Metrics.Spacing.s)
                    .padding(.top, day == order.first ? 0 : Metrics.Spacing.xs)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(alignment: .leading) { if day != order.first { rail } }
                ForEach(dated) { step in
                    StepLine(step: step, isLast: day == order.last && step.id == dated.last?.id)
                }
            }
        }
    }

    private var rail: some View { Rectangle().fill(Palette.line).frame(width: 1).padding(.leading, 4) }

    /// A step's day as Life dated it (`day`, his local day), in words: "Today", else "Tue 17 Nov".
    static func dayWords(_ day: String) -> String {
        guard let date = try? Date(day, strategy: Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
        else { return day }
        return Calendar.current.isDateInToday(date)
            ? "Today" : date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    private struct StepLine: View {
        let step: MatterStep
        let isLast: Bool

        var body: some View {
            let isOpen = step.kind == "todo_item" && step.ending == nil
            HStack(alignment: .top, spacing: Metrics.Spacing.m) {
                dot(isOpen: isOpen).padding(.top, 4)
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.s) {
                        if let who { Text(who).lineLimit(1) }
                        if isOpen { Text("Open").fontWeight(.semibold).foregroundStyle(Palette.flag) }
                        Spacer(minLength: 0)
                        if Calendar.current.isDateInToday(step.at) {
                            Text(step.at.formatted(date: .omitted, time: .shortened)).monospacedDigit()
                        }
                    }
                    .font(.small).foregroundStyle(Palette.muted)
                    // The words as said when there are some, else the fact.
                    Text(step.quote.isEmpty ? step.text : "“\(step.quote)”").font(.bodyMedium)
                        .foregroundStyle(step.ending == nil ? Palette.fg : Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.bottom, isLast ? 0 : Metrics.Spacing.l)
            .background(alignment: .topLeading) {
                if !isLast {
                    Rectangle().fill(Palette.line).frame(width: 1).padding(.leading, 4).padding(.top, 8)
                }
            }
            .accessibilityElement(children: .combine)
        }

        /// Who the step came from: the person, else an agent's or his to-do list's step by its kind; nothing else is
        /// guessed.
        private var who: String? {
            step.with?.name ?? (step.kind == "agent" ? "Agent" : step.kind == "todo_item" ? "To-do list" : nil)
        }

        private func dot(isOpen: Bool) -> some View {
            Circle()
                .fill(isOpen ? Palette.fg : step.kind == "agent" ? Palette.ai : Palette.muted.opacity(0.45))
                .frame(width: 9, height: 9)
                .background(Circle().fill(Palette.bg).frame(width: 9, height: 9))
                .lit(isOpen)
        }
    }
}
