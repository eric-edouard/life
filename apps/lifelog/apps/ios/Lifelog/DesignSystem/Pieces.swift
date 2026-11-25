import LifeConnector
import SwiftUI

/// The pieces every v1 screen is drawn with (the app design's `ak-p`, `ak-b`, `chip`, `tile`): a fill of the palette,
/// never a border, and nothing tappable under 44 points.
/// The pill buttons: the filled one (cream in dark), the quiet one, and the done one (`ok`, an action that worked), in
/// three sizes, and busy while an action runs. A label that does not fit wraps and the pill grows with it, to 3 lines (a compact pill keeps one).
struct PillStyle: ButtonStyle {
    enum Kind { case filled, quiet, done }
    /// `large` is a screen's or a sheet's answer; `compact` sits inside a card or a row; `row` is one of several
    /// answers stacked, each on its line; `tile` shares a card's second row of answers, its icon above a 13 pt label.
    enum Size: CGFloat { case large = 54, row = 48, compact = 44, tile = 60 }

    let kind: Kind
    var size: Size = .large
    /// The action is running: its own fill, a spinner then the label, and no taps.
    var isBusy = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let isFilled = kind != .quiet
        HStack(spacing: 8) {
            if isBusy { Spinner() }
            configuration.label.multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                // A long label stops at 3 lines, so the answer bar stays bounded (compact pills hold one).
                .lineLimit(size == .compact || size == .tile ? 1 : 3)
        }
        .font(size == .tile ? .heading : .bodyStrong)
        .foregroundStyle(isFilled ? Palette.on : Palette.fg)
        // A compact pill sits beside others in a row: it keeps less to its sides.
        .padding(
            .horizontal, size == .tile ? Metrics.Spacing.s : size == .compact ? Metrics.Spacing.m : Metrics.Spacing.l
        )
        .padding(.vertical, Metrics.Spacing.s)
        .frame(maxWidth: .infinity, minHeight: size.rawValue)
        .background(isFilled ? (kind == .done ? Palette.ok : Palette.fg) : Palette.tint, in: shape)
        .motion(Motion.standard, value: kind == .done)
        .opacity(isBusy ? 1 : isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
        .contentShape(shape)
        .allowsHitTesting(!isBusy)
    }

    /// A tile is a rounded square's corners, every other size a capsule.
    private var shape: AnyShape {
        size == .tile
            ? AnyShape(RoundedRectangle(cornerRadius: Metrics.Radius.block, style: .continuous)) : AnyShape(.capsule)
    }
}

/// Life's one spinner (the design's, never the system's bars): a 2 pt ring in `tint` and a quarter arc with round ends in
/// the colour of what it sits in (`foregroundStyle`: `fg` on a quiet button, `on` on the filled one, `ai` for an agent),
/// a full turn every 0.8 s, linear (18, or 14 in a row or a line). With Reduce Motion the arc stands still and pulses.
struct Spinner: View {
    enum Size: CGFloat { case regular = 18, small = 14 }
    var size: Size = .regular

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation) { context in
            let seconds = context.date.timeIntervalSinceReferenceDate
            ZStack {
                Circle().stroke(Palette.tint, lineWidth: 2)
                Circle().trim(from: 0, to: 0.25).stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    // Centred on 12 o'clock at rest (a trim starts at 3), as the frames draw it.
                    .rotationEffect(.degrees(-135))
                    .rotationEffect(
                        .degrees(reduceMotion ? 0 : seconds.truncatingRemainder(dividingBy: 0.8) / 0.8 * 360)
                    )
                    .opacity(reduceMotion ? 0.55 + 0.45 * abs(sin(seconds * .pi / 1.6)) : 1)
            }
        }
        .padding(1).frame(width: size.rawValue, height: size.rawValue)
        .accessibilityElement().accessibilityLabel("In progress")
    }
}

extension ButtonStyle where Self == PillStyle {
    static func pill(_ kind: PillStyle.Kind, size: PillStyle.Size = .large, isBusy: Bool = false) -> PillStyle {
        PillStyle(kind: kind, size: size, isBusy: isBusy)
    }
}

