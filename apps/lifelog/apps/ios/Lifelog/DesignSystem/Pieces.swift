import LifeConnector
import SwiftUI

/// The pieces every v1 screen is drawn with (the app design's `ak-p`, `ak-b`, `chip`, `tile`): a fill of the palette,
/// never a border, and nothing tappable under 44 points.
extension Color {
    /// The quiet fill of a secondary button or a chip: the page's ink at a low strength, as the design's `--tint`.
    static let fillTint = Palette.fg.opacity(0.08)
}

/// The pill buttons: the filled one (cream in dark) and the quiet one, in two sizes, and busy while an action runs.
struct PillStyle: ButtonStyle {
    enum Kind { case filled, quiet }
    /// `large` is a screen's or a sheet's answer; `compact` sits inside a card or a row.
    enum Size: CGFloat { case large = 54, compact = 44 }

    let kind: Kind
    var size: Size = .large
    /// The action is running: the quiet fill, a spinner then the label, and no taps.
    var isBusy = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let isFilled = kind == .filled && !isBusy
        HStack(spacing: 8) {
            if isBusy { ProgressView().controlSize(.small).tint(Palette.fg).frame(width: 18, height: 18) }
            configuration.label
        }
        .font(.buttonLabel)
        .foregroundStyle(isFilled ? Palette.on : Palette.fg)
        .frame(maxWidth: .infinity, minHeight: size.rawValue)
        .background(isFilled ? Palette.fg : Color.fillTint, in: .capsule)
        .opacity(isBusy ? 1 : isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
        .contentShape(.capsule)
        .allowsHitTesting(!isBusy)
    }
}

extension ButtonStyle where Self == PillStyle {
    static func pill(_ kind: PillStyle.Kind, size: PillStyle.Size = .large, isBusy: Bool = false) -> PillStyle {
        PillStyle(kind: kind, size: size, isBusy: isBusy)
    }
}

/// A count on a tab or a row: 20 high, the flag fill.
struct CountBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)").font(.badge).foregroundStyle(Palette.on)
            .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20).background(Palette.flag, in: .capsule)
    }
}

/// A 44-high text button: `fg` for an action, `muted` with an arrow for a jump out of the app.
struct TextLink: View {
    let title: String
    var isOutward = false
    let action: () -> Void

    init(_ title: String, isOutward: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.isOutward = isOutward
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            (isOutward ? Text("\(title) \(Image(systemName: "arrow.up.right"))") : Text(verbatim: title))
                .font(.smallStrong).foregroundStyle(isOutward ? Palette.muted : Palette.fg)
                .frame(minHeight: 44)
        }
    }
}

/// Two or three choices in one capsule; tapping the chosen one clears it.
struct SegmentedChoice<Choice: Hashable>: View {
    let choices: [Choice]
    @Binding var selection: Choice?
    let title: (Choice) -> String

    var body: some View {
        HStack(spacing: 0) {
            ForEach(choices, id: \.self) { choice in
                let isChosen = selection == choice
                Button {
                    selection = isChosen ? nil : choice
                } label: {
                    Text(title(choice)).font(.chip).foregroundStyle(isChosen ? Palette.on : Palette.fg)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(isChosen ? Palette.fg : .clear, in: .capsule)
                }
                .buttonStyle(.plain).accessibilityAddTraits(isChosen ? .isSelected : [])
            }
        }
        .background(Palette.tile, in: .capsule)
    }
}

extension View {
    /// A draft, a piece of evidence or a clip on paper: the `paper` fill at the passage radius (a quote sits on `tile`).
    func paperBox() -> some View {
        background(Palette.paper, in: .rect(cornerRadius: Metrics.Radius.passage))
    }
}

/// A `label`, a 1 px track filled by how far it got, and an end word (a deadline in `flag`, or a percent).
struct ProgressLine: View {
    var label: String?
    let fraction: Double
    var end: String?
    var endColor = Palette.muted

    init(label: String? = nil, fraction: Double, end: String? = nil, endColor: Color = Palette.muted) {
        self.label = label
        self.fraction = min(max(fraction, 0), 1)
        self.end = end
        self.endColor = endColor
    }

