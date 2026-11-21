import LifeConnector
import SwiftUI

/// The pieces every v1 screen is drawn with (the app design's `ak-p`, `ak-b`, `chip`, `tile`): a fill of the palette,
/// never a border, and nothing tappable under 44 points.
/// The pill buttons: the filled one (cream in dark), the quiet one, and the done one (`ok`, an action that worked), in
/// three sizes, and busy while an action runs. A label that does not fit takes a second line, and the pill grows with it.
struct PillStyle: ButtonStyle {
    enum Kind { case filled, quiet, done }
    /// `large` is a screen's or a sheet's answer; `compact` sits inside a card or a row; `row` is one of several
    /// answers stacked, each on its line.
    enum Size: CGFloat { case large = 54, row = 48, compact = 44 }

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
        }
        .font(.buttonLabel)
        .foregroundStyle(isFilled ? Palette.on : Palette.fg)
        // A compact pill sits beside others in a row: it keeps less to its sides.
        .padding(.horizontal, size == .compact ? Metrics.Spacing.m : Metrics.Spacing.l)
        .padding(.vertical, Metrics.Spacing.s)
        .frame(maxWidth: .infinity, minHeight: size.rawValue)
        .background(isFilled ? (kind == .done ? Palette.ok : Palette.fg) : Color.fillTint, in: .capsule)
        .motion(Motion.standard, value: kind == .done)
        .opacity(isBusy ? 1 : isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
        .contentShape(.capsule)
        .allowsHitTesting(!isBusy)
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
                Circle().stroke(Color.fillTint, lineWidth: 2)
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

/// A count on a tab or a row: 20 high, the flag fill.
struct CountBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)").font(.badge).foregroundStyle(Palette.on)
            .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20).background(Palette.flag, in: .capsule)
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
            .font(.smallStrong).foregroundStyle(Palette.fg).frame(minHeight: Metrics.tapTarget)
    }
}

/// An action, or what opens a sheet, as a quiet chip (decision 85): a 14 glyph then its words, 13 / 600, on a `fillTint`
/// capsule 32 high in a 44 tap area, no border; `isMuted` for a line that says where something came from.
struct QuietChip: View {
    let title: String
    let symbol: String
    var isMuted = false
    let action: () -> Void

    init(_ title: String, symbol: String, isMuted: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.isMuted = isMuted
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(.chip).accessibilityHidden(true)
                Text(title).font(.smallStrong)
            }
            .foregroundStyle(isMuted ? Palette.muted : Palette.fg)
            .padding(.horizontal, Metrics.Spacing.m).frame(minHeight: 32)
            .background(Color.fillTint, in: .capsule)
            .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// A line added to a list (decision 85): a plus in a 24 `fillTint` circle, then its words in `fg`.
struct AddRow: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Metrics.Spacing.m) {
                Image(systemName: "plus").font(.smallStrong).frame(width: 24, height: 24)
                    .background(Color.fillTint, in: .circle).accessibilityHidden(true)
                Text(title).font(.body15)
            }
            .foregroundStyle(Palette.fg)
            .frame(maxWidth: .infinity, minHeight: Metrics.tapTarget, alignment: .leading).contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// What he just answered or changed (the toast spec of 20 Nov): a glass capsule 44 high that hugs its content, a check
/// in `ok` (a change that was not made: `flag`'s glyph and why), its words on one line (a flag's on up to 3, so Life's
/// reason reads whole), and Undo while it can be taken back, a `pick` capsule inside it. It sits at the top of the
/// pane, so it takes no room from the answers.
struct Toast: View {
    let words: String
    var glyph = StateGlyph.ok
    let undo: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            glyph
            Text(words).font(.chip).foregroundStyle(Palette.fg).lineLimit(glyph == .flag ? 3 : 1)
            if let undo {
                Button(action: undo) {
                    Text("Undo").font(.chip).foregroundStyle(Palette.fg).padding(.horizontal, 12).frame(height: 32)
                        .background(Color.pick, in: .capsule).contentShape(.capsule)
                }
                .buttonStyle(.plain).fixedSize()
            }
        }
        .padding(.leading, 14).padding(.trailing, undo == nil ? 14 : 6).frame(minWidth: 120, minHeight: 44)
        .floatingGlass()
    }
}

