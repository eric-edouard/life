import SwiftUI

/// A network's mark: a small disc in its colour (WhatsApp's green) with a bubble; a network with no colour of its own
/// gets the `card` fill.
struct NetworkMark: View {
    let network: String?

    var body: some View {
        Image(systemName: "bubble.left.fill").font(.system(size: 11)).foregroundStyle(.white)
            .frame(width: 22, height: 22)
            .background(network == "whatsapp" ? Color(red: 0.145, green: 0.827, blue: 0.4) : Palette.faint, in: .circle)
            .accessibilityHidden(true)
    }
}
