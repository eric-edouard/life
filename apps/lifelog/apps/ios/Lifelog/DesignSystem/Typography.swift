import SwiftUI
import UIKit

/// Manrope only, the brand's one face (`docs/brand.md`): seven sizes, weights 450, 600 and 650. One bundled variable font, registered in Info.plist (`UIAppFonts`), whose weight is
/// set on its `wght` axis so 250 and 650 are real weights. Every text is one step of this scale, set with `.font(.step)`:
/// the step is resolved in the view, so a change of Dynamic Type size shows at once. Nothing draws a size or weight of its own.
struct TypeStep: Equatable {
    let size: CGFloat
    let weight: CGFloat
    let style: UIFont.TextStyle
    var hasFixedDigits = false
    /// The system's monospaced face (`--font-mono`), for code in a context: the one step not in Manrope.
    var isMono = false

    // The scale (docs/brand.md, Type; tokens.css `--text-*`): seven sizes, weights 450, 600 and 650.
    /// A profile's name, the question a card puts, a figure, a screen's name.
    static let profileName = TypeStep(size: 26, weight: 650, style: .title2)
    /// An unfolded header, words he or someone said.
    static let header = TypeStep(size: 19, weight: 650, style: .title3)
    /// Words he or someone said, a message, a goal he edits: the header's size at the body's weight.
    static let quote = TypeStep(size: 19, weight: 450, style: .title3)
    /// A row's title, a name, a heading in Life's Markdown.
    static let rowTitle = TypeStep(size: 16, weight: 600, style: .body)
    /// The figure or quoted words inside a row's clause: the title's size at body weight.
    static let titleLight = TypeStep(size: 16, weight: 450, style: .body)
    /// Body.
    static let body15 = TypeStep(size: 15, weight: 450, style: .body)
    /// Body that matters: the thing to do, every button's label.
    static let bodyStrong = TypeStep(size: 15, weight: 600, style: .body)
    static let bodyBold = TypeStep(size: 15, weight: 650, style: .body)
    /// A row's line: secondary text, a context, a row's value, a chip.
    static let line = TypeStep(size: 13.5, weight: 450, style: .footnote)
    static let lineStrong = TypeStep(size: 13.5, weight: 600, style: .footnote)
    /// A section heading, a link, the small label over a block.
    static let heading = TypeStep(size: 13, weight: 600, style: .footnote)
    /// Meta: a badge, a time, a tile's app name.
    static let meta = TypeStep(size: 11.5, weight: 450, style: .caption2)
    static let metaStrong = TypeStep(size: 11.5, weight: 650, style: .caption2)

    static let monoTime = TypeStep(size: 13, weight: 450, style: .footnote, hasFixedDigits: true)
    static let monoDetail = TypeStep(size: 11.5, weight: 450, style: .caption1, hasFixedDigits: true)
    static let monoSmall = TypeStep(size: 11.5, weight: 450, style: .caption2, hasFixedDigits: true)
    /// Code inside a context's sentence, a context's code block, and a line of the live log.
    static let codeInline = TypeStep(size: 13.5, weight: 450, style: .footnote, isMono: true)
    static let codeBlock = TypeStep(size: 13, weight: 450, style: .footnote, isMono: true)

    /// The step at a Dynamic Type size.
    func font(at size: DynamicTypeSize) -> Font {
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: "Manrope",
            // The variation axis `wght` by its four-character tag.
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [0x7767_6874: weight],
        ])
        let base =
            isMono
            ? UIFont.monospacedSystemFont(ofSize: self.size, weight: .regular)
            : UIFont(descriptor: descriptor, size: self.size)
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

    /// A small label over a block: sentence case, 13 point, 600.
    func label() -> some View { font(.heading) }

    /// The soft glow of the bold line in dark; none in light, or when `isOn` is false.
    func lit(_ isOn: Bool = true) -> some View { modifier(Lit(isOn: isOn)) }
}

private struct Lit: ViewModifier {
    let isOn: Bool
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        if isOn && scheme == .dark {
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
