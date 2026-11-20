import LifeConnector
import SwiftUI

/// The grid that changes a matter's icon (`icon_grid`): per group a small muted label (20 above but the first, 8 below),
/// then six columns sharing the width, rows 52 high; a cell is a 44 round button, its glyph 22 in `muted`, the chosen
/// one filled `pick`, its glyph in `fg`.
struct IconGrid: View {
    let groups: [MatterIcons.Group]
    let chosen: String?
    let pick: (String) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 6)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element.label) { at, group in
                Text(group.label).font(.smallStrong).foregroundStyle(Palette.muted)
                    .padding(.top, at == 0 ? 0 : 20).padding(.bottom, 8)
                    .accessibilityAddTraits(.isHeader)
                LazyVGrid(columns: columns, spacing: 0) {
                    ForEach(group.icons, id: \.key) { cell($0) }
                }
            }
        }
    }

    private func cell(_ icon: MatterIcons.Icon) -> some View {
        let isChosen = icon.key == chosen
        return Button {
            pick(icon.key)
        } label: {
            Image(systemName: icon.symbol).font(.system(size: 22))
                .foregroundStyle(isChosen ? Palette.fg : Palette.muted)
                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
                .background(isChosen ? Color.pick : .clear, in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, minHeight: 52)
        .motion(Motion.standard, value: isChosen)
        .accessibilityLabel(icon.key)
        .accessibilityAddTraits(isChosen ? .isSelected : [])
    }
}

/// A matter's icon at the head of its page's meta line: 16, `muted`, a control whose 44 hit area takes no room.
struct MetaIconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 16)).foregroundStyle(Palette.muted)
                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding((16 - Metrics.tapTarget) / 2)
        .accessibilityLabel(label)
    }
}