/// A link, 44 high (decision 85): its words in `fg`, 13 / 600, then where it goes, always: a chevron for a page of the
/// app, an arrow for something outside it. An action is a `QuietChip`.
struct TextLink: View {
    enum Goes { case page, outside }

    let title: String
    let goes: Goes
    let action: () -> Void

    init(_ title: String, to goes: Goes, action: @escaping () -> Void) {
        self.title = title
        self.goes = goes
        self.action = action
    }

    var body: some View {
        Button(action: action) { Self.label(title, to: goes) }
    }

    /// The link's look, for a system link that navigates itself (`NavigationLink`).
    static func label(_ title: String, to goes: Goes) -> some View {
        Text("\(title) \(Image(systemName: goes == .page ? "chevron.right" : "arrow.up.right"))")
            .font(.heading).foregroundStyle(Palette.fg).frame(minHeight: Metrics.tapTarget)
    }
}

/// An action, or what opens a sheet, as a quiet chip (decision 85): a 14 glyph (when it has one: a label row's chip has
/// none, "Select", "Close 20") then its words, 13 / 600, on a `tint` capsule 32 high in a 44 tap area, no border;
/// `isMuted` for a line that says where something came from, `iconTint` for Life's own mark in `ai`.
struct QuietChip: View {
    let title: String
    let symbol: String?
    var isMuted = false
    var isBusy = false
    var iconTint: Color?
    let action: () -> Void

    init(
        _ title: String, symbol: String? = nil, isMuted: Bool = false, isBusy: Bool = false, iconTint: Color? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.symbol = symbol
        self.isMuted = isMuted
        self.isBusy = isBusy
        self.iconTint = iconTint
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isBusy {
                    Spinner(size: .small)
                } else if let symbol {
                    Image(systemName: symbol).font(.lineStrong).foregroundStyle(iconTint ?? color).accessibilityHidden(
                        true)
                }
                Text(title).font(.heading)
            }
            .foregroundStyle(color)
            .padding(.horizontal, Metrics.Spacing.m).frame(minHeight: 32)
            .background(Palette.tint, in: .capsule)
            .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain).disabled(isBusy)
    }

    /// The chip's colour, its glyph's unless `iconTint` gives it another.
    private var color: Color { isMuted ? Palette.muted : Palette.fg }
}

/// Where a list's next part begins, in a small muted label: "The rest can wait" in the Inbox, "Parked" in Matters. Its
/// one action, when it has one, is a chip at the right ("All 5", "More": the label row, decision 98).
struct ListLabel<Action: View>: View {
    let text: String
    @ViewBuilder var action: Action

    init(_ text: String, @ViewBuilder action: () -> Action) {
        self.text = text
        self.action = action()
    }

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            Text(text).font(.line).foregroundStyle(Palette.muted).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            action
        }
        // Over its card's text: the list's inset and a little more.
        .padding(.horizontal, Metrics.gutter + Metrics.Spacing.xs).padding(.top, 16).padding(.bottom, 6)
    }
}

extension ListLabel where Action == EmptyView {
    init(_ text: String) { self.init(text) {} }
}

extension View {
    /// One row of a list on the page (decision 98, rule 17; no card around a list since 22 Nov): at least
    /// `Metrics.listRow` high, a `line` hairline above every row but the group's first, inset by the gutter
    /// (`Metrics.gutter`, as the frames draw it); the open row lit with `pick`. Rows of one group stack with no gap; a
    /// label or a gap starts the next. The same in a `List` row (its swipe actions and letter index kept) as in a stack. A row he taps
    /// takes it as its button style (`.buttonStyle(.groupedRow(…))`), so the whole 60 is the tap.
    func groupedRow(at index: Int, of count: Int, isChosen: Bool = false, isPressed: Bool = false) -> some View {
        // The lit container: the card radius on every corner, a little wider than the row's text and 2 off the hairlines.
        let lit = RoundedRectangle(cornerRadius: Metrics.Radius.block)
        return frame(minHeight: Metrics.listRow).contentShape(.rect)
            .background {
                lit.fill(Palette.glass).padding(.horizontal, -Metrics.Spacing.xs * 2).padding(.vertical, 2)
                    .opacity(isChosen || isPressed ? 1 : 0)
            }
            .overlay(alignment: .top) { if index > 0 { Hairline() } }
            .padding(.horizontal, Metrics.gutter)
            .motion(Motion.standard, value: isChosen)
            .motion(Motion.standard, value: isPressed)
            .accessibilityAddTraits(isChosen ? .isSelected : [])
    }
}