extension View {
    /// What he just answered (the one held last, for 4 s), over the top: out of the layout, so nothing moves. `shows`
    /// says whether this screen names that held answer.
    func heldToast(shows: @escaping (String) -> Bool, undo: @escaping (String) -> Void) -> some View {
        modifier(HeldToast(shows: shows, undo: undo))
    }
}

extension View {
    /// His last mark or project status, said back (`LifeStore.saidBack`), over the top as the held answer's toast; in
    /// the closed Duo's side column (`inSideColumn`) only a change that was not made, the column's capsule says the rest.
    func saidBackToast(inSideColumn: Bool) -> some View { modifier(SaidBackToast(inSideColumn: inSideColumn)) }

    /// A page's said-back toast, over the top of its pane (the toast spec: the closed Duo's column capsule is gone).
    func saysBack() -> some View { saidBackToast(inSideColumn: false) }

    /// A page's title steps aside while a toast is over it: on the closed Duo, where no bar holds the toast.
    func stepsAsideForToast() -> some View { modifier(StepsAsideForToast()) }
}

private struct StepsAsideForToast: ViewModifier {
    @Environment(LifeStore.self) private var life
    @State private var inSideColumn = false

    func body(content: Content) -> some View {
        let isCovered = inSideColumn && life.saidBack != nil
        content.opacity(isCovered ? 0 : 1).motion(Motion.standard, value: isCovered)
            .reportsSideColumn($inSideColumn)
    }
}

private struct SaidBackToast: ViewModifier {
    let inSideColumn: Bool
    @Environment(LifeStore.self) private var life
    /// The closed Duo, where no bar holds the toast: its slot is 10 from the screen's top, over the stepped-aside title.
    @State private var isClosed = false

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            ZStack {
                if let said = life.saidBack, !inSideColumn || said.undo == nil {
                    Toast(words: said.words, glyph: said.undo == nil ? .flag : .ok, undo: life.undoing(said))
                        .appears().id(said.id)
                }
            }
            .padding(.top, isClosed ? 10 : 0)
            .ignoresSafeArea(.container, edges: isClosed ? .top : [])
            .motion(Motion.standard, value: life.saidBack?.id)
        }
        .reportsSideColumn($isClosed)
    }
}

private struct HeldToast: ViewModifier {
    let shows: (String) -> Bool
    let undo: (String) -> Void

    @Environment(LifeStore.self) private var life

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            ZStack {
                if let latest = life.latestHeld, shows(latest.ref) {
                    Toast(words: latest.held.label) { undo(latest.ref) }.appears().id(latest.ref)
                }
            }
            .motion(Motion.standard, value: life.latestHeld?.ref)
        }
    }
}

/// The Toast in the side column of the closed Duo, where there is no top bar: a capsule two tap targets high, no words:
/// the check in `ok`, then Undo as its glyph. It is always in the column while the bars are there, and fades with
/// `answered` (nil: nothing held), so the column never changes shape. VoiceOver reads the answer on the capsule and
/// "Undo" on the button. Larger than `StateGlyph.ok` (13): the capsule has no words to carry it.
struct ColumnToast: View {
    let answered: String?
    let undo: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: "checkmark").font(.columnGlyph).foregroundStyle(Palette.ok)
                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget).accessibilityHidden(true)
            Button(action: undo) {
                Image(systemName: "arrow.uturn.backward").font(.columnGlyph).foregroundStyle(Palette.fg)
                    .frame(width: Metrics.tapTarget, height: Metrics.tapTarget).contentShape(.rect)
            }
            .buttonStyle(.plain).accessibilityLabel("Undo")
        }
        .background(Palette.tile, in: .capsule)
        .opacity(answered == nil ? 0 : 1).allowsHitTesting(answered != nil)
        .motion(Motion.standard, value: answered)
        .accessibilityElement(children: .contain).accessibilityLabel(answered.map { "Answered: \($0)" } ?? "")
        .accessibilityHidden(answered == nil)
    }
}

