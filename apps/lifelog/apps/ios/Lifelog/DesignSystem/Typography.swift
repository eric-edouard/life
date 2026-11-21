import SwiftUI
import UIKit

/// Manrope only, the brand's one face (`docs/brand.md`): bold (650) for a name and a heading, thin (250) only for a state word and a card's title, 15 point
/// body, small labels in capitals. One bundled variable font, registered in Info.plist (`UIAppFonts`), whose weight is
/// set on its `wght` axis so 250 and 650 are real weights. Every text is one step of this scale, set with `.font(.step)`:
/// the step is resolved in the view, so a change of Dynamic Type size shows at once. Nothing draws a size or weight of its own.
struct TypeStep: Equatable {
    let size: CGFloat
    let weight: CGFloat
    let style: UIFont.TextStyle
    var hasFixedDigits = false
    /// The system's monospaced face (`--font-mono`), for code in a context: the one step not in Manrope.
    var isMono = false

    /// A card's title: thin.
    static let cardHeadline = TypeStep(size: 24, weight: 250, style: .title2)
    /// The question a card puts to him, first on it: bold.
    static let cardQuestion = TypeStep(size: 26, weight: 650, style: .title2)
    /// A big word that says where something stands: "Recording.", "Sent.".
    static let statusWord = TypeStep(size: 40, weight: 250, style: .largeTitle)
    /// The figure on a tile: "82%".
    static let tileFigure = TypeStep(size: 26, weight: 650, style: .title2, hasFixedDigits: true)
    /// The first line of a sheet ("Starting", "Who?"): bold.
    static let sheetQuestion = TypeStep(size: 22, weight: 650, style: .title3)
    /// A list screen's short title on its blurred header (`ScreenTitle`): "Inbox", "Matters".
    static let screenTitle = TypeStep(size: 22, weight: 700, style: .title2)
    /// A screen's name where the system's large title would be: "Settings", a matter's name.
    static let screenName = TypeStep(size: 30, weight: 650, style: .title1)
    /// Words he or someone said, a message, a goal he edits.
    static let quote = TypeStep(size: 19, weight: 450, style: .title3)
    /// A name inside a quote.
    static let quoteBold = TypeStep(size: 19, weight: 700, style: .title3)
    /// A name in a row, a button of a row, a person.
    static let rowName = TypeStep(size: 16, weight: 600, style: .body)
    /// A line that leads a block, and the same bold.
    static let lead = TypeStep(size: 17, weight: 500, style: .body)
    /// The figure or the quoted words inside a row's clause: the row's size at body weight.
    static let rowFigure = TypeStep(size: 16, weight: 450, style: .body)
    static let leadBold = TypeStep(size: 17, weight: 600, style: .body)
    static let body15 = TypeStep(size: 15, weight: 450, style: .body)
    /// A name in bold inside running text: the name an ask is about, in the sentence it was said in.
    static let bodyBold = TypeStep(size: 15, weight: 700, style: .body)
    /// Text that matters inside a card or a block: the thing to do.
    static let bodyStrong = TypeStep(size: 15, weight: 600, style: .body)
    /// Secondary text: a context, what a problem means, a row's value.
    static let note = TypeStep(size: 14, weight: 450, style: .footnote)
    /// Every button's label.
    static let buttonLabel = TypeStep(size: 15.5, weight: 650, style: .body)
    /// A chip and a count's pill.
    static let chip = TypeStep(size: 14, weight: 600, style: .footnote)
    static let small = TypeStep(size: 13, weight: 500, style: .footnote)
    /// A link: `small` at 600.
    static let smallStrong = TypeStep(size: 13, weight: 600, style: .footnote)
    /// The small label over a block.
    static let label = TypeStep(size: 13, weight: 600, style: .footnote)
    /// The two glyphs of the column toast (`ColumnToast`).
    static let columnGlyph = TypeStep(size: 20, weight: 600, style: .title3)
    /// The number in a badge.
    static let badge = TypeStep(size: 11, weight: 700, style: .caption2)
    /// A reach tile's app name, under its mark.
    static let reachLabel = TypeStep(size: 11, weight: 600, style: .caption2)

    static let monoTime = TypeStep(size: 13, weight: 500, style: .footnote, hasFixedDigits: true)
    static let monoDetail = TypeStep(size: 12, weight: 500, style: .caption1, hasFixedDigits: true)
    static let monoSmall = TypeStep(size: 11, weight: 500, style: .caption2, hasFixedDigits: true)

    /// A heading in a context (`#`, `##`): the sheet's head is its only top level.
    static let contextHeading = TypeStep(size: 17, weight: 700, style: .headline)
    /// Code inside a context's sentence, and a log line's message in full (its detail).
    static let codeInline = TypeStep(size: 14, weight: 450, style: .footnote, isMono: true)
    /// A context's code block, and a line of the live log.
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
    func label() -> some View { font(.label) }

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
