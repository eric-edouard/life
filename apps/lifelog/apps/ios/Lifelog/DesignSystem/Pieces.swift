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
    /// A draft, a quote or a clip on paper: the `paper` fill at the passage radius.
    func paperBox() -> some View {
        background(Palette.paper, in: .rect(cornerRadius: Metrics.Radius.passage))
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

    @ViewBuilder private func mark(_ mark: CheckLine.Mark) -> some View {
        switch mark {
        case .passed: Image(systemName: "checkmark").foregroundStyle(Palette.ok).font(.system(size: 13, weight: .bold))
        case .running: ProgressView().controlSize(.mini).tint(Palette.fg)
        case .waiting: Circle().fill(Palette.faint).frame(width: 4, height: 4)
        case .failed: Image(systemName: "xmark").foregroundStyle(Palette.flag).font(.system(size: 13, weight: .bold))
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

/// A sheet's top: its name in thin type and the close button.
struct SheetHeader: View {
    let title: String
    var color: Color = Palette.fg
    let close: () -> Void

    var body: some View {
        HStack {
            Text(title).font(.sheetTitle).foregroundStyle(color).lit()
            Spacer()
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.fg)
                    .frame(width: 44, height: 44).background(Color.fillTint, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
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
