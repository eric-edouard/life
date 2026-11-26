import SwiftUI

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

extension View {
    /// The card surface: `surface1`, no edge. Content sits on cards; glass stays for the controls.
    func card(radius: CGFloat = Metrics.Radius.block) -> some View {
        background(Palette.card, in: .rect(cornerRadius: radius))
    }
}

extension View {
    /// The soft wash behind an unfolded item or an ask: the page's cream at 5% fading to nothing from a point left of
    /// centre, reaching nothing at the top and left edges, so it has none. It reaches past the view by a gutter each side and a step above and below, so the screen's
    /// edges are covered and the fade has room (the prototype's `.inplace`).
    func washed(_ isOn: Bool) -> some View {
        background {
            if isOn {
                EllipticalGradient(
                    colors: [Palette.wash, Palette.wash.opacity(0)], center: UnitPoint(x: 0.4, y: 0.4),
                    startRadiusFraction: 0, endRadiusFraction: 0.4
                )
                .padding(.horizontal, -Metrics.Spacing.l).padding(.vertical, -Metrics.Spacing.l).allowsHitTesting(false)
            }
        }
    }
}
