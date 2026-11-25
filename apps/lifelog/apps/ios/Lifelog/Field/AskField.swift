import SwiftUI

/// The field at the bottom of every screen: type, or hold the microphone to talk, then send. While Life answers and
/// the field is empty, a Stop sits above it. It grows upward with his words (`DictationField`'s card).
struct AskField: View {
    @Binding var text: String
    let isWorking: Bool
    @Binding var isSpeaking: Bool
    let send: () -> Void
    let stop: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .trailing, spacing: Metrics.Spacing.s) {
            if isWorking && text.isEmpty {
                Button(action: stop) {
                    Image(systemName: "stop.fill").font(.system(size: 14)).frame(width: 44, height: 44)
                }
                .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Stop").appears()
            }
            DictationField(
                prompt: "Ask Life", text: $text, axis: .vertical, focused: $focused, send: send, isCard: true,
                listening: $isSpeaking
            )
            .font(.body15).foregroundStyle(Palette.fg)
            .padding(.horizontal, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.xs)
            .glassEffect(.regular, in: .rect(cornerRadius: Metrics.Radius.sheet))
        }
    }
}
