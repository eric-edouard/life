import SwiftUI
import UIKit

/// Manrope only, the brand's one face (`docs/brand.md`): thin (250) for a title, bold (650) for what matters, 15 point
/// body, small labels in capitals. One bundled variable font, registered in Info.plist (`UIAppFonts`), whose weight is
/// set on its `wght` axis so 250 and 650 are real weights; every size scales with Dynamic Type through its text style.
extension Font {
    /// Manrope at `size` and a weight from 200 to 800 on the font's own axis.
    static func manrope(_ size: CGFloat, weight: CGFloat = 400, relativeTo style: UIFont.TextStyle = .body) -> Font {
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: "Manrope",
            // The variation axis `wght` by its four-character tag.
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [0x7767_6874: weight],
        ])
        let font = UIFont(descriptor: descriptor, size: size)
        return Font(UIFontMetrics(forTextStyle: style).scaledFont(for: font))
    }

    /// A card's title: thin.
    static let cardHeadline = manrope(24, weight: 250, relativeTo: .title2)
    /// What the owner decides: bold, with a soft glow in dark (`View.lit()`).
    static let cardQuestion = manrope(19, weight: 650, relativeTo: .title3)
    /// A big word that says where something stands: "Recording.", "Sent.".
    static let statusWord = manrope(50, weight: 250, relativeTo: .largeTitle)
    /// A screen's name in a sheet.
    static let sheetTitle = manrope(30, weight: 250, relativeTo: .title1)
    /// A matter's name.
    static let matterTitle = manrope(28, weight: 250, relativeTo: .title1)
    /// A row's name and every button.
    static let rowName = manrope(16.5, weight: 600, relativeTo: .body)
    static let body15 = manrope(15, weight: 400, relativeTo: .body)
    static let buttonLabel = manrope(15.5, weight: 650, relativeTo: .body)
    static let small = manrope(13, weight: 500, relativeTo: .footnote)
    /// The small capitals over a block.
    static let label = manrope(11, weight: 600, relativeTo: .caption2)
    /// A figure at a glance: "82%".
    static let figure = manrope(30, weight: 300, relativeTo: .title1)

    /// A figure in a row, to read as a number.
    static let monoFigure = manrope(22, weight: 500, relativeTo: .title2).monospacedDigit()
    static let monoTime = manrope(13, weight: 500, relativeTo: .footnote).monospacedDigit()
    static let monoDetail = manrope(12, weight: 500, relativeTo: .caption1).monospacedDigit()
    static let monoSmall = manrope(11, weight: 500, relativeTo: .caption2).monospacedDigit()
}

extension View {
    /// A small label in capitals with wide letter spacing (11 point, 600, 0.22em).
    func label(tracking: CGFloat = 0.22) -> some View {
        font(.label).tracking(tracking * 11).textCase(.uppercase)
    }

    /// The soft glow of the bold line in dark; none in light.
    func lit() -> some View { modifier(Lit()) }
}

private struct Lit: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        if scheme == .dark {
            content.shadow(color: Palette.fg.opacity(0.5), radius: 7).shadow(
                color: Palette.fg.opacity(0.26), radius: 26)
        } else {
            content
        }
    }
}
