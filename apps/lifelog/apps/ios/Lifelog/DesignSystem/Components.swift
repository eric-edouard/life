import SwiftUI

/// A day or group heading: "Today Wed 7 Oct" with an optional mono count on the trailing edge.
/// At accessibility text sizes the parts stack and wrap instead of truncating.
struct SectionHeader: View {
    let title: String
    var detail: String?
    var trailing: String?

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout =
            stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
        layout {
            Text(title).fontWeight(.semibold).foregroundStyle(Palette.fg)
            if let detail { Text(detail).foregroundStyle(Palette.muted) }
            if !stacked { Spacer(minLength: 8) }
            if let trailing { Text(trailing).font(.monoDetail).foregroundStyle(Palette.faint) }
        }
        .font(.body15)
        .lineLimit(stacked ? nil : 1)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One fact under a row: its glyph tight against its value, so each glyph clearly goes with its own value. Set tags
/// apart with `Tag.between`. VoiceOver reads `spoken`, or the value.
struct Tag: View {
    /// The space between two tags, several times the space inside one.
    static let between: CGFloat = 14

    let systemImage: String
    let value: Text
    var spoken: Text?

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
            value
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken ?? value)
    }
}

/// A label whose icon only decorates its words: assistive technologies get the words alone, never the symbol's name
/// as a separate element.
struct DecorativeIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        Label {
            configuration.title
        } icon: {
            configuration.icon.accessibilityHidden(true)
        }
    }
}

extension LabelStyle where Self == DecorativeIconLabelStyle {
    static var decorativeIcon: DecorativeIconLabelStyle { DecorativeIconLabelStyle() }
}

/// A duration in Geist Mono: "58m", "1h 58m", "40s". VoiceOver reads the words.
struct DurationText: View {
    let duration: Duration
    let step: TypeStep

    init(_ duration: Duration, step: TypeStep = .monoDetail) {
        self.duration = duration
        self.step = step
    }

    var body: some View {
        Text(Self.string(duration, width: .narrow))
            .font(step)
            .accessibilityLabel(Self.string(duration, width: .wide))
    }

    /// "58m" (narrow), "58 minutes" (wide).
    static func string(_ duration: Duration, width: Duration.UnitsFormatStyle.UnitWidth) -> String {
        let units: Set<Duration.UnitsFormatStyle.Unit> = duration < .seconds(60) ? [.seconds] : [.hours, .minutes]
        return duration.formatted(.units(allowed: units, width: width))
    }
}

/// Lays views out left to right, starting a new line when the next one doesn't fit (words, chips). A view wider than a
/// whole line gets the line's width, which a `minimumScaleFactor` can shrink it into. Centered, each line centers in
/// the width it was given.
struct FlowLayout: Layout {
    var spacing: CGFloat = 0
    var centered = false

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = frames(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(
            width: proposal.width ?? frames.map(\.maxX).max() ?? 0, height: frames.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, frames(width: bounds.width, subviews: subviews)) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var lineStart = 0
        func centerLine() {
            guard centered, width.isFinite, let last = frames.last else { return }
            let inset = (width - last.maxX) / 2
            for index in lineStart..<frames.count { frames[index].origin.x += inset }
            lineStart = frames.count
        }
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            if x > 0, x + size.width > width {
                centerLine()
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        centerLine()
        return frames
    }
}

extension View {
    /// The card surface: `surface1` with a hairline edge. Content sits on cards; glass stays for the controls.
    func card(radius: CGFloat = Metrics.Radius.card) -> some View {
        background(Palette.card, in: .rect(cornerRadius: radius))
            .overlay { RoundedRectangle(cornerRadius: radius).strokeBorder(Palette.line, lineWidth: 0.5) }
    }
}

/// The half-point rule between rows.
struct Hairline: View {
    /// `line` on the page; `fillTint` inside a filled group, where `line` cannot be seen.
    var color = Palette.line

    var body: some View {
        Rectangle().fill(color).frame(height: 0.5)
    }
}