/// A tapped row of a grouped inset list: its label in `groupedRow`, the whole row the tap.
struct GroupedRowStyle: ButtonStyle {
    let index: Int
    let count: Int
    var isChosen = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.groupedRow(
            at: index, of: count, isChosen: isChosen, isPressed: configuration.isPressed)
    }
}

extension ButtonStyle where Self == GroupedRowStyle {
    static func groupedRow(at index: Int, of count: Int, isChosen: Bool = false) -> GroupedRowStyle {
        GroupedRowStyle(index: index, count: count, isChosen: isChosen)
    }
}

/// His mark after a matter's name: a filled flag, 12, in `fg` at 85% (never the orange `flag`, which means late).
struct SmallFlag: View {
    var body: some View {
        Image(systemName: "flag.fill").font(.system(size: 12)).foregroundStyle(Palette.icon).accessibilityHidden(true)
    }
}

/// Two or three choices in one capsule, each with its symbol before it when `icon` gives one and, when `detail` gives
/// one, a muted count after its words; tapping the chosen one clears it.
struct SegmentedChoice<Choice: Hashable>: View {
    let choices: [Choice]
    @Binding var selection: Choice?
    let title: (Choice) -> String
    var icon: (Choice) -> String? = { _ in nil }
    var detail: (Choice) -> String? = { _ in nil }

    var body: some View {
        // Always one line: with their symbols while they fit, else the words alone.
        ViewThatFits(in: .horizontal) {
            segments(withIcons: true)
            segments(withIcons: false)
        }
        // The chosen segment sits inset in its 48 track.
        .padding(4)
        .background(Palette.tile, in: .capsule)
        .motion(Motion.standard, value: selection)
    }

    /// Each segment as wide as its words, the room left shared out.
    private func segments(withIcons: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(choices, id: \.self) { choice in
                let isChosen = selection == choice
                Button {
                    selection = isChosen ? nil : choice
                } label: {
                    HStack(spacing: 6) {
                        if withIcons, let symbol = icon(choice) {
                            Image(systemName: symbol).font(.system(size: 16)).accessibilityHidden(true)
                        }
                        Text(title(choice)).font(.lineStrong).lineLimit(1)
                        if let detail = detail(choice) {
                            Text(detail).font(.lineStrong).foregroundStyle(
                                isChosen ? Palette.on.opacity(0.6) : Palette.muted
                            )
                            .lineLimit(1)
                        }
                    }
                    .fixedSize()
                    .padding(.horizontal, 14)
                    .foregroundStyle(isChosen ? Palette.on : Palette.fg)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(isChosen ? Palette.fg : .clear, in: .capsule)
                    .contentShape(.capsule)
                }
                .buttonStyle(.plain).accessibilityAddTraits(isChosen ? .isSelected : [])
            }
        }
    }
}

extension View {
    /// A draft, a piece of evidence or a clip on paper: the `paper` fill at the passage radius (a quote sits on `tile`).
    func paperBox() -> some View {
        background(Palette.paper, in: .rect(cornerRadius: Metrics.Radius.block))
    }
}

/// A `label`, a 6 pt track filled by how far it got, and an end word. A nil `fraction` is a wait of unknown length: a
/// still, empty track (nothing here moves on its own).
struct ProgressLine: View {
    var label: String?
    var fraction: Double?
    var end: String?
    var endColor = Palette.muted
    /// The filled part: `fg` for progress, `muted` for a share (Spending's providers).
    var fill = Palette.fg

