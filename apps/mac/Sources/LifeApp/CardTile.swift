import SwiftUI

/// A card in the status snapshot: its name and state, its headline, when it happened, a running sweep's stations.
struct CardTile: View {
  let card: Card
  /// The status snapshot lists it in trouble (`StatusSnapshot.trouble`).
  let trouble: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      // The name whole, its state beside it when both fit, else under it.
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          name.fixedSize()
          Spacer(minLength: 0)
          Pill(tone: card.tone, word: card.word).fixedSize()
        }
        VStack(alignment: .leading, spacing: 6) {
          name
          Pill(tone: card.tone, word: card.word)
        }
      }
      if card.headline != card.word {
        Text(card.headline).font(Brand.serif(12.5)).foregroundStyle(Brand.muted).lineLimit(2)
      }
      if let at = card.at {
        Text(ago(at)).font(Brand.mono(10.5)).foregroundStyle(Brand.muted)
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
    .background(Brand.page, in: .rect(cornerRadius: Brand.control))
    .overlay {
      RoundedRectangle(cornerRadius: Brand.control)
        .strokeBorder(Brand.rule, lineWidth: 1)
    }
    // In trouble: a short stripe in its colour.
    .overlay(alignment: .leading) {
      if trouble { Capsule().fill(card.tone.color).frame(width: 3).padding(.vertical, 12) }
    }
    .contentShape(.rect(cornerRadius: Brand.control))
  }

  private var name: some View {
    Text(card.name).font(Brand.serif(14, .semibold)).foregroundStyle(Brand.ink)
  }

  private func color(_ state: String) -> Color {
    switch state {
    case "done": Tone.ok.color
    case "now": Tone.busy.color
    default: Brand.rule
    }
  }
}
