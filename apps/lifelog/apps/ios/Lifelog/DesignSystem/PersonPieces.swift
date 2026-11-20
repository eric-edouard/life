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

/// A person answer: initials, name and who they are to him on the `tile` fill, 56 high, in a 56 hit area.
struct PersonAnswerStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, Metrics.Spacing.l).frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(Palette.tile, in: .capsule)
            .opacity(configuration.isPressed ? 0.7 : 1).contentShape(.capsule)
    }
}

/// One person as an answer's label: their initials, their name, and their line under it when Life knows one.
struct PersonAnswer: View {
    let person: Check.Person

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            Text(SaidWords.initials(person.name)).font(.buttonLabel).foregroundStyle(Palette.fg)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 0) {
                Text(person.name).font(.buttonLabel).foregroundStyle(Palette.fg)
                if let line = person.line { Text(line).font(.small).foregroundStyle(Palette.muted) }
            }
            .multilineTextAlignment(.leading).padding(.vertical, Metrics.Spacing.xs)
        }
        .accessibilityElement(children: .combine)
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
