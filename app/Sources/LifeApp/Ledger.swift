import AppKit
import SwiftUI

/// The owner's Ledger look (agent-config's `ledger-brand` skill, `tokens.css`): a serif to read, mono to count, ruled
/// rows, status as a colour and a word. Light as the skill gives it; dark, at his word, follows the Mac's appearance.
enum Ledger {
  static let page = Color(light: 0xf7f7f5, dark: 0x121314)
  /// The top of the window's ground, where the light falls.
  static let glow = Color(light: 0xffffff, dark: 0x24272b)
  static let panel = Color(light: 0xffffff, dark: 0x1c1e21)
  static let sunk = Color(light: 0xf1f1ee, dark: 0x26292c)
  static let ink = Color(light: 0x1b1d1f, dark: 0xecebe7)
  static let muted = Color(light: 0x6d7176, dark: 0x9a9fa5)
  static let line = Color(light: 0xe1e2de, dark: 0x2c2f33)

  /// Source Serif 4 and IBM Plex Mono ship in the bundle (`app/Fonts`, `ATSApplicationFontsPath`).
  static func serif(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .custom("Source Serif 4", size: size).weight(weight)
  }

  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .custom("IBM Plex Mono", size: size).weight(weight)
  }
}

extension Text {
  /// A section's or a group's label: small mono capitals.
  func label() -> some View {
    font(Ledger.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8).foregroundStyle(Ledger.muted)
  }
}

extension Tone {
  var color: Color {
    switch self {
    case .ok: Color(light: 0x2f8f4e, dark: 0x5cc17b)
    case .warn: Color(light: 0xb87212, dark: 0xe3a043)
    case .bad: Color(light: 0xc4382c, dark: 0xec6b5e)
    case .busy: Color(light: 0x2a62d8, dark: 0x6f9cf5)
    case .teal: Color(light: 0x138f88, dark: 0x3cc0b6)
    case .idle: Color(light: 0x7d8186, dark: 0x9a9fa5)
    }
  }
}

extension Color {
  /// One colour for each appearance, picked by the Mac's light or dark setting.
  init(light: UInt32, dark: UInt32) {
    self.init(
      nsColor: NSColor(name: nil) { look in
        let hex = look.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        return NSColor(
          srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: 1)
      })
  }
}
