import LifeConnector
import SwiftUI

/// The Live logs page's pieces, in the spirit of LogTape's console inside Life's tokens: everything mono 13 / 19.
extension LogLevel {
    /// The tag's colour: `INF` in `ok`, `WRN` in `fg` (Life has no amber, his ruling of 21 Nov), `ERR` in `flag`.
    var color: Color {
        switch self {
        case .info, .unknown: Palette.ok
        case .warn: Palette.fg
        case .error: Palette.flag
        }
    }
}

extension LogLine {
    /// `14:32:07`, on a 24-hour clock whatever the phone's setting: a log's time.
    var clockTime: String {
        at.formatted(
            .verbatim(
                "\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits):\(second: .twoDigits)",
                timeZone: .current, calendar: .current))
    }

    /// `Sat 21 Nov, 14:20:03.412`: the detail's time.
    var fullTime: String {
        at.formatted(
            .verbatim(
                "\(weekday: .abbreviated) \(day: .defaultDigits) \(month: .abbreviated), \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits):\(second: .twoDigits).\(secondFraction: .fractional(3))",
                locale: Locale(identifier: "en_GB"), timeZone: .current, calendar: .current))
    }

    /// The message, its values in `ai`.
    var shownMessage: AttributedString {
        parts.reduce(into: AttributedString()) { text, part in
            switch part {
            case .text(let words): text += AttributedString(words)
            case .value(let value):
                var shown = AttributedString(value)
                shown.foregroundColor = Palette.ai
                text += shown
            }
        }
    }

    /// The line as Copy gives it.
    var copyText: String { "\(fullTime)  \(level.tag)  \(categoryWords)  \(message)" }
}

/// One line: the tag in bold, the category in `muted` cut with "…", the time at the right; under it, indented to the
/// category, the message in `fg` with its values in `ai`, at most 2 lines. No hairlines; a new line tints `tile` for 1 s.
struct LogRow: View {
    let line: LogLine
    var isTinted = false
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    tag
                    Text(line.categoryWords).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: Metrics.Spacing.s)
                    Text(line.clockTime).foregroundStyle(Palette.muted)
                }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    tag.hidden()
                    Text(line.shownMessage).foregroundStyle(Palette.fg).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.codeBlock)
            .padding(.vertical, 9).padding(.horizontal, Metrics.Spacing.m)
            .background(isTinted ? Palette.tile : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(line.level.rawValue), \(line.categoryWords), \(line.clockTime): \(line.message)")
    }

    private var tag: some View { Text(line.level.tag).fontWeight(.bold).foregroundStyle(line.level.color) }
}

/// Where Life answered again after it did not: "Back at 14:40", centred in `muted`.
struct LogBackRow: View {
    let at: Date

    var body: some View {
        Text("Back at \(at.formatted(date: .omitted, time: .shortened))")
            .font(.small).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity).padding(.vertical, Metrics.Spacing.s)
    }
}

/// The list's end: a spinner while older lines load, or "Nothing earlier".
struct LogEndRow: View {
    let isLoading: Bool

    var body: some View {
        Group {
            if isLoading {
                Spinner(size: .small).foregroundStyle(Palette.fg)
            } else {
                Text("Nothing earlier").font(.small).foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Metrics.tapTarget)
    }
}

/// "12 new ↑" over the paused list: `fg` on `card`; a tap follows again.
struct NewLinesPill: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Metrics.Spacing.s) {
                Text("\(count) new")
                Image(systemName: "arrow.up").accessibilityHidden(true)
            }
            .font(.smallStrong).foregroundStyle(Palette.fg)
            .padding(.horizontal, Metrics.Spacing.l).frame(minHeight: 36)
            .background(Palette.card, in: .capsule)
            .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) new lines, follow")
    }
}

/// A page's centred quiet word: Live logs' empty states.
struct LogQuiet: View {
    let text: String
    var glyph: String?

    var body: some View {
        VStack(spacing: Metrics.Spacing.m) {
            if let glyph {
                Image(systemName: glyph).font(.sheetQuestion).foregroundStyle(Palette.ok).accessibilityHidden(true)
            }
            Text(text).font(.body15).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 240).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// All · Problems: the level the list shows.
struct LogLevelChoice: View {
    @Binding var isProblems: Bool

    var body: some View {
        SegmentedChoice(
            choices: [false, true],
            selection: Binding(get: { isProblems }, set: { isProblems = $0 ?? isProblems }),
            title: { $0 ? "Problems" : "All" }
        )
        .frame(maxWidth: 176)
    }
}

/// The process menu: the current choice ("All processes ⌄") on a `tile` capsule, opening the system's menu with a check
/// on the current one.
struct LogProcessMenu: View {
    @Binding var process: LogProcess?

    var body: some View {
        Menu {
            Picker("Process", selection: $process) {
                Text("All processes").tag(LogProcess?.none)
                ForEach(LogProcess.allCases, id: \.self) { Text($0.name).tag(LogProcess?.some($0)) }
            }
        } label: {
            HStack(spacing: 6) {
                Text(process?.name ?? "All processes").lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down").foregroundStyle(Palette.muted).accessibilityHidden(true)
            }
            .font(.rowName).foregroundStyle(Palette.fg)
            .padding(.leading, 18).padding(.trailing, 14).frame(maxWidth: .infinity, minHeight: 48)
            .background(Palette.tile, in: .capsule)
        }
        .accessibilityLabel("Process: \(process?.name ?? "All processes")")
    }
}

extension View {
    /// Lines shown while Life does not answer: dimmed to 60%.
    func dimmed(_ isDimmed: Bool) -> some View { opacity(isDimmed ? 0.6 : 1) }
}