    var body: some View {
        HStack(spacing: 12) {
            if let label { Caps(label, color: Palette.muted) }
            Capsule().fill(Palette.line).frame(height: 1)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in Capsule().fill(Palette.fg).frame(width: proxy.size.width * fraction) }
                }
            if let end { Caps(end, color: endColor) }
        }
        .frame(height: 24)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// A `card` fill at the card radius with 16 of padding: the goal and next step, an agent, a choice waiting.
    func box() -> some View {
        padding(16).frame(maxWidth: .infinity, alignment: .leading).card(radius: Metrics.Radius.card)
    }
}

/// A small label in capitals over a block.
struct Caps: View {
    let text: String
    var color: Color = Palette.faint

    init(_ text: String, color: Color = Palette.faint) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text).label().foregroundStyle(color)
    }
}

/// The dot beside a state word: filled, in the state's colour; lit and breathing while it is recording.
struct StateDot: View {
    var color: Color
    var isLit = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isDim = false

    var body: some View {
        Circle().fill(color).frame(width: Metrics.dot, height: Metrics.dot)
            .shadow(color: isLit ? color.opacity(0.5) : .clear, radius: 4)
            .opacity(isLit && isDim ? 0.45 : 1)
            .animation(
                isLit && !reduceMotion ? .easeInOut(duration: Motion.pulse / 2).repeatForever() : nil, value: isDim
            )
            .onAppear { isDim = isLit }
            .accessibilityHidden(true)
    }
}

/// A filter chip: its name, its value, a chevron; filled when it holds a choice.
struct FilterChip: View {
    let name: String
    var value: String?
    var isOn = false
    var hasMenu = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Text(name)
                if let value { Text(value).opacity(isOn ? 0.6 : 1).foregroundStyle(isOn ? Palette.on : Palette.muted) }
                if hasMenu {
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).accessibilityHidden(
                        true)
                }
            }
            .font(.chip)
            .foregroundStyle(isOn ? Palette.on : Palette.fg)
            .padding(.horizontal, 15)
            .frame(minHeight: 40)
            .background(isOn ? Palette.fg : Palette.card, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .fixedSize()
    }
}

/// One line of proof or progress: a check that passed, one under way, one waiting, one that failed.
struct CheckLine: Identifiable, Equatable {
    enum Mark { case passed, running, waiting, failed }

    let id: String
    var text: String
    var mark: Mark

    /// A check's lines: the first `passed` passed, the one that failed (`failedAt`) failed, the next running while
    /// `isRunning`, the rest waiting.
    static func lines(_ prefix: some Hashable, _ words: [String], passed: Int, failedAt: Int?, isRunning: Bool = false)
        -> [CheckLine]
    {
        words.enumerated().map { index, text in
            let mark: Mark =
                if index == failedAt {
                    .failed
                } else if index < passed {
                    .passed
                } else if index == passed && isRunning && failedAt == nil {
                    .running
                } else {
                    .waiting
                }
            return CheckLine(id: "\(prefix)-\(index)", text: text, mark: mark)
        }
    }
}

struct CheckLines: View {
    let lines: [CheckLine]
    /// The design draws a failure in the flag colour and the rest quiet.
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            ForEach(lines) { line in
                HStack(alignment: .firstTextBaseline, spacing: 11) {
                    mark(line.mark).frame(width: 18, alignment: .center)
                    Text(line.text)
                        .font(.body15)
                        .foregroundStyle(color(line.mark))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text("\(line.text), \(spoken(line.mark))"))
            }
        }
    }

    private func mark(_ mark: CheckLine.Mark) -> some View {
        switch mark {
        case .passed: StateGlyph.ok
        case .running: StateGlyph.busy
        case .waiting: StateGlyph.off
        case .failed: StateGlyph.flag
        }
    }

    private func color(_ mark: CheckLine.Mark) -> Color {
        switch mark {
        case .passed, .running: Palette.fg
        case .waiting: Palette.muted
        case .failed: Palette.flag
        }
    }

    private func spoken(_ mark: CheckLine.Mark) -> String {
        switch mark {
        case .passed: "done"
        case .running: "in progress"
        case .waiting: "waiting"
        case .failed: "failed"
        }
    }
}

// MARK: State marks, rows and fields

/// The one table of state glyphs, drawn 16 points: a check that worked, a dot that is off, a mark that needs him, a
/// spinner. `CheckLines` and `StateMark` both draw from it.
enum StateGlyph: View {
    case ok, off, flag, busy

