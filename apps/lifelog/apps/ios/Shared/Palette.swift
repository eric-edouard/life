import SwiftUI
import UIKit

/// Life's palette (docs/brand.md, `assets/brand/tokens.css`), shared by the app, its widgets and the Watch, dark and
/// light as the system says. This is the one copy on the phone: `scripts/brand.test.ts` fails when it drifts from
/// tokens.css, so edit tokens.css first. Colour always means something: `flag` needs the owner, `ai` is an agent or
/// Life's guess, `ok` is "it worked".
/// Unspecified (the Watch, always dark) reads as dark. Nonisolated: SwiftUI resolves dynamic colors on its async render thread, and a main-actor provider closure traps
/// there.
nonisolated enum Palette {
    static let bg = token(dark: 0x07080a, light: 0xf3f4f5)
    static let fg = token(dark: 0xfff8ea, light: 0x0d0e11)
    static let card = token(dark: 0x15161a, light: 0xe8e9eb)
    static let tile = token(dark: 0x1d1e23, light: 0xe8e9eb)
    static let sheet = token(dark: 0x101114, light: 0xf3f4f5)
    static let paper = token(dark: 0x1b1c20, light: 0xfbfbfa)
    static let muted = token(dark: 0x8a867e, light: 0x57544f)
    static let faint = token(dark: 0x85817a, light: 0x6c6964)
    static let line = token(dark: 0x1f2024, light: 0xd8d9dc)
    static let flag = token(dark: 0xf0896f, light: 0xb3412b)
    static let ai = token(dark: 0x9aa8ec, light: 0x33468f)
    static let ok = token(dark: 0x30d158, light: 0x1a7f3c)
    static let on = token(dark: 0x07080a, light: 0xf3f4f5)
    /// A line icon beside a row (components.md "Settings row"): `fg` at 85%.
    static let icon = fg.opacity(0.85)
    /// A QR's paper, white in both themes: a code scans dark on white.
    static let qrPaper = Color.white

    private static func token(dark: UInt32, light: UInt32) -> Color {
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

extension Color {
    /// The quiet fill of a secondary button, a chip or a disc: the page's ink at a low strength, as the design's `--tint`.
    static let fillTint = Palette.fg.opacity(0.08)
}
