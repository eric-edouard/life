import SwiftUI

/// The Pendant's battery drawn as a battery, in the app and its widgets: a case in the quiet tint, a fill that is the
/// charge in the colour the caller decided (flag when low, ok while charging), and the terminal. No outline. A level
/// that is only last known is dimmed; an unknown or empty one draws no fill. Decorative: the figure beside it speaks.
struct BatteryGlyph: View {
    let percent: Int?
    var tone = Palette.fg
    var charging = false
    /// Reported by a connected Pendant just now.
    var isCurrent = true
    var width: CGFloat = 30

    var body: some View {
        let height = (width * 0.47).rounded()
        let inset = (height * 0.09).rounded()
        let fraction = Double(min(max(percent ?? 0, 0), 100)) / 100
        HStack(spacing: 1) {
            RoundedRectangle(cornerRadius: height * 0.27).fill(Palette.fg.opacity(0.08))
                .overlay(alignment: .leading) {
                    if fraction > 0 {
                        RoundedRectangle(cornerRadius: height * 0.18).fill(
                            isCurrent ? tone : Palette.faint.opacity(0.5)
                        )
                        .frame(width: (width - 2 * inset) * fraction, height: height - 2 * inset)
                        .padding(.leading, inset)
                    }
                }
                .overlay {
                    if charging && isCurrent {
                        Image(systemName: "bolt.fill").font(.system(size: height * 0.62, weight: .heavy))
                            .foregroundStyle(Palette.fg).shadow(color: Palette.bg, radius: 0.5)
                    }
                }
                .frame(width: width, height: height)
            UnevenRoundedRectangle(bottomTrailingRadius: 1.5, topTrailingRadius: 1.5)
                .fill(Palette.fg.opacity(0.08)).frame(width: max(width * 0.05, 2), height: height * 0.36)
        }
        .accessibilityHidden(true)
    }
}
