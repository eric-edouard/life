import SwiftUI

/// The field at the bottom of every screen: type, or hold the microphone to talk, then send. While Life answers and
/// the field is empty, its keys are one Stop. It grows upward with his words (`DictationField`'s card).
struct AskField: View {
    @Binding var text: String
    let isWorking: Bool
    @Binding var isSpeaking: Bool
    var isFocused: FocusState<Bool>.Binding
    let send: () -> Void
    let stop: () -> Void

    var body: some View {
        DictationField(
            prompt: "Ask Life or hold to talk", text: $text, axis: .vertical, focused: isFocused, send: send,
            isCard: true, listening: $isSpeaking, stop: isWorking && text.isEmpty ? stop : nil
        )
        .font(.body15).foregroundStyle(Palette.fg)
        .padding(.horizontal, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.xs)
        .glassEffect(.regular, in: .rect(cornerRadius: Metrics.Radius.sheet))
    }
}
