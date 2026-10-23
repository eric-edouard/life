import SwiftUI

/// The Pendant's battery as iOS draws one, in the app and its widgets: neutral, red at 20 % or below, green while charging. A level that is only
/// last known gets a dashed, dim outline; an unknown one an empty case. Decorative: the figure beside it speaks.
struct BatteryGlyph: View {
    let percent: Int?
    var charging = false
    /// Reported by a connected Pendant just now.
    var isCurrent = true
    var width: CGFloat = 30

    static let lowAtOrBelow = 20

    var body: some View {
        let height = (width * 0.47).rounded()
        let fraction = Double(min(max(percent ?? 0, 0), 100)) / 100
        let outline = isCurrent ? Palette.textPrimary.opacity(0.45) : Palette.textTertiary.opacity(0.6)
        HStack(spacing: 1) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height * 0.3)
                    .strokeBorder(outline, style: StrokeStyle(lineWidth: 1.5, dash: isCurrent ? [] : [2.5, 2]))
                RoundedRectangle(cornerRadius: height * 0.18)
                    .fill(fill)
                    .frame(width: (width - 6) * fraction, height: height - 6)
                    .padding(.leading, 3)
                if charging && isCurrent {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: height * 0.62, weight: .heavy))
                        .foregroundStyle(Palette.textPrimary)
                        .shadow(color: Palette.ground, radius: 0.5)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(width: width, height: height)
            UnevenRoundedRectangle(bottomTrailingRadius: 1.5, topTrailingRadius: 1.5)
                .fill(outline)
                .frame(width: 2, height: height * 0.36)
        }
        .accessibilityHidden(true)
    }

    private var fill: Color {
        guard isCurrent else { return Palette.textTertiary.opacity(0.5) }
        if charging { return Palette.charging }
        return (percent ?? 100) <= Self.lowAtOrBelow ? Palette.redText : Palette.textPrimary
    }
}
