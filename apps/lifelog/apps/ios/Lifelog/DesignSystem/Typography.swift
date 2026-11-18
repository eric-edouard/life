import SwiftUI
import UIKit

/// Manrope only, the brand's one face (`docs/brand.md`): thin (250) for a title, bold (650) for what matters, 15 point
/// body, small labels in capitals. One bundled variable font, registered in Info.plist (`UIAppFonts`), whose weight is
/// set on its `wght` axis so 250 and 650 are real weights. Every text is one step of this scale, set with `.font(.step)`:
/// the step is resolved in the view, so a change of Dynamic Type size shows at once. Nothing draws a size or weight of its own.
struct TypeStep: Equatable {
    let size: CGFloat
    let weight: CGFloat
    let style: UIFont.TextStyle
    var hasFixedDigits = false

    /// A card's title: thin.
    static let cardHeadline = TypeStep(size: 24, weight: 250, style: .title2)
    /// What the owner decides: bold, with a soft glow in dark (`View.lit()`).
    static let cardQuestion = TypeStep(size: 19, weight: 650, style: .title3)
    /// A big word that says where something stands: "Recording.", "Sent.".
    static let statusWord = TypeStep(size: 50, weight: 250, style: .largeTitle)
    /// A screen's name in a sheet.
    static let sheetTitle = TypeStep(size: 30, weight: 250, style: .title1)
    /// A matter's name.
    static let matterTitle = TypeStep(size: 28, weight: 250, style: .title1)
    /// Words he or someone said, a message, a goal he edits.
    static let quote = TypeStep(size: 19, weight: 450, style: .title3)
    /// A name in a row, a button of a row, a person.
    static let rowName = TypeStep(size: 16, weight: 600, style: .body)
    /// A line that leads a block, and the same bold.
    static let lead = TypeStep(size: 17, weight: 500, style: .body)
    static let leadBold = TypeStep(size: 17, weight: 600, style: .body)
    static let body15 = TypeStep(size: 15, weight: 450, style: .body)
    /// Every button's label.
    static let buttonLabel = TypeStep(size: 15.5, weight: 650, style: .body)
    /// A chip and a count's pill.
    static let chip = TypeStep(size: 14, weight: 600, style: .footnote)
    static let small = TypeStep(size: 13, weight: 500, style: .footnote)
    /// The small capitals over a block.
    static let label = TypeStep(size: 11, weight: 600, style: .caption2)
    /// The number in a badge.
    static let badge = TypeStep(size: 11, weight: 700, style: .caption2)

    /// A figure in a row, to read as a number.
    static let monoFigure = TypeStep(size: 22, weight: 500, style: .title2, hasFixedDigits: true)
    static let monoTime = TypeStep(size: 13, weight: 500, style: .footnote, hasFixedDigits: true)
    static let monoDetail = TypeStep(size: 12, weight: 500, style: .caption1, hasFixedDigits: true)
    static let monoSmall = TypeStep(size: 11, weight: 500, style: .caption2, hasFixedDigits: true)

    /// The step at a Dynamic Type size.
    func font(at size: DynamicTypeSize) -> Font {
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: "Manrope",
            // The variation axis `wght` by its four-character tag.
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [0x7767_6874: weight],
        ])
        let base = UIFont(descriptor: descriptor, size: self.size)
        let category = size.contentSizeCategory
        let scaled = UIFontMetrics(forTextStyle: style).scaledFont(
            for: base, compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
        let font = Font(scaled)
        return hasFixedDigits ? font.monospacedDigit() : font
    }
}

private struct TypeModifier: ViewModifier {
    let step: TypeStep
    @Environment(\.dynamicTypeSize) private var size

    func body(content: Content) -> some View { content.font(step.font(at: size)) }
}

extension View {
    /// Text in a step of the type scale.
    func font(_ step: TypeStep) -> some View { modifier(TypeModifier(step: step)) }

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

extension DynamicTypeSize {
    /// The UIKit category of a SwiftUI Dynamic Type size, for `UIFontMetrics`.
    fileprivate var contentSizeCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }
}
