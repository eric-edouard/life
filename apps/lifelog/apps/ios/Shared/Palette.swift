import SwiftUI
import UIKit

/// Life's palette (docs/brand.md, `assets/brand/tokens.css`), shared by the app, its widgets and the Watch, dark and
/// light as the system says. This is the one copy on the phone: `scripts/brand.test.ts` fails when it drifts from
/// tokens.css, so edit tokens.css first. Colour always means something: `flag` needs the owner, `ai` is an agent or
/// Life's guess, `ok` is "it worked".
/// Unspecified (the Watch, always dark) reads as dark. Nonisolated: SwiftUI resolves dynamic colors on its async render thread, and a main-actor provider closure traps
/// there.
nonisolated enum Palette {
    static let bg = token(dark: 0x000000, light: 0xf3f4f5)
    static let fg = token(dark: 0xfff8ea, light: 0x0d0e11)
    static let card = token(dark: 0x0b0c0e, light: 0xe8e9eb)
    static let tile = token(dark: 0x111214, light: 0xe8e9eb)
    static let sheet = token(dark: 0x000000, light: 0xf3f4f5)
    static let paper = token(dark: 0x131416, light: 0xfbfbfa)
    static let muted = token(dark: 0x8a867e, light: 0x57544f)
    static let faint = token(dark: 0x85817a, light: 0x6c6964)
    static let line = token(dark: 0x1f2024, light: 0xd8d9dc)
    static let flag = token(dark: 0xf0896f, light: 0xb3412b)
    static let ai = token(dark: 0x9aa8ec, light: 0x33468f)
    static let ok = token(dark: 0x30d158, light: 0x1a7f3c)
    static let on = token(dark: 0x000000, light: 0xf3f4f5)
    /// A line icon beside a row (components.md "Settings row"): `fg` at 85%.
    static let icon = fg.opacity(0.85)
    /// A QR's paper, white in both themes: a code scans dark on white.
    static let qrPaper = Color.white

    /// A colour for dark and light. Life's own are the tokens above; the only other caller is a draft's chat, drawn in
    /// its platform's own colours (`ChatLook`, decision 82).
    static func token(dark: UInt32, light: UInt32) -> Color {
        #if os(watchOS)
            Color(uiColor: rgb(dark))
        #else
            Color(uiColor: UIColor { $0.userInterfaceStyle == .light ? rgb(light) : rgb(dark) })
        #endif
    }

    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension Palette {
    /// Cream at a strength, as tokens.css's `--tint`, `--glass`, `--wash`: a quiet pill and his bubble; a floating
    /// control; an unfolded item. The only greys the phone draws.
    static let tint = fg.opacity(0.10)
    static let glass = fg.opacity(0.14)
    static let wash = fg.opacity(0.05)

    /// The aura's colours, in hue order (tokens.css `--aura-*`, checked by `brand.test.ts`). Life blue is `ai` and
    /// cream is `fg`: they are the two ends the aura's own ones sit between.
    static let auraColours: [(name: String, color: Color)] = [
        ("rose", token(dark: 0xee8fb1, light: 0xa3345e)), ("amber", token(dark: 0xf2ad5b, light: 0x8f5510)),
        ("sand", token(dark: 0xe3c48f, light: 0x7a5a24)), ("sage", token(dark: 0xa7cf96, light: 0x3f6b35)),
        ("teal", token(dark: 0x6cd0c4, light: 0x126e66)), ("sky", token(dark: 0x86c5f0, light: 0x1f5f8b)),
        ("orchid", token(dark: 0xc59bf0, light: 0x6a3ba6)), ("silver", token(dark: 0xc4c7cf, light: 0x555963)),
    ]
}
