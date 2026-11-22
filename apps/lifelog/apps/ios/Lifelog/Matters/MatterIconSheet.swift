import LifeConnector
import SwiftUI

/// A matter's icon, changed: the whole set in its groups, the icon shown chosen and who chose it. His tap wins, and
/// “Let Life pick” gives it back; either closes the sheet once Life's reads have it, said back on the page with Undo
/// (`LifeStore.setMatterIcon`). With no icon from Life (none picked, or a key this build lacks), nothing is chosen
/// and nothing claims a pick. While a pick of this matter is under way (his tap, his reset or an Undo), it shows
/// chosen and the grid waits.
struct MatterIconSheet: View {
    let matter: String

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let row = life.matter[matter]?.value?.row
        let picking = life.iconPicking(matter)
        let isRunning = picking != nil
        IconGrid(groups: MatterIcons.groups, chosen: picking ?? row?.knownIcon?.key) { key in
            if let row { choose(key, row: row) }
        }
        .disabled(isRunning).offWhileOutOfReach()
        .padding(.top, Metrics.Spacing.m).padding(.bottom, Metrics.Spacing.xl)
        .sheetScroll {
            VStack(alignment: .leading, spacing: 0) {
                SheetHeader(title: nil) { dismiss() }.frame(minHeight: Metrics.tapTarget)
                    .overlay(alignment: .leading) {
                        Text(row?.name ?? "").font(.sheetQuestion).foregroundStyle(Palette.fg).lineLimit(1)
                            .padding(.trailing, Metrics.tapTarget + Metrics.Spacing.s)
                    }
                if let row { attribution(row, isRunning: isRunning) }
            }
        }
        .background(Palette.sheet)
        .sheetStack()
        .presentationDetents([.large])
    }

    /// Who chose the icon shown: Life, or he (with the way back to Life's); a busy mark while a pick is under way.
    private func attribution(_ row: MatterRow, isRunning: Bool) -> some View {
        HStack {
            switch row.knownIcon?.by {
            case .owner?: Text("Your choice")
            case .life?: Text("Life picked this one")
            default: EmptyView()
            }
            Spacer(minLength: 0)
            if isRunning {
                Spinner(size: .small).foregroundStyle(Palette.muted)
            } else if row.knownIcon?.by == .owner {
                QuietChip("Let Life pick", symbol: "arrow.uturn.backward") { choose(nil, row: row) }
            }
        }
        .font(.small).foregroundStyle(Palette.muted)
        .motion(Motion.standard, value: isRunning)
    }

    /// Sends his pick (nil: Life picks again), keeping his pick before it for Undo; his own pick tapped again only
    /// closes the sheet.
    private func choose(_ key: String?, row: MatterRow) {
        let was = life.earlierIconPick(of: row)
        guard key != was else { return dismiss() }
        Task {
            await life.setMatterIcon(of: matter, key, was: was)
            if router.matterSheet == .icon(matter) { router.matterSheet = nil }
        }
    }
}