/// A matter's name (the asking agent's mark before it, in `fg`) on a `card` capsule 32 high, in a 44 hit area. A long
/// name is cut with an ellipsis, except at an accessibility text size, where it may take two lines.
struct InlinePill: View {
    let name: String
    /// The asking agent's mark (`RuntimeName.mark`), nil when Life asks itself.
    var agentMark: String?
    /// His mark on the matter: a small flag after the name (`SmallFlag`).
    var isImportant = false
    let action: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: action) {
            HStack(spacing: Metrics.Spacing.s) {
                if let agentMark { Image(symbol: agentMark).accessibilityHidden(true) }
                Text(name).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                if isImportant { SmallFlag() }
            }
            .font(.smallStrong).foregroundStyle(Palette.fg)
            .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.xs).frame(minHeight: 32)
            .background(Palette.card, in: .rect(cornerRadius: 16))
            .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Matter: \(name)\(isImportant ? ", important" : "")")
    }
}

/// His mark on a matter as a toolbar item, a round glass button (the system places it: in the bar left of the Pendant,
/// or in the closed Duo's side column): off, the line flag; on, the one selected look, `pick` filled, the filled flag.
/// Always in `fg`, never the orange `flag`.
struct MarkItem: View {
    let isOn: Bool
    let toggle: () -> Void

    var body: some View {
        Button("Important", systemImage: isOn ? "flag.fill" : "flag", action: toggle)
            .labelStyle(.iconOnly).foregroundStyle(Palette.fg)
            .buttonStyle(.glassProminent).tint(isOn ? Color.pick : .clear)
            .motion(Motion.standard, value: isOn)
            .accessibilityAddTraits(isOn ? .isSelected : [])
            .accessibilityIdentifier("matter.important")
    }
}

/// Where a list's next part begins, in a small muted label: "The rest can wait" in the Inbox, "Parked" in Matters.
struct ListLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.small).foregroundStyle(Palette.muted)
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// His mark after a matter's name: a filled flag, 12, in `fg` at 85% (never the orange `flag`, which means late).
struct SmallFlag: View {
    var body: some View {
        Image(systemName: "flag.fill").font(.system(size: 12)).foregroundStyle(Palette.icon).accessibilityHidden(true)
    }
}

/// Two or three choices in one capsule, each with its symbol before it when `icon` gives one; tapping the chosen one
/// clears it.
struct SegmentedChoice<Choice: Hashable>: View {
    let choices: [Choice]
    @Binding var selection: Choice?
    let title: (Choice) -> String
    var icon: (Choice) -> String? = { _ in nil }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(choices, id: \.self) { choice in
                let isChosen = selection == choice
                Button {
                    selection = isChosen ? nil : choice
                } label: {
                    HStack(spacing: 6) {
                        if let symbol = icon(choice) {
                            Image(systemName: symbol).font(.system(size: 16)).accessibilityHidden(true)
                        }
                        Text(title(choice)).font(.chip)
                    }
                    .foregroundStyle(isChosen ? Palette.on : Palette.fg)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(isChosen ? Palette.fg : .clear, in: .capsule)
                }
                .buttonStyle(.plain).accessibilityAddTraits(isChosen ? .isSelected : [])
            }
        }
        // The chosen segment sits inset in its 48 track.
        .padding(4)
        .background(Palette.tile, in: .capsule)
        .motion(Motion.standard, value: selection)
    }
}

extension View {
    /// A draft, a piece of evidence or a clip on paper: the `paper` fill at the passage radius (a quote sits on `tile`).
    func paperBox() -> some View {
        background(Palette.paper, in: .rect(cornerRadius: Metrics.Radius.passage))
    }
}

/// A `label`, a 6 pt track filled by how far it got, and an end word. A nil `fraction` is a wait of unknown length: a
/// still, empty track (nothing here moves on its own).
struct ProgressLine: View {
    var label: String?
    var fraction: Double?
    var end: String?
    var endColor = Palette.muted

