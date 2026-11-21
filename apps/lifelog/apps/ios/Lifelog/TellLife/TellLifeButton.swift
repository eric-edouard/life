import SwiftUI

/// The Tell Life button: a glass disc, 56, with Life's voice mark, alone in the rail's free middle (decision 89), on
/// every screen. It sinks under his thumb; a tap opens Tell Life.
struct TellLifeButton: View {
    @Environment(AppRouter.self) private var router

    var body: some View {
        Button {
            router.isTellLifeOpen = true
        } label: {
            TellMark(size: 22).frame(width: 56, height: 56)
        }
        .buttonStyle(SinkStyle())
        .floatingGlass(in: Circle())
        .sensoryFeedback(.impact(weight: .medium), trigger: router.isTellLifeOpen) { _, new in new }
        .accessibilityLabel("Tell Life")
        .accessibilityIdentifier("tell.life")
    }
}

/// Sinks a little under the thumb.
private struct SinkStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed && !reduceMotion ? 0.92 : 1)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}
