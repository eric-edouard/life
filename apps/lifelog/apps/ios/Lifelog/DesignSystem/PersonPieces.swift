import LifeConnector
import SwiftUI

/// A round 44 button holding one symbol, on the quiet fill. `isDone` shows a check in `ok` in its place (copied), same
/// button, same size.
struct RoundIconButton: View {
    let symbol: String
    let label: String
    var isDone = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isDone ? "checkmark" : symbol).font(.smallStrong)
                .foregroundStyle(isDone ? Palette.ok : Palette.fg)
                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget).background(Color.fillTint, in: .circle)
                .motion(Motion.standard, value: isDone)
        }
        .buttonStyle(.plain).accessibilityLabel(label)
    }
}

/// One row of a sheet's fields (`field_rows`): a small `muted` label, "Life's guess" after it in `ai` while the value is
/// Life's and he is not editing it, the value under it, a pencil at the end. A tap anywhere edits the value in place,
/// on the page's fill, with the caret in `fg`.
struct FieldRow: View {
    let label: String
    var prompt = ""
    @Binding var text: String
    var isGuess = false

    @FocusState private var isEditing: Bool

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                HStack(spacing: Metrics.Spacing.s) {
                    // The field carries the label for VoiceOver.
                    Text(label).foregroundStyle(Palette.muted).accessibilityHidden(true)
                    if isGuess && !isEditing { Text("Life’s guess").foregroundStyle(Palette.ai).appears() }
                }
                .font(.small)
                TextField(prompt, text: $text, axis: .vertical).font(.rowFigure).foregroundStyle(Palette.fg)
                    .focused($isEditing).tint(Palette.fg).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(label)
                    .padding(isEditing ? Metrics.Spacing.m : 0)
                    .background(isEditing ? Palette.bg : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "pencil").font(.small).foregroundStyle(Palette.muted).accessibilityHidden(true)
        }
        .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
        .contentShape(.rect).onTapGesture { isEditing = true }
        .motion(Motion.standard, value: isEditing)
        .motion(Motion.standard, value: isGuess)
    }
}
