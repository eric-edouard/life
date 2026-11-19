import LifeConnector
import SwiftUI

/// The agent's row on a matter: its runtime in `ai`, one line under it (who it listens for and its deadline, or its state;
/// `flag` when it never started), a chevron. It opens the agent's sheet.
struct AgentRow: View {
    let agent: RegisteredAgent
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Metrics.Spacing.s) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(agent.runtimeName.name, systemImage: "sparkle").font(.bodyStrong).foregroundStyle(Palette.ai)
                    if let line = agent.rowLine() {
                        Text(line).font(.small).foregroundStyle(agent.notStarted == nil ? Palette.muted : Palette.flag)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.smallStrong).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.m)
            .frame(maxWidth: .infinity, alignment: .leading).card().contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

/// What leads a wake row, in the round 32 slot.
enum WakeLead {
    case person(String)
    case symbol(String)
}

/// One row of a wake list in a `RowGroup`: its lead, the title, a small line under it, one thing at the right. Muted when
/// the line can never fire.
struct WakeRowView<Title: View, Trailing: View>: View {
    let lead: WakeLead
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
        .padding(.horizontal, Metrics.Spacing.l).frame(minHeight: Metrics.Wake.row)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var slot: some View {
        switch lead {
        case .person(let name): Avatar(name: name, size: Metrics.Wake.slot).opacity(isMuted ? 0.45 : 1)
        case .symbol(let symbol):
            Image(systemName: symbol).font(.smallStrong).foregroundStyle(Palette.fg)
                .frame(width: Metrics.Wake.slot, height: Metrics.Wake.slot).background(Color.fillTint, in: .circle)
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
