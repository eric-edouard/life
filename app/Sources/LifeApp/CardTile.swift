import SwiftUI

/// A card on the plate: its name and state, its headline, when it happened, a running sweep's stations.
struct CardTile: View {
  let card: Card
  /// The plate lists it in trouble (`Plate.trouble`).
  let trouble: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(card.name).font(Ledger.serif(14, .semibold)).foregroundStyle(Ledger.ink).lineLimit(1)
        Spacer(minLength: 0)
        Pill(tone: card.tone, word: card.word)
      }
      if card.headline != card.word {
        Text(card.headline).font(Ledger.serif(12.5)).foregroundStyle(Ledger.muted).lineLimit(2)
      }
      if let at = card.at {
        Text(ago(at)).font(Ledger.mono(10.5)).foregroundStyle(Ledger.muted)
      }
      if let stations = card.stations, !stations.isEmpty {
        HStack(spacing: 3) {
          ForEach(stations, id: \.self) { s in
            Capsule().fill(color(s.state)).frame(height: 3)
          }
        }
        .accessibilityLabel("Now at \(stations.first { $0.state == "now" }?.name ?? "the end")")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Ledger.panel, in: .rect(cornerRadius: 10))
    .overlay {
      RoundedRectangle(cornerRadius: 10)
        .strokeBorder(trouble ? card.tone.color.opacity(0.55) : Ledger.line, lineWidth: 1)
    }
    .shadow(color: trouble ? card.tone.color.opacity(0.14) : .clear, radius: 14)
    .contentShape(.rect(cornerRadius: 10))
  }

  private func color(_ state: String) -> Color {
    switch state {
    case "done": Tone.ok.color
    case "now": Tone.busy.color
    default: Ledger.line
    }
  }
}
