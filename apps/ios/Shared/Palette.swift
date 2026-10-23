import SwiftUI
import UIKit

/// The owner-approved colors (docs/voice/design.md), shared by the app, its widgets and the Watch: dark grayscale with one
/// deep red. The app is dark-only. On the iPhone every token resolves to a stronger variant under Increase Contrast.
/// Nonisolated: SwiftUI resolves dynamic colors on its async render thread, and a main-actor provider closure traps
/// there.
nonisolated enum Palette {
    static let ground = token(rgb(0x0B0A0A), high: rgb(0x000000))
    static let surface1 = token(rgb(0x141312), high: rgb(0x1A1918))
    static let surface2 = token(rgb(0x1C1A19), high: rgb(0x272524))
    static let surface3 = token(rgb(0x232120), high: rgb(0x312E2D))
    static let hairline = token(rgb(0xECE7E1, 0.08), high: rgb(0xECE7E1, 0.26))

    static let textPrimary = token(rgb(0xECE7E1), high: rgb(0xFFFFFF))
    static let textBody = token(rgb(0xCFC8C0), high: rgb(0xE8E2DB))
    static let textSecondary = token(rgb(0xA9A29B), high: rgb(0xD2CBC4))
    static let textTertiary = token(rgb(0x8A837D), high: rgb(0xB8B1AA))

    /// The one red for primary actions (play, export, save) and selection.
    static let redFill = token(rgb(0x9B1B24), high: rgb(0xB3222C))
    static let redText = token(rgb(0xE2626A), high: rgb(0xF4979D))
    /// Text and glyphs on `redFill`, and the word being spoken.
    static let textOnRed = token(rgb(0xFFF6F3), high: rgb(0xFFFFFF))
    static let liveDot = token(rgb(0xD9363E), high: rgb(0xF04A52))
    /// A battery charging, as iOS draws it. Only there.
    static let charging = token(rgb(0x30D158), high: rgb(0x5BE07A))

    private static func token(_ normal: UIColor, high: UIColor) -> Color {
        #if os(watchOS)
            // The Watch has no Increase Contrast trait to follow.
            Color(uiColor: normal)
        #else
            Color(uiColor: UIColor { $0.accessibilityContrast == .high ? high : normal })
        #endif
    }

    private static func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}
