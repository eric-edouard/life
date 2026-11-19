import LifeConnector
import SwiftUI

/// What leads a flat row, in the round 32 slot.
enum FlatLead {
    case person(String)
    case symbol(String)
}

/// One row of a flat list (an agent's wake list, the people sheet). Not a settings `Row`: the wake list is flat (no fill, no dividers), each row 48 high
/// with a round 32 lead, the title, a small line under it and one thing at the right. Muted when the line can never fire.
struct FlatRow<Title: View, Trailing: View>: View {
    let lead: FlatLead
    var detail: String?
    var detailColor = Palette.muted
    var isMuted = false
    @ViewBuilder var title: Title
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            slot
            VStack(alignment: .leading, spacing: 1) {
                title.foregroundStyle(isMuted ? Palette.muted : Palette.fg).lineLimit(2)
                if let detail { Text(detail).font(.small).foregroundStyle(detailColor).lineLimit(1) }
            }
            Spacer(minLength: 0)
            if !isMuted { trailing }
        }
        .frame(minHeight: Metrics.FlatRow.row)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var slot: some View {
        switch lead {
        case .person(let name): Avatar(name: name, size: Metrics.FlatRow.slot).opacity(isMuted ? 0.45 : 1)
        case .symbol(let symbol):
            Image(systemName: symbol).font(.smallStrong).foregroundStyle(Palette.fg)
                .frame(width: Metrics.FlatRow.slot, height: Metrics.FlatRow.slot).background(Color.fillTint, in: .circle)
                .opacity(isMuted ? 0.45 : 1).accessibilityHidden(true)
        }
    }
}

/// A clause's words: its figures and quoted words in the normal weight, the rest lighter.
struct ClauseText: View {
    let pieces: [WakeClause.Piece]

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        var out = AttributedString()
        for piece in pieces {
            var run = AttributedString(piece.text)
            run.font = (piece.isFigure ? TypeStep.rowFigure : TypeStep.rowName).font(at: typeSize)
            out += run
        }
        return Text(out)
    }
}

/// The networks a line listens on, as marks; VoiceOver reads their names.
struct Networks: View {
    let apps: [String]

    var body: some View {
        HStack(spacing: Metrics.Spacing.xs) { ForEach(apps, id: \.self) { NetworkMark(network: $0) } }
            .accessibilityElement(children: .ignore)
            .accessibilityValue(apps.map(ActionCopy.channel).joined(separator: ", "))
    }
}
