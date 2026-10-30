import AppKit
import SwiftUI

/// Life's brand (docs/brand.md): a serif to read, mono to count, monochrome, colour for status only. The values are
/// copied from `assets/brand/tokens.css`, light and dark (brand.test.ts checks them); the app follows the Mac's
/// appearance.
enum Brand {
  static let ground = Color(light: 0xf6f6f6, dark: 0x1f1f1f)
  static let card = Color(light: 0xffffff, dark: 0x2a2a2a)
  static let rule = Color(light: 0xe3e3e3, dark: 0x3a3a3a)
  static let ink = Color(light: 0x1f1f1f, dark: 0xf2f2f2)
  static let muted = Color(light: 0x6b6b6b, dark: 0xa3a3a3)
  static let control: CGFloat = 12
  static let panel: CGFloat = 18

  /// Source Serif 4 and IBM Plex Mono ship in the bundle (`apps/mac/Fonts`, `ATSApplicationFontsPath`).
  static func serif(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .custom("Source Serif 4", size: size).weight(weight)
  }

  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .custom("IBM Plex Mono", size: size).weight(weight)
  }
}

/// The wordmark, outlined (`life.pdf`, from assets/brand/life.svg by `scripts/app.ts`): a template image, drawn in the
/// text's colour at the given height.
struct Wordmark: View {
  static let image: NSImage = {
    let image = NSImage(named: "life")!
    image.isTemplate = true
    return image
  }()

  let height: CGFloat

  var body: some View {
    Image(nsImage: Self.image).resizable().scaledToFit().frame(height: height).accessibilityLabel("Life")
  }
}

extension Text {
  /// A section's or a group's label: small mono capitals.
  func label() -> some View {
    font(Brand.mono(10.5, .medium)).textCase(.uppercase).kerning(0.8).foregroundStyle(Brand.muted)
  }

  /// A note under a setting: small serif, muted.
  func caption() -> some View {
    font(Brand.serif(11)).foregroundStyle(Brand.muted)
  }
}

extension Tone {
  var color: Color {
    switch self {
    case .ok: Color(0x15803d)
    case .warn: Color(0xf59e0b)
    case .bad: Color(0xb42318)
    case .busy: Color(0x3b82f6)
    case .teal: Color(0x14b8a6)
    case .idle: Color(0x8b8f97)
    }
  }
}

extension Color {
  /// The same colour in both appearances: a status colour.
  init(_ hex: UInt32) { self.init(light: hex, dark: hex) }

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
