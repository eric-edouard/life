import LifeConnector
import SwiftUI

/// What happened on a matter, oldest first, a rule for each day: the messages and voice lines its facts cite as bubbles (his on the right), a
/// call, a payment, a moment, an event, a to-do item and Life's own steps as quiet lines. "Earlier" reads the page before.
struct ThreadLines: View {
    let chain: PageChain<MatterThread>
    let earlier: () -> Void

    var body: some View {
        let lines = chain.pages.reversed().flatMap(\.lines)
        let days = lines.reduce(into: [(day: String, lines: [MatterThread.Line])]()) { days, line in
            if days.last?.day == line.day {
                days[days.count - 1].lines.append(line)
            } else {
                days.append((line.day, [line]))
            }
        }
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            earlierRow
            ForEach(days, id: \.day) { day in
                DayRule(day: day.day)
                ForEach(day.lines) { ThreadLineView(line: $0) }
            }
            if case .more = chain.next, lines.isEmpty { Placeholder(height: 110) }
        }
        .motion(Motion.standard, value: lines.count)
    }

    /// Where older days wait; while they are read it says so, and a page that failed offers Try again.
    @ViewBuilder private var earlierRow: some View {
        switch chain.next {
        case .more where !chain.pages.isEmpty:
            QuietChip("Earlier", symbol: "chevron.up", action: earlier)
        case .reading where !chain.pages.isEmpty:
            HStack(spacing: 6) {
                Spinner(size: .small)
                Text("Reading earlier days…").font(.small).foregroundStyle(Palette.muted)
            }
        case .failed:
            QuietChip("Earlier days didn't load. Try again", symbol: "arrow.clockwise", action: earlier)
        default: EmptyView()
        }
    }

    /// A day as Life dated it (`day`, his local day), in words: "Today", else "Tue 17 Nov".
    static func dayWords(_ day: String) -> String {
        guard let date = try? Date(day, strategy: Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
        else { return day }
        return Calendar.current.isDateInToday(date) ? "Today" : date.dayAndMonth
    }
}

private struct DayRule: View {
    let day: String

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Divider().overlay(Palette.line)
            Text(ThreadLines.dayWords(day)).font(.small).foregroundStyle(Palette.muted).fixedSize()
            Divider().overlay(Palette.line)
        }
        .padding(.top, Metrics.Spacing.xs)
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
    }
}

/// One line of the thread, by what it is.
private struct ThreadLineView: View {
    let line: MatterThread.Line

    @Environment(AppRouter.self) private var router

    var body: some View {
        switch line.kind {
        case .message, .voice, .quote: bubble
        case .call:
            note(symbol: "phone", words: [line.speaker?.name, line.text].compactMap(\.self).joined(separator: ", "))
        case .payment: note(symbol: "creditcard", words: line.paymentWords ?? line.text)
        case .moment: note(symbol: "clock", words: line.text)
        case .todoItem: note(symbol: "checklist", words: line.text)
        case .event:
            Button {
                if let ref = line.ref { router.appointment = .appointment(ref) }
            } label: {
                note(symbol: "calendar", words: line.text, trailing: "chevron.right")
            }
            .buttonStyle(.plain)
        case .life:
            HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.s) {
                Text("Life").font(.smallStrong).foregroundStyle(Palette.ai)
                Text(line.text).font(.small).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
        case .unknown: note(symbol: "ellipsis", words: line.text)
        }
    }

    /// His words on the right, anyone's on the left under their name and network; the time, and the way into the
    /// message's app when Life has one.
    private var bubble: some View {
        let isHis = line.isHis
        return VStack(alignment: isHis ? .trailing : .leading, spacing: 4) {
            if !isHis {
                HStack(spacing: 6) {
                    if line.kind == .voice { Image(systemName: "waveform").foregroundStyle(Palette.muted) }
                    if let name = line.speaker?.name { Text(name).font(.smallStrong).foregroundStyle(Palette.fg) }
                    NetworkMark(network: line.channel, size: 14)
                }
            }
            Text(line.kind == .quote ? "“\(line.text)”" : line.text).font(.body15).foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.s)
                .background(isHis ? Color.pick : Color.fillTint, in: .rect(cornerRadius: Metrics.Radius.passage))
            HStack(spacing: 4) {
                Text(line.at.formatted(date: .omitted, time: .shortened)).monospacedDigit()
                if let url = line.open {
                    Link(destination: url) {
                        Image(systemName: "arrow.up.right").padding(Metrics.Spacing.m).contentShape(.rect)
                    }
                    .padding(-Metrics.Spacing.m).accessibilityLabel("Open in \(Channel.name(line.channel))")
                }
            }
            .font(.small).foregroundStyle(Palette.faint)
        }
        .frame(maxWidth: .infinity, alignment: isHis ? .trailing : .leading)
    }

    private func note(symbol: String, words: String, trailing: String? = nil) -> some View {
        HStack(spacing: Metrics.Spacing.s) {
            Image(systemName: symbol)
            Text(words).lineLimit(2)
            Text(line.at.formatted(date: .omitted, time: .shortened)).monospacedDigit().foregroundStyle(Palette.faint)
            if let trailing { Image(systemName: trailing).font(.smallStrong) }
        }
        .font(.small).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .center)
        .contentShape(.rect).accessibilityElement(children: .combine)
    }
}
