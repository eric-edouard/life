import SwiftUI

/// The pieces every v1 screen is drawn with (the app design's `ak-p`, `ak-b`, `chip`, `tile`): a fill of the palette,
/// never a border, and nothing tappable under 44 points.
extension Color {
    /// The quiet fill of a secondary button or a chip: the page's ink at a low strength, as the design's `--tint`.
    static let fillTint = Palette.fg.opacity(0.08)
}

/// The two buttons of a card, a sheet and a result: the filled pill (cream in dark) and the quiet one.
struct PillStyle: ButtonStyle {
    enum Kind { case filled, quiet }

    let kind: Kind
    var height: CGFloat = 54
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.buttonLabel)
            .foregroundStyle(kind == .filled ? Palette.on : Palette.fg)
            .frame(maxWidth: .infinity, minHeight: height)
            .background(kind == .filled ? Palette.fg : Color.fillTint, in: .capsule)
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
            .contentShape(.capsule)
    }
}

extension ButtonStyle where Self == PillStyle {
    static func pill(_ kind: PillStyle.Kind, height: CGFloat = 54) -> PillStyle {
        PillStyle(kind: kind, height: height)
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
    func readingWidth(_ width: CGFloat = 640) -> some View {
        frame(maxWidth: width).frame(maxWidth: .infinity)
    }
}

/// A line that names the server's limit ("20 seconds at most"): the limit as it was when the action began, kept while it
/// counts down. `text` gets the phrase, or nil while the server has named none.
struct LimitNote: View {
    let limit: Date?
    let text: (String?) -> String
    @State private var seconds: Int?

    var body: some View {
        Text(text(seconds.map { "\($0) seconds at most" }))
            .onChange(of: limit, initial: true) { _, limit in
                if seconds == nil, let limit { seconds = max(1, Int(limit.timeIntervalSinceNow.rounded(.up))) }
            }
    }
}