    var color: Color {
        switch self {
        case .ok: Palette.ok
        case .off: Palette.muted
        case .flag: Palette.flag
        case .busy: Palette.fg
        }
    }

    var body: some View {
        Group {
            switch self {
            case .ok: Image(systemName: "checkmark").font(.system(size: 13, weight: .bold))
            case .off: Circle().frame(width: 6, height: 6)
            case .flag: Image(systemName: "exclamationmark.circle").font(.system(size: 14, weight: .semibold))
            case .busy: ProgressView().controlSize(.small).tint(Palette.fg)
            }
        }
        .foregroundStyle(color)
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
    }
}

/// A state as a glyph and a word in the glyph's colour, never a filled pill: "Works", "Off", "No answer".
struct StateMark: View {
    let glyph: StateGlyph
    let word: String

    var body: some View {
        HStack(spacing: 6) {
            glyph
            Text(word).font(.smallStrong).foregroundStyle(glyph.color)
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// What a surface is, so a fill never clashes with it: a row group or a field is `card` on the page, `tile` on a sheet.
enum Surface {
    case page, sheet

    var fill: Color {
        switch self {
        case .page: Palette.card
        case .sheet: Palette.tile
        }
    }
}

/// Where a row's value stands. A value the server holds is never shown as known before it said (`ServerValue`); the
/// other rows are always `known`. `saved` is view state, shown 2 s after a change was accepted.
enum RowState: Equatable {
    case known, asking, saving, saved
    /// The change did not go: the control is back on the old value, the line says why.
    case refused(String)
}

/// One row of a `RowGroup`: a title, an optional second line, and one thing at the trailing edge (a `RowValue`, a
/// `RowMenu`, a `RowSwitch`, a `StateMark`, a `RowButton`). The state sets the second line and the spinner.
struct Row<Trailing: View>: View {
    let title: String
    /// An SF Symbol in line style, in a 28 slot before the title.
    var icon: String?
    var iconTint = Palette.icon
    var detail: String?
    var state = RowState.known
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            if let icon {
                Image(systemName: icon).font(.system(size: 22, weight: .regular)).foregroundStyle(iconTint)
                    .frame(width: 28).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.rowName).foregroundStyle(Palette.fg)
                line
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                if state == .asking || state == .saving { StateGlyph.busy }
                if state != .asking { trailing }
            }
            .tint(Palette.fg)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: state == .known && detail == nil ? 56 : 64)
        .contentShape(.rect)
    }

    @ViewBuilder private var line: some View {
        switch state {
        case .known:
            if let detail { Text(detail).font(.small).foregroundStyle(Palette.muted) }
        case .asking: Text("Asking the server…").font(.small).foregroundStyle(Palette.muted)
        case .saving: Text("Saving…").font(.small).foregroundStyle(Palette.muted)
        case .saved:
            HStack(spacing: 6) {
                StateGlyph.ok
                Text("Saved").font(.smallStrong)
            }
            .foregroundStyle(Palette.ok)
        case .refused(let message): Text(message).font(.small).foregroundStyle(Palette.flag)
        }
    }
}

extension Row where Trailing == EmptyView {
    init(
        title: String, icon: String? = nil, iconTint: Color = Palette.icon, detail: String? = nil,
        state: RowState = .known
    ) {
        self.init(title: title, icon: icon, iconTint: iconTint, detail: detail, state: state) {}
    }
}

/// A row's value in `note` and a chevron: for a row that opens a page or a menu.
struct RowValue: View {
    var text: String?

    var body: some View {
        HStack(spacing: 8) {
            if let text { Text(text).font(.note).foregroundStyle(Palette.muted) }
            Image(systemName: "chevron.forward").font(.system(size: 13, weight: .semibold)).foregroundStyle(
                Palette.muted
            )
            .accessibilityHidden(true)
        }
        .frame(minHeight: 44)
    }
}

/// A row's value that is one of a few choices, in the system's menu.
struct RowMenu<Choice: Hashable>: View {
    let title: String
    let choices: [(choice: Choice, name: String)]
    let selection: Choice
    let set: (Choice) -> Void