    var body: some View {
        HStack(spacing: 12) {
            if let label { Caps(label, color: Palette.muted) }
            Capsule().fill(Palette.tint).frame(height: 6)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule().fill(fill).frame(width: proxy.size.width * min(max(fraction ?? 0, 0), 1))
                    }
                }
                .motion(Motion.standard, value: fraction)
            if let end { Caps(end, color: endColor) }
        }
        .frame(height: 24)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// A `card` fill at the card radius with 16 of padding: the goal and next step, an agent, a choice waiting.
    func box() -> some View {
        padding(16).frame(maxWidth: .infinity, alignment: .leading).card(radius: Metrics.Radius.block)
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
                isLit && !reduceMotion ? Motion.breath : nil, value: isDim
            )
            .onAppear { isDim = isLit }
            .accessibilityHidden(true)
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
    case ok, off, flag, busy, cut

    var color: Color {
        switch self {
        case .ok: Palette.ok
        case .off: Palette.muted
        case .flag: Palette.flag
        case .busy, .cut: Palette.fg
        }
    }

    var body: some View {
        Group {
            switch self {
            case .ok: Image(systemName: "checkmark").font(.system(size: 13, weight: .bold))
            case .off: Circle().frame(width: 6, height: 6)
            case .flag: Image(systemName: "exclamationmark.circle").font(.system(size: 14, weight: .semibold))
            case .busy: Spinner(size: .small)
            case .cut: Image(systemName: "line.3.horizontal.decrease").font(.system(size: 13, weight: .semibold))
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
            Text(word).font(.heading).foregroundStyle(glyph.color)
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

/// Where a row's value stands, and the tap rule every control follows: loading, then a green result, or a clear
/// failure. A value the server holds is never shown as known before it said (`ServerValue`); the other rows are always
/// `known`. `done` is view state, its word ("Saved", "Allowed") shown 2 s after the tap went through (`tap`).
enum RowState: Equatable {
    case known, asking, saving
    case done(String)
    /// The change did not go: the control is back on the old value, the line says why.
    case refused(String)

    static let saved = RowState.done("Saved")

    /// A tap: `saving` while `work` runs, then what it ends on, a `done` word for 2 s or a `refused` reason.
    @MainActor static func tap(_ state: Binding<RowState>, _ work: () async -> RowState) async {
        // A second tap while the first runs is the same tap.
        guard state.wrappedValue != .saving else { return }
        state.wrappedValue = .saving
        let end = await work()
        state.wrappedValue = end
        guard case .done = end else { return }
        try? await Task.sleep(for: .seconds(2))
        if state.wrappedValue == end { state.wrappedValue = .known }
    }
}

/// A tap's line under its control, as a row's second line shows it: the spinner and "Saving…", the green result, or
/// the failure; nothing once known.
struct TapLine: View {
    let state: RowState
    var detail: String?
    /// A row draws its spinner at the trailing edge; alone, the line draws it.
    var isInRow = false

    var body: some View {
        switch state {
        case .known:
            if let detail { Text(detail).font(.line).foregroundStyle(Palette.muted) }
        case .asking: Text("Asking the server…").font(.line).foregroundStyle(Palette.muted)
        case .saving:
            HStack(spacing: 8) {
                if !isInRow { StateGlyph.busy }
                Text("Saving…").font(.line).foregroundStyle(Palette.muted)
            }
        case .done(let word):
            HStack(spacing: 6) {
                StateGlyph.ok
                Text(word).font(.heading)
            }
            .foregroundStyle(Palette.ok)
        case .refused(let message): Text(message).font(.line).foregroundStyle(Palette.flag)
        }
    }
}

/// One row of a `RowGroup`: a title, an optional second line, and one thing at the trailing edge (a `RowValue`, a
/// `RowMenu`, a `RowSwitch`, a `StateMark`, a `RowButton`). The state sets the second line and the spinner.
struct Row<Trailing: View>: View {
    let title: String
    /// A symbol in line style (`Image(symbol:)`: the system's or an agent's mark), in a 28 slot before the title.
    var icon: String?
    var iconTint = Palette.icon
    var detail: String?
    var state = RowState.known
    /// His mark: `SmallFlag` after the name, on its last line.
    var isMarked = false
    /// A list's row takes its height from its list (`groupedRow`); a settings row keeps 56, or 64 with a second line.
    var isInList = false
    @ViewBuilder var trailing: Trailing

    @Environment(\.dynamicTypeSize) private var size

    var body: some View {
        let text = VStack(alignment: .leading, spacing: 2) {
            titleText.font(.rowTitle).foregroundStyle(Palette.fg)
            TapLine(state: state, detail: detail, isInRow: true)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        let end = HStack(spacing: 8) {
            if state == .asking || state == .saving { StateGlyph.busy }
            if state != .asking { trailing }
        }
        .tint(Palette.fg)
        // At the accessibility sizes the trailing control goes under the text, so no word is squeezed.
        let stacked = size.isAccessibilitySize
        return Group {
            if stacked {
                HStack(alignment: .top, spacing: 12) {
                    iconView
                    VStack(alignment: .leading, spacing: 8) {
                        text; end
                    }
                }
            } else {
                HStack(spacing: 12) {
                    iconView; text; end
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: isInList ? nil : (state == .known && detail == nil ? 56 : 64))
        .contentShape(.rect)
    }

    @ViewBuilder private var iconView: some View {
        if let icon {
            Image(systemName: icon).font(.system(size: 22, weight: .regular)).foregroundStyle(iconTint)
                .frame(width: 28).accessibilityHidden(true)
        }
    }

    /// The name, and his mark after it on its last line (the flag as `SmallFlag` draws it).
    private var titleText: Text {
        let flag = Text(Image(systemName: "flag.fill")).font(.system(size: 12)).foregroundStyle(Palette.icon)
        return isMarked ? Text("\(title) \(flag)") : Text(verbatim: title)
    }
}

extension Row where Trailing == EmptyView {
    init(
        title: String, icon: String? = nil, iconTint: Color = Palette.icon, detail: String? = nil,
        state: RowState = .known, isInList: Bool = false
    ) {
        self.init(title: title, icon: icon, iconTint: iconTint, detail: detail, state: state, isInList: isInList) {}
    }
}

/// A row's value in `note` and a chevron: for a row that opens a page or a menu.
struct RowValue: View {
    var text: String?

    var body: some View {
        HStack(spacing: 8) {
            if let text { Text(text).font(.line).foregroundStyle(Palette.muted) }
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

/// A row's switch: a cream track with a black knob when on, a `tint` track with a cream knob when off. Never the
/// system's green: green means it worked (`ok`), and only the tick says so.
struct RowSwitch: View {
    let title: String
    let isOn: Bool
    let set: (Bool) -> Void

    var body: some View {
        let gap = (Metrics.switchTrack.height - Metrics.switchKnob) / 2
        Button {
            set(!isOn)
        } label: {
            Capsule().fill(isOn ? Palette.fg : Palette.glass)
                .frame(width: Metrics.switchTrack.width, height: Metrics.switchTrack.height)
                .overlay(alignment: isOn ? .trailing : .leading) {
                    Circle().fill(isOn ? Palette.on : Palette.fg).frame(
                        width: Metrics.switchKnob, height: Metrics.switchKnob
                    )
                    .padding(gap)
                }
                .motion(Motion.standard, value: isOn)
                .frame(minWidth: Metrics.tapTarget, minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain).accessibilityLabel(title).accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
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

    var body: some View {
        Group(subviews: content) { rows in
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if let label {
                        Caps(label, color: labelColor).padding(.horizontal, 16).accessibilityAddTraits(.isHeader)
                    }
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            row.appears().overlay(alignment: .top) {
                                if row.id != rows.first?.id {
                                    Hairline(color: surface == .page ? Palette.line : Palette.tint).padding(
                                        .leading, 16)
                                }
                            }
                        }
                    }
                    .foregroundStyle(Palette.fg)
                    // A list sits on the page with hairlines; only a sheet's group keeps its tile.
                    .background(
                        surface == .sheet ? surface.fill : .clear, in: .rect(cornerRadius: Metrics.Radius.block))
                }
                .appears()
            }
        }
    }
}

/// A one-line field with the microphone (`DictationField`): 48 high capsule, no outline, its fill by the surface it
/// sits on.
struct Field: View {
    let prompt: String
    @Binding var text: String
    var surface = Surface.page
    /// A symbol leading the text, as a search field has.
    var icon: String?
    /// Its one submit, when it has one: the field's Send (`DictationField.send`).
    var send: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            if let icon { Image(systemName: icon).foregroundStyle(Palette.muted).accessibilityHidden(true) }
            DictationField(prompt: prompt, text: $text, send: send).font(.body15).foregroundStyle(Palette.fg)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 48)
        .background(surface.fill, in: .capsule)
    }
}

/// A sheet's top: its name, and its Close.
struct SheetHeader: View {
    /// `nil` for a sheet whose first line names itself (the pendant's big word is the state).
    var title: String?
    var color: Color = Palette.fg
    /// A sheet's heading; a screen shown in a sheet ("Settings") passes `.profileName`.
    var font: TypeStep = .profileName
    let close: () -> Void

    /// One head row inside the sheet: the title at the left, Close at the right. The stack's bar (`sheetStack()`) is
    /// hidden, so nothing sits above it.
    var body: some View {
        HStack {
            if let title { Text(title).font(font).foregroundStyle(color) }
            Spacer(minLength: 0)
            CloseButton(close: close)
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}

extension View {
    /// A sheet on the one-scroll rule (decision 97): this view is the one scroll's content, at the gutter; `head` (its
    /// `SheetHeader`) sits in the top bar and `buttons` in the bottom bar (`sheetBars`), so nothing scrolls inside and
    /// the content's end scrolls clear of the buttons.
    func sheetScroll<Head: View, Buttons: View>(
        @ViewBuilder head: () -> Head, @ViewBuilder buttons: () -> Buttons
    ) -> some View {
        sheetScrolled.sheetBars(head: head, buttons: buttons)
    }

    /// `sheetScroll` with no buttons.
    func sheetScroll<Head: View>(@ViewBuilder head: () -> Head) -> some View {
        sheetScrolled.sheetBars(head: head)
    }

    private var sheetScrolled: some View {
        ScrollView {
            padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.l)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    /// Every sheet's shell, the screens' own (decision 96): its head in the top bar and its buttons in the bottom bar,
    /// the scroll under both (this view holds it) softened at both edges by iOS's soft
    /// scroll edge, set on the sheet itself.
    func sheetBars<Head: View, Buttons: View>(
        @ViewBuilder head: () -> Head, @ViewBuilder buttons: () -> Buttons
    ) -> some View {
        let bottom = buttons().padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
        return sheetBars(head: head).safeAreaBar(edge: .bottom, spacing: 0) { bottom }
    }

    /// `sheetBars` with no buttons.
    func sheetBars<Head: View>(@ViewBuilder head: () -> Head) -> some View {
        // On the sheet's own fill, so what scrolls under the title never shows through it.
        let top = head().padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
            .background(Palette.sheet)
        return safeAreaBar(edge: .top, spacing: 0) { top }
            .scrollEdgeEffectStyle(.soft, for: .vertical)
    }
}

/// A sheet's Close: a flat `tile` circle with a thin x, without the system's glass and its rim (no borders).
struct CloseButton: View {
    let close: () -> Void

    var body: some View {
        Button(role: .close, action: close) {
            Image(systemName: "xmark").font(.system(size: 17, weight: .light)).foregroundStyle(Palette.fg)
                .frame(width: 44, height: 44).background(Palette.tile, in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
    }
}

/// `CloseButton` in the bar the system draws, for a sheet whose top is its own (the pendant's).
struct CloseItem: ToolbarContent {
    let close: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) { CloseButton(close: close) }.sharedBackgroundVisibility(.hidden)
    }
}

extension View {
    /// A sheet in its own stack, for what it pushes and the pendant's Close (`CloseItem`) in the bar the system draws.
    func sheetStack() -> some View {
        NavigationStack { self }
    }
}

extension View {
    /// A screen's content at a readable width, centred, whatever width it is given (a folded phone, an unfolded Duo, a split's
    /// column): it fills a narrow container and stops growing in a wide one.
    func readingWidth(_ width: CGFloat = 540) -> some View {
        frame(maxWidth: width).frame(maxWidth: .infinity)
    }
}
