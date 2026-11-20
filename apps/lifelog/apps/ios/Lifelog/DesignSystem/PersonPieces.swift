import LifeConnector
import SwiftUI

/// A person's initials on a `card` disc; a network's mark sits on its corner when given.
struct Avatar: View {
    let name: String
    var size: CGFloat = 64
    var network: String?

    var body: some View {
        Text(SaidWords.initials(name)).font(.leadBold).foregroundStyle(Palette.fg)
            .frame(width: size, height: size).background(Palette.card, in: .circle)
            .overlay(alignment: .bottomTrailing) { if network != nil { NetworkMark(network: network) } }
            .accessibilityHidden(true)
    }
}

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
