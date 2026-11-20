import AppKit
import SwiftUI

/// Life's brand (docs/brand.md): monochrome, colour for status only. The values are
/// copied from `assets/brand/tokens.css`, light and dark (brand.test.ts checks them); the app follows the Mac's
/// appearance.
enum Brand {
  static let ground = Color(light: 0xf3f4f5, dark: 0x07080a)
  static let card = Color(light: 0xe8e9eb, dark: 0x15161a)
  static let rule = Color(light: 0xd8d9dc, dark: 0x1f2024)
  static let ink = Color(light: 0x0d0e11, dark: 0xfff8ea)
  static let muted = Color(light: 0x57544f, dark: 0x8a867e)
  static let control: CGFloat = 12
  static let panel: CGFloat = 22

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
    case .ok: Color(light: 0x1a7f3c, dark: 0x30d158)
    case .warn: Color(light: 0xb3412b, dark: 0xf0896f)
    case .bad: Color(light: 0xb3412b, dark: 0xf0896f)
    case .busy: Color(light: 0x33468f, dark: 0x9aa8ec)
    case .teal: Color(light: 0x1a7f3c, dark: 0x30d158)
    case .idle: Color(light: 0x6c6964, dark: 0x85817a)
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