    var body: some View {
        Menu {
            Picker(title, selection: Binding(get: { selection }, set: set)) {
                ForEach(choices, id: \.choice) { Text($0.name).tag($0.choice) }
            }
        } label: {
            RowValue(text: choices.first { $0.choice == selection }?.name)
        }
        .accessibilityLabel(title)
    }
}

/// A row's switch: the system's, tinted `fg` by the row.
struct RowSwitch: View {
    let title: String
    let isOn: Bool
    let set: (Bool) -> Void

    var body: some View {
        Toggle(title, isOn: Binding(get: { isOn }, set: set)).labelsHidden()
    }
}

/// A row's quiet button: 44 high, 84 wide at least.
struct RowButton: View {
    let title: String
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) { Text(title).padding(.horizontal, 18).frame(minWidth: 84) }
            .buttonStyle(.pill(.quiet, size: .compact, isBusy: isBusy)).fixedSize()
    }
}

/// Rows in one filled group with a hairline between them, starting at the text, and a label above.
struct RowGroup<Content: View>: View {
    var label: String?
    var labelColor = Palette.faint
    var surface = Surface.page
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let appears = reduceMotion ? AnyTransition.identity : Motion.appears
        return Group(subviews: content) { rows in
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if let label {
                        Caps(label, color: labelColor).padding(.horizontal, 16).accessibilityAddTraits(.isHeader)
                    }
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            row.transition(appears).overlay(alignment: .top) {
                                if row.id != rows.first?.id { Hairline(color: .fillTint).padding(.leading, 16) }
                            }
                        }
                    }
                    .foregroundStyle(Palette.fg)
                    .background(surface.fill, in: .rect(cornerRadius: Metrics.Radius.card))
                }
                .transition(appears)
            }
        }
    }
}

/// A one-line field: 48 high capsule, no outline, its fill by the surface it sits on.
struct Field: View {
    let prompt: String
    @Binding var text: String
    var surface = Surface.page
    /// A symbol leading the text, as a search field has.
    var icon: String?

    var body: some View {
        HStack(spacing: 12) {
            if let icon { Image(systemName: icon).foregroundStyle(Palette.muted).accessibilityHidden(true) }
            TextField(prompt, text: $text).font(.body15).foregroundStyle(Palette.fg)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 48)
        .background(surface.fill, in: .capsule)
    }
}

/// A sheet's top: its name in thin type, and its Close.
struct SheetHeader: View {
    /// `nil` for a sheet whose first line names itself (the pendant's big word is the state).
    var title: String?
    var color: Color = Palette.fg
    let close: () -> Void

    /// The title in the content; Close alone in the bar the system draws over the sheet, a toolbar item, so the sheet
    /// sits in a stack (`sheetStack()`).
    var body: some View {
        HStack {
            if let title { Text(title).font(.sheetTitle).foregroundStyle(color) }
            Spacer(minLength: 0)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { Button(role: .close, action: close) }
        }
    }
}

/// The quiet placeholder of a read still loading: a few bars where the content will be, no spinner.
struct Placeholder: View {
    var width: CGFloat? = nil
    var height: CGFloat = 14

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        RoundedRectangle(cornerRadius: height / 2)
            .fill(Color.fillTint)
            .frame(width: width, height: height)
            .opacity(dim ? 0.5 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

extension View {
    /// A screen's content at a readable width, centred, whatever width it is given (a folded phone, an unfolded Duo, a split's
    /// column): it fills a narrow container and stops growing in a wide one.
    func readingWidth(_ width: CGFloat = 540) -> some View {
        frame(maxWidth: width).frame(maxWidth: .infinity)
    }
}

/// A line that names the server's limit ("20 seconds at most"): the limit as it was when the action began, kept while it
/// counts down. `text` gets the phrase, or nil while the server has named none. Past the limit the action is late, never
/// failed: the line says so, and the app still waits for Life's answer.
struct LimitNote: View {
    let state: ActionState<ActionProof>
    let text: (String?) -> String
    @State private var seconds: Int?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(
                state.isLate(at: context.date)
                    ? "Taking longer than Life said; still waiting." : text(seconds.map { "\($0) seconds at most" }))
        }
        .onChange(of: state.limit, initial: true) { _, limit in
            if seconds == nil, let limit { seconds = max(1, Int(limit.timeIntervalSinceNow.rounded(.up))) }
        }
    }
}