    var body: some View {
        HStack(spacing: 12) {
            if let label { Caps(label, color: Palette.muted) }
            Capsule().fill(Color.fillTint).frame(height: 6)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule().fill(Palette.fg).frame(width: proxy.size.width * min(max(fraction ?? 0, 0), 1))
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

/// A list's Filter: a system menu of inline pickers (a line icon per row, a check on the chosen one), its glyph filled
/// while a choice narrows the list. Matters and the asks draw it.
struct FilterMenu<Choices: View>: View {
    let isFiltered: Bool
    let identifier: String
    /// What VoiceOver reads: what the menu does ("Filter", "Sort").
    let label: String
    /// Floating, the round button's size: the whole circle takes the tap (a menu hit-tests its label only).
    var diameter: CGFloat?
    let choices: Choices

    var body: some View {
        Menu {
            choices
        } label: {
            Image(systemName: isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                .frame(width: diameter, height: diameter).contentShape(.circle)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

extension View {
    /// A list's Filter, placed by where the system puts the bars: a top-leading toolbar item, or, in the side column
    /// of the closed Duo (`reportsSideColumn`), a round glass button floating at the list's bottom left, so the top group
    /// stays the Pendant and Settings. While it floats the list keeps a margin under its last row.
    func filterBar<Choices: View>(
        isFiltered: Bool, identifier: String, isResting: Bool = false, label: String = "Filter",
        @ViewBuilder choices: () -> Choices
    ) -> some View {
        modifier(
            FilterBar(
                isFiltered: isFiltered, identifier: identifier, isResting: isResting, label: label, choices: choices()))
    }
}

private struct FilterBar<Choices: View>: ViewModifier {
    let isFiltered: Bool
    let identifier: String
    let isResting: Bool
    let label: String
    let choices: Choices
    @State private var isInColumn = false
    /// The floating button and its margin from the list's bottom edge; the list keeps room for both, and more.
    private let size: CGFloat = 48, bottom = Metrics.Spacing.xl

    // A control that comes and goes is unreliable: it stays and rests when there is nothing to choose between.
    private func menu(diameter: CGFloat? = nil) -> some View {
        FilterMenu(isFiltered: isFiltered, identifier: identifier, label: label, diameter: diameter, choices: choices)
            .disabled(isResting)
    }

    func body(content: Content) -> some View {
        content
            .reportsSideColumn($isInColumn)
            .toolbar { if !isInColumn { ToolbarItem(placement: .topBarLeading) { menu() } } }
            .contentMargins(.bottom, isInColumn ? size + bottom + Metrics.Spacing.l : 0, for: .scrollContent)
            .overlay(alignment: .bottomLeading) {
                ZStack {
                    if isInColumn {
                        menu(diameter: size).floatingGlass(in: .circle)
                            .padding(.leading, Metrics.gutter).padding(.bottom, bottom).appears()
                    }
                }
                // 24 from the screen's bottom, as the closed Duo's list draws it, not from its safe area.
                .ignoresSafeArea(.container, edges: isInColumn ? .bottom : [])
                .motion(Motion.standard, value: isInColumn)
            }
    }
}

/// A filter chip: its name; filled when it holds a choice.
struct FilterChip: View {
    let name: String
    var isOn = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(name)
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
            case .busy: Spinner(size: .small)
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
    /// A symbol in line style (`Image(symbol:)`: the system's or an agent's mark), in a 28 slot before the title.
    var icon: String?
    var iconTint = Palette.icon
    var detail: String?
    var state = RowState.known
    /// His mark: `SmallFlag` after the name, on its last line.
    var isMarked = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            if let icon {
                Image(symbol: icon).font(.system(size: 22, weight: .regular)).foregroundStyle(iconTint)
                    .frame(width: 28).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                titleText.font(.rowName).foregroundStyle(Palette.fg)
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

    /// The name, and his mark after it on its last line (the flag as `SmallFlag` draws it).
    private var titleText: Text {
        let flag = Text(Image(systemName: "flag.fill")).font(.system(size: 12)).foregroundStyle(Palette.icon)
        return isMarked ? Text("\(title) \(flag)") : Text(verbatim: title)
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
                                if row.id != rows.first?.id { Hairline(color: .fillTint).padding(.leading, 16) }
                            }
                        }
                    }
                    .foregroundStyle(Palette.fg)
                    .background(surface.fill, in: .rect(cornerRadius: Metrics.Radius.card))
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

    var body: some View {
        HStack(spacing: 12) {
            if let icon { Image(systemName: icon).foregroundStyle(Palette.muted).accessibilityHidden(true) }
            DictationField(prompt: prompt, text: $text).font(.body15).foregroundStyle(Palette.fg)
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
    /// A sheet's heading; a screen shown in a sheet ("Settings") passes `.screenName`.
    var font: TypeStep = .sheetQuestion
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

/// The quiet placeholder of a read still loading: a few shapes where the content will be, no spinner, in the quiet fill
/// with a slow shimmer crossing it (2.6 s), still with Reduce Motion. A capsule unless given its corner `radius`.
struct Placeholder: View {
    var width: CGFloat? = nil
    var height: CGFloat = 14
    var radius: CGFloat? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var crossed = false

    var body: some View {
        // The band runs the shape's width twice over, from past its right edge to past its left.
        let band = LinearGradient(
            stops: [
                .init(color: .clear, location: 0.35), .init(color: Palette.fg.opacity(0.09), location: 0.5),
                .init(color: .clear, location: 0.65),
            ],
            startPoint: UnitPoint(x: crossed ? -2 : 1, y: 0), endPoint: UnitPoint(x: crossed ? 0 : 3, y: 0))
        RoundedRectangle(cornerRadius: radius ?? height / 2)
            .fill(Color.fillTint)
            .overlay { if !reduceMotion { RoundedRectangle(cornerRadius: radius ?? height / 2).fill(band) } }
            .frame(width: width, height: height)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 2.6).repeatForever(autoreverses: false)) { crossed = true }
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

/// Quiet answers in one row: equal widths when each label fits its share; else each as wide as its label plus an equal
/// part of what is left; and when the labels together are wider than the row, each gives up width in proportion, its
/// label shrinking (the caller's `minimumScaleFactor`, under 0.8 since a pill's sides do not shrink), never cut. Its
/// ideal width is the narrowest it can be (80%), so a `ViewThatFits` falls back to a stack only when that does not fit.
struct AnswerRow: Layout {
    var spacing: CGFloat = 8  // Metrics.Spacing.s, which a Layout (not on the main actor) cannot read
    static let smallest = 0.8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let narrowest = sizes.reduce(0) { $0 + $1.width } * Self.smallest + gaps(subviews)
        return CGSize(width: proposal.width ?? narrowest, height: sizes.map(\.height).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let ideals = subviews.map { $0.sizeThatFits(.unspecified).width }
        let room = bounds.width - gaps(subviews)
        let total = ideals.reduce(0, +)
        let share = room / CGFloat(max(subviews.count, 1))
        var x = bounds.minX
        for (subview, ideal) in zip(subviews, ideals) {
            let width =
                ideals.allSatisfy({ !(share < $0) })
                ? share
                : total < room ? ideal + (room - total) / CGFloat(subviews.count) : ideal * room / total
            subview.place(
                at: CGPoint(x: x, y: bounds.midY), anchor: .leading,
                proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width + spacing
        }
    }

    private func gaps(_ subviews: Subviews) -> CGFloat { spacing * CGFloat(max(subviews.count - 1, 0)) }
}

/// Where an ask stands among the asks: up to 8, a dot each (6, 6 apart, the current `fg`, the others `tint`); more,
/// the words "3 of 24" in `muted`.
struct PagerDots: View {
    let current: Int
    let total: Int

    var body: some View {
        Group {
            if total > 8 {
                Text("\(current + 1) of \(total)").font(.small).foregroundStyle(Palette.muted)
            } else {
                HStack(spacing: 6) {
                    ForEach(0..<total, id: \.self) { index in
                        Circle().fill(index == current ? Palette.fg : Color.fillTint).frame(width: 6, height: 6)
                    }
                }
            }
        }
        .accessibilityElement().accessibilityLabel("\(current + 1) of \(total)")
    }
}
