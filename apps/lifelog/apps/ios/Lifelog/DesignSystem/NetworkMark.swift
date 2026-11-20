import SwiftUI

/// A network's mark: a small disc in its colour (WhatsApp's green) with a bubble; a network with no colour of its own
/// gets the `faint` fill. 22 on its own; a disc's badge is 40% of the disc.
struct NetworkMark: View {
    let network: String?
    var size: CGFloat = 22

    var body: some View {
        Image(systemName: "bubble.left.fill").font(.system(size: size / 2)).foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(network == "whatsapp" ? Color(red: 0.145, green: 0.827, blue: 0.4) : Palette.faint, in: .circle)
            .accessibilityHidden(true)
    }
}
